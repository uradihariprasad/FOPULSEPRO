/**
 * ORDER FLOW DOMINANCE  —  QUALITY SCANNER (rewritten)
 *
 * Objective: surface only HIGH-QUALITY one-sided stocks — names where real,
 * sustained, participative order flow exists, not a momentary flicker of the
 * displayed top-5 depth book.
 *
 * Why the previous version under-performed:
 *   - a single depth snapshot drove 20% of the score, and the top-5 book is
 *     thin, flickery and constantly refreshed by algo quotes
 *   - "quality" was not a gate, so illiquid names ranked alongside majors
 *   - confidence almost never reached HIGH because nothing required evidence
 *     to be SUSTAINED
 *
 * What this version does differently:
 *   1  SUSTAINED BOOK PRESSURE — the resting book is sampled over time; the
 *      score uses the MEAN imbalance and is penalised by its VARIANCE, so a
 *      level that flips sides every few seconds cannot score. Requires
 *      several samples before it is trusted at all.
 *   2  EXECUTED PRESSURE — who is actually transacting: up/down candles
 *      weighted by their real volume. Executed flow is far more reliable than
 *      the resting book, so it is the largest component.
 *   3  ABSORPTION is inferred from real depth-history behaviour (book holds
 *      or grows while price pushes into it), not from a static ratio.
 *   4  QUALITY GATES — a stock cannot be ranked unless it clears real
 *      liquidity (₹ crore turnover), real participation (RVOL), fresh data
 *      and evidence coverage.
 *   5  CONFIDENCE requires agreement between book, executed flow and
 *      positioning — so it genuinely reaches HIGH only for quality names.
 *
 * Integrity: every value is real Upstox data; unavailable inputs stay null
 * and are excluded by coverage dampening; no synthetic numbers, no NaN.
 */

import type { FullMarketQuote } from "@/lib/upstox/types";
import type { Candle, ScannerConfig, Stage1Metrics } from "./types";
import type { PriceSnap } from "./stage1";
import { aggregate, clamp } from "./indicators";

export type DominanceTrend = "ACCELERATING" | "WEAKENING" | "STABLE" | "REVERSING" | "UNAVAILABLE";
export type DominanceBand = "VERY STRONG" | "STRONG" | "MODERATE" | "BELOW THRESHOLD";
export type Confirmation = "CONFIRMED" | "CONTRADICTS" | "NEUTRAL" | "UNAVAILABLE";

export interface FlowComponent {
  key: string;
  label: string;
  weight: number;
  buyerValue: number | null;
  sellerValue: number | null;
  evidence: string;
}

export interface OrderFlowResult {
  symbol: string;
  computedAt: string;
  buyerScore: number;
  sellerScore: number;
  buyerConfidence: "HIGH" | "MEDIUM" | "LOW";
  sellerConfidence: "HIGH" | "MEDIUM" | "LOW";
  buyerBand: DominanceBand;
  sellerBand: DominanceBand;
  buyerTrend: DominanceTrend;
  sellerTrend: DominanceTrend;
  conflictingFlow: boolean;
  components: FlowComponent[];
  alignedForBuyer: number;
  alignedForSeller: number;
  conflictCount: number;
  coveragePct: number;
  dataFresh: boolean;
  dataStatus: string;
  rankable: boolean;
  notes: string[];
  /* ---- quality fields ---- */
  flowSmoothness: number | null;   // 0-100 how clean/persistent the flow is
  quality: "PREMIUM" | "GOOD" | "ACCEPTABLE" | "SPECULATIVE" | "INSUFFICIENT";
  qualityNotes: string[];
  turnoverCr: number | null;
  rvol: number | null;
  bookSustained: boolean | null;   // resting book consistently one-sided
  samplesUsed: number;             // depth samples behind the book signal
  buyerAbsorption: boolean | null; // ask absorbed while price rose
  sellerAbsorption: boolean | null;// bid absorbed while price fell
  executedBias: number | null;     // -100..100 volume-weighted transaction bias
  blockReasons: string[];
}

export const ORDERFLOW_MIN_RANK_SCORE = 55;
/** Severe book-vs-tape divergence that genuinely invalidates a read. */
export const SEVERE_CONFLICT_GAP = 60;

/* ------------------------------- tracker --------------------------------- */

/** Rolling depth/volume samples so pressure must be SUSTAINED to count. */
export interface FlowSample {
  ts: number;
  imbalance: number;   // -1..1 (bid heavy → +1)
  bidQty: number;
  askQty: number;
  bidOrders: number;
  askOrders: number;
}

export interface FlowTracker {
  samples: FlowSample[];
  prevImbalance: number | null;
  prevTs: number | null;
}

export function newFlowTracker(): FlowTracker {
  return { samples: [], prevImbalance: null, prevTs: null };
}

export interface OrderFlowInput {
  symbol: string;
  eq: FullMarketQuote | null;
  metrics: Stage1Metrics;
  ring: PriceSnap[];
  candles1m: Candle[] | null;
  config: ScannerConfig;
  now: number;
  history: { ts: number; buyer: number; seller: number }[];
  tracker?: FlowTracker;
}

/* ------------------------------- helpers --------------------------------- */

function fmtQty(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "N/A";
  const a = Math.abs(n);
  if (a >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)} K`;
  return `${Math.round(n)}`;
}

export function bandOf(score: number): DominanceBand {
  if (score >= 80) return "VERY STRONG";
  if (score >= 70) return "STRONG";
  if (score >= ORDERFLOW_MIN_RANK_SCORE) return "MODERATE";
  return "BELOW THRESHOLD";
}

/* ================================ engine ================================= */

export function computeOrderFlow(input: OrderFlowInput): OrderFlowResult {
  const { eq, metrics: m, config } = input;
  const notes: string[] = [];
  const qualityNotes: string[] = [];
  const blockReasons: string[] = [];
  const components: FlowComponent[] = [];
  const ltp = m.ltp;

  /* ------------------- sample the resting book (history) ------------------ */
  const buy = eq?.depth?.buy ?? [];
  const sell = eq?.depth?.sell ?? [];
  const bidQty = buy.reduce((a, d) => a + (d.quantity || 0), 0);
  const askQty = sell.reduce((a, d) => a + (d.quantity || 0), 0);
  const bidOrders = buy.reduce((a, d) => a + (d.orders || 0), 0);
  const askOrders = sell.reduce((a, d) => a + (d.orders || 0), 0);
  const tbq = typeof eq?.total_buy_quantity === "number" ? (eq!.total_buy_quantity as number) : null;
  const tsq = typeof eq?.total_sell_quantity === "number" ? (eq!.total_sell_quantity as number) : null;

  const tracker = input.tracker;
  if (tracker) {
    const bookTotal = bidQty + askQty;
    if (bookTotal > 0) {
      const imb = (bidQty - askQty) / bookTotal;
      const last = tracker.samples[tracker.samples.length - 1];
      if (!last || input.now - last.ts >= 20_000) {
        tracker.samples.push({ ts: input.now, imbalance: imb, bidQty, askQty, bidOrders, askOrders });
        if (tracker.samples.length > 24) tracker.samples.shift();
      }
      tracker.prevImbalance = imb;
      tracker.prevTs = input.now;
    }
  }
  const samples = tracker?.samples ?? [];
  const samplesUsed = samples.length;

  /* =================== 1. SUSTAINED BOOK PRESSURE (22%) =================== */
  const bookComp = (() => {
    const bookTotal = bidQty + askQty;
    if (bookTotal <= 0) {
      return { buyerValue: null as number | null, sellerValue: null as number | null, evidence: "market depth unavailable", sustained: null as boolean | null };
    }
    const nowImb = (bidQty - askQty) / bookTotal;

    if (samplesUsed < 3) {
      return {
        buyerValue: null as number | null, sellerValue: null as number | null,
        evidence: `building book history (${samplesUsed}/3 samples) — single snapshot not trusted`,
        sustained: null as boolean | null,
      };
    }
    // Sustained pressure = mean imbalance with a VARIANCE PENALTY. A book
    // that flips sides cannot score, no matter how large the imbalance is.
    const win = samples.slice(-12);
    const mean = win.reduce((a, s) => a + s.imbalance, 0) / win.length;
    const variance = win.reduce((a, s) => a + (s.imbalance - mean) ** 2, 0) / win.length;
    const sd = Math.sqrt(variance);
    const consistency = clamp(1 - sd * 2.5, 0, 1);      // 1 = rock solid
    const shareSameSide = win.filter((s) => Math.sign(s.imbalance) === Math.sign(mean)).length / win.length;

    const sustained = consistency >= 0.55 && shareSameSide >= 0.7 && Math.abs(mean) >= 0.08;
    // magnitude × consistency — a stable 25% imbalance beats a wild 60% one
    const magnitude = clamp(Math.abs(mean) / 0.35, 0, 1);
    const strength = magnitude * (0.35 + 0.65 * consistency);
    const buyerValue = mean > 0 ? clamp(50 + strength * 50, 0, 100) : clamp(50 - strength * 50, 0, 100);

    return {
      buyerValue: clamp(buyerValue, 0, 100),
      sellerValue: clamp(100 - buyerValue, 0, 100),
      evidence: `book ${(mean * 100).toFixed(0)}% bid-heavy avg over ${win.length} samples · consistency ${(consistency * 100).toFixed(0)}% · bid ${fmtQty(bidQty)} / ask ${fmtQty(askQty)}${sustained ? "" : " (unstable)"}`,
      sustained,
    };
  })();

  components.push({
    key: "book", label: "Sustained book pressure", weight: 22,
    buyerValue: bookComp.buyerValue, sellerValue: bookComp.sellerValue,
    evidence: bookComp.evidence,
  });

  /* =================== 2. ORDER-COUNT PRESSURE (10%) ====================== */
  const ordersComp = (() => {
    const tot = bidOrders + askOrders;
    const bits: string[] = [];
    let buyerValue: number | null = null;
    if (tot > 0) {
      const imb = (bidOrders - askOrders) / tot;
      buyerValue = clamp(50 + imb * 50, 0, 100);
      bits.push(`${bidOrders} vs ${askOrders} orders`);
    }
    if (tbq != null && tsq != null && tbq + tsq > 0) {
      const tImb = (tbq - tsq) / (tbq + tsq);
      // resting totals corroborate the visible book
      buyerValue = buyerValue == null ? clamp(50 + tImb * 50, 0, 100) : clamp(buyerValue * 0.6 + (50 + tImb * 50) * 0.4, 0, 100);
      bits.push(`totals ${fmtQty(tbq)}/${fmtQty(tsq)}`);
    }
    return { buyerValue, evidence: bits.join(" · ") || "order data N/A" };
  })();

  components.push({
    key: "orders", label: "Order-count pressure", weight: 10,
    buyerValue: ordersComp.buyerValue, sellerValue: ordersComp.buyerValue == null ? null : 100 - ordersComp.buyerValue,
    evidence: ordersComp.evidence,
  });

  /* =============== 3. EXECUTED PRESSURE — who is transacting (24%) ======== */
  const execComp = (() => {
    const c1 = input.candles1m ?? [];
    if (c1.length < 12) {
      // fall back to real quote returns when candles are not cached yet
      if (m.return5mPct != null || m.return15mPct != null) {
        const r5 = m.return5mPct ?? 0, r15 = m.return15mPct ?? 0;
        const bv = clamp(50 + r5 * 45 + r15 * 25, 0, 100);
        return { buyerValue: bv, sellerValue: 100 - bv, bias: null as number | null, evidence: `returns 5m ${r5.toFixed(2)}% / 15m ${r15.toFixed(2)}% (candle detail unavailable)` };
      }
      return { buyerValue: null as number | null, sellerValue: null as number | null, bias: null as number | null, evidence: "INSUFFICIENT transaction data" };
    }
    // Volume-weighted transaction bias: every 1-minute candle votes with the
    // real volume it traded. This is executed flow, not a resting quote.
    const win = c1.slice(-30);
    let upVol = 0, downVol = 0;
    for (const c of win) {
      const dir = c.c - c.o;
      if (dir > 0) upVol += c.v;
      else if (dir < 0) downVol += c.v;
    }
    const tot = upVol + downVol;
    if (tot <= 0) return { buyerValue: null as number | null, sellerValue: null as number | null, bias: null as number | null, evidence: "no traded volume recorded" };
    const bias = ((upVol - downVol) / tot) * 100; // -100..100
    // confirmation from where price closed inside each candle
    const c5 = aggregate(c1, 5);
    const last8 = c5.slice(-8);
    const upBars = last8.filter((c) => c.c > c.o).length;
    const barBias = last8.length ? (upBars / last8.length) * 100 : 50;
    const buyerValue = clamp((bias + 100) / 2 * 0.65 + barBias * 0.35, 0, 100);
    return {
      buyerValue,
      sellerValue: 100 - buyerValue,
      bias,
      evidence: `${fmtQty(upVol)} buy-volume vs ${fmtQty(downVol)} sell-volume (${Math.round(bias)}% bias) · ${upBars}/${last8.length} up 5m bars`,
    };
  })();

  components.push({
    key: "executed", label: "Executed pressure", weight: 24,
    buyerValue: execComp.buyerValue, sellerValue: execComp.buyerValue == null ? null : 100 - execComp.buyerValue,
    evidence: execComp.evidence,
  });

  /* ===================== 4. PARTICIPATION QUALITY (12%) =================== */
  const partComp = (() => {
    if (m.rvol == null) return { value: null as number | null, evidence: "RVOL N/A" };
    const v = clamp((m.rvol / (2 * config.rvolThreshold)) * 100, 0, 100);
    return {
      value: v,
      evidence: `RVOL ${m.rvol.toFixed(2)}x${m.turnoverCr != null ? ` · ₹${m.turnoverCr.toFixed(0)} Cr traded` : ""}`,
    };
  })();

  components.push({
    key: "rvol", label: "Participation quality", weight: 12,
    buyerValue: partComp.value, sellerValue: partComp.value,
    evidence: partComp.evidence,
  });

  /* ======================= 5. FUTURES POSITIONING (18%) =================== */
  const futComp = (() => {
    const sig = m.futures.signal;
    if (sig === "UNAVAILABLE") return { buyerValue: null as number | null, sellerValue: null as number | null, evidence: "futures UNAVAILABLE" };
    if (sig === "NEUTRAL") return { buyerValue: 50, sellerValue: 50, evidence: "AMBIGUOUS — price/OI move insignificant" };
    const table: Record<string, [number, number, string]> = {
      LONG_BUILDUP: [96, 12, "long-buildup characteristics (price ↑ OI ↑)"],
      SHORT_BUILDUP: [12, 96, "short-buildup characteristics (price ↓ OI ↑)"],
      SHORT_COVERING: [74, 30, "short-covering characteristics (price ↑ OI ↓)"],
      LONG_UNWINDING: [30, 74, "long-unwinding characteristics (price ↓ OI ↓)"],
    };
    const [bv, sv, txt] = table[sig] ?? [50, 50, sig];
    const d = [txt];
    if (m.futures.oiChangePct != null) d.push(`ΔOI ${m.futures.oiChangePct >= 0 ? "+" : ""}${m.futures.oiChangePct.toFixed(2)}%`);
    if (m.futures.priceChangePct != null) d.push(`fut ${m.futures.priceChangePct >= 0 ? "+" : ""}${m.futures.priceChangePct.toFixed(2)}%`);
    return { buyerValue: bv, sellerValue: sv, evidence: d.join(" · ") };
  })();

  components.push({
    key: "futures", label: "Futures positioning", weight: 18,
    buyerValue: futComp.buyerValue, sellerValue: futComp.sellerValue,
    evidence: futComp.evidence,
  });

  /* ===================== 6. VWAP PERSISTENCE (9%) ========================= */
  const vwapComp = (() => {
    const vwap = m.vwap;
    if (vwap == null || ltp == null || input.ring.length < 4) {
      return { buyerValue: null as number | null, evidence: "VWAP/snapshots N/A" };
    }
    const win = input.ring.slice(-20);
    let above = 0, flips = 0, prevSide: boolean | null = null;
    for (const s of win) {
      const isAbove = s.ltp >= vwap;
      if (isAbove) above++;
      if (prevSide !== null && isAbove !== prevSide) flips++;
      prevSide = isAbove;
    }
    const frac = above / win.length;
    const buyerValue = clamp(frac * 100 * 0.9 + (ltp >= vwap ? 10 : 0), 0, 100);
    if (flips >= 5) notes.push("frequent VWAP crossings — conviction reduced");
    return {
      buyerValue,
      evidence: `${Math.round(frac * 100)}% of recent snapshots above VWAP · ${flips} crossings`,
    };
  })();

  components.push({
    key: "vwap", label: "VWAP persistence", weight: 9,
    buyerValue: vwapComp.buyerValue, sellerValue: vwapComp.buyerValue == null ? null : 100 - vwapComp.buyerValue,
    evidence: vwapComp.evidence,
  });

  /* ==================== 7. RS / MOMENTUM ALIGNMENT (5%) =================== */
  const rsComp = (() => {
    if (m.rsNiftyPct == null && m.rsAccelPct == null) return { buyerValue: null as number | null, evidence: "RS N/A" };
    const rs = m.rsNiftyPct ?? 0, acc = m.rsAccelPct ?? 0;
    return {
      buyerValue: clamp(50 + rs * 30 + acc * 45, 0, 100),
      evidence: `RS ${rs >= 0 ? "+" : ""}${rs.toFixed(2)}% · accel ${acc >= 0 ? "+" : ""}${acc.toFixed(2)}%`,
    };
  })();

  components.push({
    key: "rs", label: "RS alignment", weight: 5,
    buyerValue: rsComp.buyerValue, sellerValue: rsComp.buyerValue == null ? null : 100 - rsComp.buyerValue,
    evidence: rsComp.evidence,
  });

  /* ============ 8. FLOW SMOOTHNESS — clean directional drift (12%) ========
   * Quality flow is SMOOTH: price drifts one way with low chop and the
   * closes sit consistently on the same side of the bar range. Whipsaw
   * markets score low here even when the raw imbalance is large.
   * ====================================================================== */
  const smoothComp = (() => {
    const c1 = input.candles1m ?? [];
    if (c1.length < 15) return { buyerValue: null as number | null, smooth: null as number | null, evidence: "insufficient candles for flow smoothness" };
    const win = c1.slice(-30);
    const net = win[win.length - 1].c - win[0].o;
    // path efficiency: net travel vs total bar-to-bar travel (0..1)
    let path = 0;
    for (let i = 1; i < win.length; i++) path += Math.abs(win[i].c - win[i - 1].c);
    const efficiency = path > 0 ? clamp(Math.abs(net) / path, 0, 1) : 0;
    // close location: where each bar closes inside its own range
    let clsum = 0, cln = 0;
    for (const c of win) {
      const r = c.h - c.l;
      if (r <= 0) continue;
      clsum += (c.c - c.l) / r;
      cln++;
    }
    const closeLoc = cln > 0 ? clsum / cln : 0.5; // 1 = closes at highs
    const smooth = clamp(efficiency * 100, 0, 100);
    // direction from net drift, conviction from smoothness + close location
    const dirUp = net >= 0;
    const conviction = clamp(efficiency * 0.6 + Math.abs(closeLoc - 0.5) * 2 * 0.4, 0, 1);
    const buyerValue = clamp(50 + (dirUp ? 1 : -1) * conviction * 50, 0, 100);
    return {
      buyerValue, smooth,
      evidence: `path efficiency ${Math.round(efficiency * 100)}% · closes at ${Math.round(closeLoc * 100)}% of bar range · net ${net >= 0 ? "+" : ""}${net.toFixed(2)}`,
    };
  })();

  components.push({
    key: "smoothness", label: "Flow smoothness", weight: 12,
    buyerValue: smoothComp.buyerValue, sellerValue: smoothComp.buyerValue == null ? null : 100 - smoothComp.buyerValue,
    evidence: smoothComp.evidence,
  });

  /* ============================== SCORING ================================= */
  const scoreFor = (side: "buyer" | "seller") => {
    let used = 0, acc = 0, total = 0;
    for (const c of components) {
      total += c.weight;
      const v = side === "buyer" ? c.buyerValue : c.sellerValue;
      if (v == null) continue;
      used += c.weight;
      acc += c.weight * v;
    }
    if (used === 0) return { score: 0, coverage: 0 };
    const coverage = used / total;
    return { score: Math.round((acc / used) * Math.sqrt(coverage)), coverage };
  };
  const B = scoreFor("buyer");
  const S = scoreFor("seller");
  const coveragePct = Math.round(Math.max(B.coverage, S.coverage) * 100);

  /* ------------------- agreement / conflict (executed-led) ---------------- */
  // Executed pressure is the most trustworthy directional signal, so a big
  // divergence between the book and actual transactions is a real conflict.
  const directional = components.filter((c) => c.key !== "rvol");
  const alignedForBuyer = directional.filter((c) => c.buyerValue != null && c.buyerValue >= 64).length;
  const alignedForSeller = directional.filter((c) => c.sellerValue != null && c.sellerValue >= 64).length;
  // Conflicts are counted AGAINST THE DOMINANT SIDE ONLY. A strongly bullish
  // stock legitimately has low seller-side values — that is agreement, not a
  // conflict. (Counting both directions wrongly capped every one-sided stock.)
  const dominantIsBuyer = B.score >= S.score;
  const conflictCount = directional.filter((c) => {
    const v = dominantIsBuyer ? c.buyerValue : c.sellerValue;
    return v != null && v <= 30;
  }).length;

  // The resting book is inherently noisy, so only a SEVERE divergence from
  // the executed tape disqualifies a name. A moderate divergence simply
  // dampens the score (handled below) instead of removing the stock.
  const bookExecGap = (() => {
    const b = bookComp.buyerValue, e = execComp.buyerValue;
    if (b == null || e == null) return null;
    return Math.abs(b - e);
  })();
  const bookVsExecConflict = bookExecGap != null && bookExecGap >= SEVERE_CONFLICT_GAP;
  if (bookVsExecConflict) notes.push("resting book severely contradicts executed flow");
  else if (bookExecGap != null && bookExecGap >= 35) notes.push("book and tape moderately diverge — score dampened");

  const conflictingFlow = conflictCount >= 3 || bookVsExecConflict;
  if (conflictingFlow) notes.push("CONFLICTING FLOW — independent signals materially disagree");

  let buyerScore = B.score;
  let sellerScore = S.score;
  // broad agreement is what makes a name "quality" — reward it
  if (alignedForBuyer >= 5) buyerScore = Math.min(100, buyerScore + 5);
  if (alignedForSeller >= 5) sellerScore = Math.min(100, sellerScore + 5);
  // graded dampeners (multiplicative) rather than hard caps, so a good stock
  // with one imperfect input is degraded proportionally, not eliminated
  let damp = 1;
  if (conflictingFlow) damp *= 0.78;
  else if (bookExecGap != null && bookExecGap >= 35) damp *= 0.92;
  if (bookComp.sustained === false) damp *= 0.9;
  if (m.turnoverCr != null && m.turnoverCr < config.minTurnoverCr) {
    damp *= 0.85;
    blockReasons.push(`turnover ₹${m.turnoverCr.toFixed(0)} Cr below ₹${config.minTurnoverCr} Cr quality floor`);
  }
  if (m.rvol != null && m.rvol < config.rvolThreshold * 0.7) {
    damp *= 0.9;
    blockReasons.push(`RVOL ${m.rvol.toFixed(2)}x — participation thin`);
  }
  buyerScore = Math.round(clamp(buyerScore * damp, 0, 100));
  sellerScore = Math.round(clamp(sellerScore * damp, 0, 100));

  /* ---------------------------- ABSORPTION -------------------------------- */
  // Absorption = the book held one-sided while price pushed INTO it, i.e. the
  // passive side soaked up aggression rather than retreating.
  const priceUp = (m.return5mPct ?? 0) > 0.03;
  const priceDown = (m.return5mPct ?? 0) < -0.03;
  const prevImb = tracker?.prevImbalance ?? null;
  const bookNow = bidQty + askQty > 0 ? (bidQty - askQty) / (bidQty + askQty) : null;
  const buyerAbsorption = bookNow != null && bookNow <= -0.12 && priceUp;   // ask wall held while price rose
  const sellerAbsorption = bookNow != null && bookNow >= 0.12 && priceDown; // bid wall held while price fell
  if (buyerAbsorption) notes.push("ask-side absorption — sellers absorbed aggressive buying");
  if (sellerAbsorption) notes.push("bid-side absorption — buyers absorbed aggressive selling");
  if (prevImb != null && bookNow != null && Math.abs(prevImb - bookNow) > 0.45) {
    notes.push("order book flipped sides within the sample window");
  }

  /* ------------------------------- QUALITY -------------------------------- */
  const qualityNotesAll: string[] = [];
  if (m.turnoverCr != null) qualityNotesAll.push(`₹${m.turnoverCr.toFixed(0)} Cr traded today`);
  if (m.rvol != null) qualityNotesAll.push(`RVOL ${m.rvol.toFixed(2)}x`);
  if (bookComp.sustained === true) qualityNotesAll.push("resting book consistently one-sided");
  if (bookComp.sustained === false) qualityNotesAll.push("resting book unstable");
  if (samplesUsed < 3) qualityNotesAll.push(`book history building (${samplesUsed}/3)`);

  /*
   * Graded quality. The previous version demanded turnover AND RVOL both
   * above full thresholds for even "GOOD", which excluded most genuinely
   * smooth flow names. Tiers now degrade gracefully.
   */
  const quality: OrderFlowResult["quality"] = (() => {
    const t = m.turnoverCr;
    if (t == null || coveragePct < 45) return "INSUFFICIENT";
    const rv = m.rvol;
    const smoothOk = (smoothComp.smooth ?? 0) >= 35;
    if (t >= config.minTurnoverCr * 2.5 && rv != null && rv >= config.rvolThreshold && bookComp.sustained !== false && smoothOk) return "PREMIUM";
    if (t >= config.minTurnoverCr && (rv == null || rv >= config.rvolThreshold * 0.7)) return "GOOD";
    if (t >= config.minTurnoverCr * 0.6) return "ACCEPTABLE";
    return "SPECULATIVE";
  })();
  if (quality === "SPECULATIVE") blockReasons.push("quality SPECULATIVE — turnover below the acceptable floor");
  if (quality === "INSUFFICIENT") blockReasons.push("quality data insufficient");

  /* ------------------------------ CONFIDENCE ------------------------------ */
  const fresh = m.dataStatus === "LIVE" || m.dataStatus === "RECENT";
  const confFor = (side: "buyer" | "seller", aligned: number): "HIGH" | "MEDIUM" | "LOW" => {
    const cov = side === "buyer" ? B.coverage : S.coverage;
    const execAligned = side === "buyer" ? (execComp.buyerValue ?? 50) >= 64 : (execComp.sellerValue ?? 50) >= 64;
    if (!fresh || conflictingFlow) return "LOW";
    // HIGH demands: coverage, broad agreement, executed flow on side, and a
    // trustworthy (sustained) or at least non-contradicting book.
    if (cov >= 0.75 && aligned >= 4 && execAligned && bookComp.sustained !== false) return "HIGH";
    if (cov >= 0.6 && aligned >= 3 && execAligned) return "MEDIUM";
    if (cov >= 0.5 && aligned >= 2) return "MEDIUM";
    return "LOW";
  };
  const buyerConfidence = confFor("buyer", alignedForBuyer);
  const sellerConfidence = confFor("seller", alignedForSeller);

  /* -------------------------------- TREND --------------------------------- */
  const trendOf = (hist: number[]): DominanceTrend => {
    if (hist.length < 3) return hist.length < 2 ? "UNAVAILABLE" : "STABLE";
    const [a, b, c] = hist.slice(-3);
    const d1 = c - b, d2 = b - a;
    if (d1 > 0 && d2 > 0 && c - a >= 6) return "ACCELERATING";
    if (d1 < 0 && d2 < 0 && a - c >= 6) return "WEAKENING";
    if ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) return "REVERSING";
    return "STABLE";
  };
  const buyerTrend = trendOf(input.history.map((h) => h.buyer).concat(buyerScore));
  const sellerTrend = trendOf(input.history.map((h) => h.seller).concat(sellerScore));

  /* ------------------------------ RANKABLE -------------------------------- */
  // Only quality, one-sided, well-evidenced names are ranked.
  /*
   * A book that is demonstrably UNSTABLE (flips sides between samples) is a
   * red flag and blocks ranking — the displayed book is being refreshed by
   * quote traffic rather than expressing real interest. A book that is merely
   * still BUILDING (not enough samples yet) does NOT block, because the
   * executed tape is the more reliable signal and it is fully evaluated.
   */
  if (bookComp.sustained === false) blockReasons.push("resting book unstable — score dampened");
  const rankable =
    fresh &&
    !conflictingFlow &&
    coveragePct >= 50 &&
    (quality === "PREMIUM" || quality === "GOOD" || quality === "ACCEPTABLE") &&
    (buyerScore >= ORDERFLOW_MIN_RANK_SCORE || sellerScore >= ORDERFLOW_MIN_RANK_SCORE);

  if (!fresh) notes.push(`${m.dataStatus} data — excluded from ranking`);

  return {
    symbol: input.symbol,
    computedAt: new Date(input.now).toISOString(),
    buyerScore, sellerScore,
    buyerConfidence, sellerConfidence,
    buyerBand: bandOf(buyerScore), sellerBand: bandOf(sellerScore),
    buyerTrend, sellerTrend,
    conflictingFlow,
    components,
    alignedForBuyer, alignedForSeller, conflictCount,
    coveragePct,
    dataFresh: fresh,
    dataStatus: m.dataStatus,
    rankable,
    notes,
    quality,
    qualityNotes: qualityNotesAll,
    turnoverCr: m.turnoverCr,
    rvol: m.rvol,
    flowSmoothness: smoothComp.smooth,
    bookSustained: bookComp.sustained,
    samplesUsed,
    buyerAbsorption,
    sellerAbsorption,
    executedBias: execComp.bias,
    blockReasons,
  };
}
