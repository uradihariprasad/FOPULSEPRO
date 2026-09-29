/**
 * INTRADAY MOMENTUM CONVICTION ENGINE  (additive module)
 *
 * Produces the TOP LONG (buying) and TOP SHORT (selling) intraday momentum
 * candidates by FUSING every independent evidence stream the app already
 * computes from real Upstox data:
 *
 *   price action      — day/5m/15m returns, acceleration, range position,
 *                       candle bias, 5-minute trend, VWAP relationship
 *   order positioning — live depth imbalance, order counts, total buy/sell
 *                       quantities (via the Order Flow Dominance module)
 *   volume            — time-of-day adjusted RVOL + traded turnover
 *   option chain      — ATM-window CE/PE OI, OI change, writing vs unwinding,
 *                       PCR context
 *   futures           — price + OI positioning characteristics
 *   relative strength — RS vs NIFTY and RS acceleration
 *   location          — dynamic S/R room-to-move and break risk
 *
 * Integrity rules: no synthetic values, missing inputs stay null (N/A) and are
 * excluded via coverage dampening, stale symbols are never ranked, and
 * materially contradicting evidence caps the score (CONFLICTED).
 *
 * Read-only w.r.t. Stage 1 / Stage 2 / Top-10 / Order Flow / Dynamic S/R.
 */

import type { Candle, Stage1Metrics } from "./types";
import type { OptionChainStrike } from "@/lib/upstox/types";
import type { OrderFlowResult } from "./orderflow";
import type { DynamicSRResult } from "./dynamic-sr";
import { aggregate, clamp } from "./indicators";

export type ConvictionSide = "LONG" | "SHORT";
export type ConvictionGrade = "VERY HIGH" | "HIGH" | "MODERATE" | "BELOW THRESHOLD";

export interface ConvictionFactor {
  key: string;
  label: string;
  weight: number;
  value: number | null; // 0-100 in favour of the evaluated side
  evidence: string; // real figures only
}

export interface ConvictionResult {
  symbol: string;
  computedAt: string;
  side: ConvictionSide | null; // dominant side, null when neither qualifies
  longScore: number;
  shortScore: number;
  grade: ConvictionGrade;
  conviction: "STRONG" | "BUILDING" | "WEAK" | "CONFLICTED";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  ltp: number | null;
  changePct: number | null;
  rvol: number | null;
  turnoverCr: number | null;
  longFactors: ConvictionFactor[];
  shortFactors: ConvictionFactor[];
  agreeCount: number;
  conflictCount: number;
  coveragePct: number;
  dataStatus: string;
  rankable: boolean;
  optionBias: string;
  futuresBias: string;
  flowBias: string;
  locationNote: string;
  headline: string;
  drivers: string[];
  risks: string[];
}

export const CONVICTION_MIN_SCORE = 62;

export interface ConvictionWeights {
  priceAction: number;
  orderPositioning: number;
  volume: number;
  optionChain: number;
  futures: number;
  relativeStrength: number;
  location: number;
}

/** Internally configurable composite weighting. */
export const DEFAULT_CONVICTION_WEIGHTS: ConvictionWeights = {
  priceAction: 22,
  orderPositioning: 18,
  volume: 15,
  optionChain: 15,
  futures: 12,
  relativeStrength: 13,
  location: 5,
};

export interface ConvictionInput {
  symbol: string;
  metrics: Stage1Metrics;
  orderFlow: OrderFlowResult | null;
  dynamicSR: DynamicSRResult | null;
  optionChain: OptionChainStrike[] | null;
  candles1m: Candle[] | null;
  now: number;
  weights?: ConvictionWeights;
}

/* ----------------------------- option analysis ---------------------------- */

interface OptionBias {
  bullish: number | null; // 0-100
  note: string;
  pcr: number | null;
}

function analyzeOptionBias(chain: OptionChainStrike[] | null, spot: number | null): OptionBias {
  if (!chain || chain.length === 0 || spot == null || spot <= 0) {
    return { bullish: null, note: "option chain UNAVAILABLE", pcr: null };
  }
  const rows = chain.filter(
    (s) => s.strike_price != null && Math.abs(s.strike_price - spot) / spot <= 0.05,
  );
  if (!rows.length) return { bullish: null, note: "no strikes near price", pcr: null };

  let ceOi = 0, peOi = 0, ceChg = 0, peChg = 0;
  let ceChgKnown = false, peChgKnown = false;
  for (const r of rows) {
    const ce = r.call_options?.market_data;
    const pe = r.put_options?.market_data;
    if (ce?.oi != null) ceOi += ce.oi;
    if (pe?.oi != null) peOi += pe.oi;
    if (ce?.oi != null && ce.prev_oi != null) { ceChg += ce.oi - ce.prev_oi; ceChgKnown = true; }
    if (pe?.oi != null && pe.prev_oi != null) { peChg += pe.oi - pe.prev_oi; peChgKnown = true; }
  }
  if (ceOi <= 0 && peOi <= 0) return { bullish: null, note: "no OI reported", pcr: null };

  const pcr = ceOi > 0 ? peOi / ceOi : null;
  let score = 50;
  const notes: string[] = [];

  // PCR context (OI based, ATM window)
  if (pcr != null) {
    score += clamp((pcr - 1) * 22, -18, 18);
    notes.push(`PCR ${pcr.toFixed(2)}`);
  }
  // OI change: fresh PE writing = support building (bullish);
  // fresh CE writing = supply building (bearish); unwinding reverses.
  if (ceChgKnown || peChgKnown) {
    const base = Math.max(ceOi, peOi, 1);
    const peEff = peChg / base;
    const ceEff = ceChg / base;
    score += clamp(peEff * 220, -22, 22);
    score -= clamp(ceEff * 220, -22, 22);
    const parts: string[] = [];
    if (peChgKnown) parts.push(`PE OI ${peChg >= 0 ? "+" : ""}${(peChg / 1000).toFixed(0)}K${peChg > 0 ? " (writing)" : peChg < 0 ? " (unwinding)" : ""}`);
    if (ceChgKnown) parts.push(`CE OI ${ceChg >= 0 ? "+" : ""}${(ceChg / 1000).toFixed(0)}K${ceChg > 0 ? " (writing)" : ceChg < 0 ? " (unwinding)" : ""}`);
    notes.push(parts.join(", "));
  }
  return { bullish: clamp(score, 0, 100), note: notes.join(" · ") || "OI present", pcr };
}

/* -------------------------------- engine ---------------------------------- */

export function computeConviction(input: ConvictionInput): ConvictionResult {
  const W = input.weights ?? DEFAULT_CONVICTION_WEIGHTS;
  const m = input.metrics;
  const ltp = m.ltp;
  const of = input.orderFlow;
  const sr = input.dynamicSR;

  const optBias = analyzeOptionBias(input.optionChain, ltp);

  /* --------------------------- price action (22) --------------------------- */
  const priceAction = (() => {
    const bits: string[] = [];
    let sum = 0, wsum = 0;
    if (m.returnDayPct != null) {
      sum += clamp(50 + m.returnDayPct * 16, 0, 100) * 0.26; wsum += 0.26;
      bits.push(`day ${m.returnDayPct >= 0 ? "+" : ""}${m.returnDayPct.toFixed(2)}%`);
    }
    if (m.return5mPct != null || m.return15mPct != null) {
      const r5 = m.return5mPct ?? 0, r15 = m.return15mPct ?? 0;
      sum += clamp(50 + r5 * 42 + r15 * 25, 0, 100) * 0.24; wsum += 0.24;
      bits.push(`5m ${r5 >= 0 ? "+" : ""}${r5.toFixed(2)}% 15m ${r15 >= 0 ? "+" : ""}${r15.toFixed(2)}%`);
    }
    if (m.priceAccel != null) {
      sum += clamp(50 + m.priceAccel * 55, 0, 100) * 0.12; wsum += 0.12;
    }
    if (m.trend5m !== "INSUFFICIENT_DATA") {
      const t = m.trend5m === "BULLISH" ? 92 : m.trend5m === "BEARISH" ? 8 : 48;
      sum += t * 0.2; wsum += 0.2;
      bits.push(`5m ${m.trend5m.toLowerCase()}`);
    }
    if (m.aboveVwap != null) {
      sum += (m.aboveVwap ? 84 : 16) * 0.1; wsum += 0.1;
      bits.push(m.aboveVwap ? "above VWAP" : "below VWAP");
    }
    if (m.dayHigh != null && m.dayLow != null && ltp != null && m.dayHigh > m.dayLow) {
      const pos = ((ltp - m.dayLow) / (m.dayHigh - m.dayLow)) * 100;
      sum += clamp(pos, 0, 100) * 0.08; wsum += 0.08;
      bits.push(`range ${Math.round(pos)}%`);
    }
    const c5 = input.candles1m ? aggregate(input.candles1m, 5) : [];
    if (c5.length >= 6) {
      const last6 = c5.slice(-6);
      const ups = last6.filter((c) => c.c > c.o).length;
      sum += (ups / last6.length) * 100 * 0.1; wsum += 0.1;
      bits.push(`${ups}/6 up 5m bars`);
    }
    return wsum >= 0.5
      ? { value: clamp(sum / wsum, 0, 100), evidence: bits.join(" · ") }
      : { value: null, evidence: "INSUFFICIENT price data" };
  })();

  /* ------------------------ order positioning (18) ------------------------- */
  const orderPos = (() => {
    if (!of) return { value: null, evidence: "order-book data N/A" };
    const depth = of.components.find((c) => c.key === "depth");
    const orders = of.components.find((c) => c.key === "orders");
    if (depth?.buyerValue == null && orders?.buyerValue == null) {
      return { value: null, evidence: "depth/orders N/A" };
    }
    // buyer-dominance score already blends depth, orders and totals
    const v = clamp(of.buyerScore * 0.55 + (depth?.buyerValue ?? 50) * 0.3 + (orders?.buyerValue ?? 50) * 0.15, 0, 100);
    const ev = [depth?.evidence, orders?.evidence].filter(Boolean).join(" · ");
    return { value: v, evidence: ev || "order-book measured" };
  })();

  /* ------------------------------ volume (15) ------------------------------ */
  const volume = (() => {
    if (m.rvol == null) return { value: null, evidence: "RVOL N/A" };
    const v = clamp((m.rvol / 3) * 100, 0, 100);
    const ev = `RVOL ${m.rvol.toFixed(2)}x${m.turnoverCr != null ? ` · ₹${m.turnoverCr.toFixed(0)} Cr turnover` : ""}`;
    return { value: v, evidence: ev };
  })();

  /* --------------------------- option chain (15) --------------------------- */
  const options = { value: optBias.bullish, evidence: optBias.note };

  /* ------------------------------ futures (12) ----------------------------- */
  const futures = (() => {
    const s = m.futures.signal;
    if (s === "UNAVAILABLE") return { value: null, evidence: "futures UNAVAILABLE" };
    if (s === "NEUTRAL") return { value: 50, evidence: "futures positioning ambiguous" };
    const map: Record<string, number> = {
      LONG_BUILDUP: 94, SHORT_COVERING: 72, LONG_UNWINDING: 28, SHORT_BUILDUP: 6,
    };
    const parts = [`${s.replaceAll("_", " ").toLowerCase()} characteristics`];
    if (m.futures.oiChangePct != null) parts.push(`ΔOI ${m.futures.oiChangePct >= 0 ? "+" : ""}${m.futures.oiChangePct.toFixed(2)}%`);
    return { value: map[s] ?? 50, evidence: parts.join(" · ") };
  })();

  /* ------------------------ relative strength (13) ------------------------- */
  const rs = (() => {
    if (m.rsNiftyPct == null && m.rsAccelPct == null) return { value: null, evidence: "RS N/A" };
    let sum = 0, wsum = 0;
    const bits: string[] = [];
    if (m.rsNiftyPct != null) {
      sum += clamp(50 + m.rsNiftyPct * 32, 0, 100) * 0.65; wsum += 0.65;
      bits.push(`RS ${m.rsNiftyPct >= 0 ? "+" : ""}${m.rsNiftyPct.toFixed(2)}%`);
    }
    if (m.rsAccelPct != null) {
      sum += clamp(50 + m.rsAccelPct * 55, 0, 100) * 0.35; wsum += 0.35;
      bits.push(`accel ${m.rsAccelPct >= 0 ? "+" : ""}${m.rsAccelPct.toFixed(2)}%`);
    }
    return { value: clamp(sum / wsum, 0, 100), evidence: bits.join(" · ") };
  })();

  /* ------------------------------ location (5) ----------------------------- */
  const location = (() => {
    if (!sr || sr.insufficient) return { value: null, evidence: "S/R zones N/A" };
    const dS = sr.distanceToSupportPct;
    const dR = sr.distanceToResistancePct;
    // bullish when there is room to the next resistance and support is close
    let v = 50;
    const bits: string[] = [sr.locationLabel];
    if (dR != null && dS != null) {
      const total = dR + dS;
      if (total > 0) v = clamp((dR / total) * 100, 0, 100);
      bits.push(`S -${dS.toFixed(2)}% / R +${dR.toFixed(2)}%`);
    } else if (dR != null) { v = 70; bits.push(`R +${dR.toFixed(2)}%`); }
    else if (dS != null) { v = 30; bits.push(`S -${dS.toFixed(2)}%`); }
    if (sr.location === "BREAKOUT_WATCH") { v = clamp(v + 18, 0, 100); }
    if (sr.location === "BREAKDOWN_WATCH") { v = clamp(v - 18, 0, 100); }
    return { value: v, evidence: bits.join(" · ") };
  })();

  /* ------------------------------- assemble -------------------------------- */
  const raw: { key: keyof ConvictionWeights; label: string; v: number | null; ev: string }[] = [
    { key: "priceAction", label: "Price action", v: priceAction.value, ev: priceAction.evidence },
    { key: "orderPositioning", label: "Order positioning", v: orderPos.value, ev: orderPos.evidence },
    { key: "volume", label: "Volume / RVOL", v: volume.value, ev: volume.evidence },
    { key: "optionChain", label: "Option chain", v: options.value, ev: options.evidence },
    { key: "futures", label: "Futures", v: futures.value, ev: futures.evidence },
    { key: "relativeStrength", label: "Relative strength", v: rs.value, ev: rs.evidence },
    { key: "location", label: "S/R location", v: location.value, ev: location.evidence },
  ];

  // Volume is direction-neutral participation: it amplifies whichever side.
  const longFactors: ConvictionFactor[] = raw.map((r) => ({
    key: r.key, label: r.label, weight: W[r.key],
    value: r.v == null ? null : r.key === "volume" ? r.v : r.v,
    evidence: r.ev,
  }));
  const shortFactors: ConvictionFactor[] = raw.map((r) => ({
    key: r.key, label: r.label, weight: W[r.key],
    value: r.v == null ? null : r.key === "volume" ? r.v : 100 - r.v,
    evidence: r.ev,
  }));

  const scoreOf = (fs: ConvictionFactor[]) => {
    let used = 0, acc = 0, total = 0;
    for (const f of fs) {
      total += f.weight;
      if (f.value == null) continue;
      used += f.weight;
      acc += f.weight * f.value;
    }
    if (used === 0) return { score: 0, coverage: 0 };
    const coverage = used / total;
    return { score: Math.round((acc / used) * Math.sqrt(coverage)), coverage };
  };
  const L = scoreOf(longFactors);
  const S = scoreOf(shortFactors);

  // agreement / conflict measured on directional factors only
  const directional = (fs: ConvictionFactor[]) => fs.filter((f) => f.key !== "volume" && f.value != null);
  const dominantIsLong = L.score >= S.score;
  const domFactors = dominantIsLong ? directional(longFactors) : directional(shortFactors);
  const agreeCount = domFactors.filter((f) => (f.value as number) >= 60).length;
  const conflictCount = domFactors.filter((f) => (f.value as number) <= 30).length;
  const conflicted = conflictCount >= 2;

  let longScore = L.score;
  let shortScore = S.score;
  if (conflicted) {
    longScore = Math.min(longScore, 58);
    shortScore = Math.min(shortScore, 58);
  } else if (agreeCount >= 5) {
    longScore = dominantIsLong ? Math.min(100, longScore + 4) : longScore;
    shortScore = !dominantIsLong ? Math.min(100, shortScore + 4) : shortScore;
  }

  const fresh = m.dataStatus === "LIVE" || m.dataStatus === "RECENT";
  const coveragePct = Math.round(Math.max(L.coverage, S.coverage) * 100);
  const top = Math.max(longScore, shortScore);
  const side: ConvictionSide | null = top < CONVICTION_MIN_SCORE ? null : longScore >= shortScore ? "LONG" : "SHORT";

  const grade: ConvictionGrade =
    top >= 80 ? "VERY HIGH" : top >= 70 ? "HIGH" : top >= CONVICTION_MIN_SCORE ? "MODERATE" : "BELOW THRESHOLD";
  const conviction: ConvictionResult["conviction"] =
    conflicted ? "CONFLICTED" : top >= 75 ? "STRONG" : top >= CONVICTION_MIN_SCORE ? "BUILDING" : "WEAK";
  const confidence: ConvictionResult["confidence"] =
    !fresh || conflicted ? "LOW" : coveragePct >= 80 && agreeCount >= 4 ? "HIGH" : coveragePct >= 55 && agreeCount >= 3 ? "MEDIUM" : "LOW";

  const rankable = fresh && !conflicted && coveragePct >= 50 && top >= CONVICTION_MIN_SCORE;

  /* ------------------------------ narrative -------------------------------- */
  const isLong = side === "SHORT" ? false : true;
  const facing = side === "SHORT" ? shortFactors : longFactors;
  const drivers = facing
    .filter((f) => f.value != null && f.value >= 65)
    .sort((a, b) => (b.value as number) - (a.value as number))
    .map((f) => `${f.label}: ${f.evidence}`);
  const risks = facing
    .filter((f) => f.value != null && f.value <= 38)
    .map((f) => `${f.label} not supportive — ${f.evidence}`);
  const naFactors = facing.filter((f) => f.value == null).map((f) => f.label);
  if (naFactors.length) risks.push(`no data for: ${naFactors.join(", ")}`);

  const flowBias = of
    ? of.buyerScore >= of.sellerScore
      ? `buy-side pressure ${of.buyerScore}`
      : `sell-side pressure ${of.sellerScore}`
    : "N/A";
  const futuresBias = m.futures.signal === "UNAVAILABLE" ? "N/A" : m.futures.signal.replaceAll("_", " ").toLowerCase();
  const optionBiasTxt = optBias.bullish == null ? "N/A" : optBias.bullish >= 58 ? "supportive of upside" : optBias.bullish <= 42 ? "supportive of downside" : "balanced";

  const headline = side
    ? `${side} momentum — ${conviction.toLowerCase()} conviction with ${agreeCount} aligned signal${agreeCount === 1 ? "" : "s"}` +
      (conflictCount ? `, ${conflictCount} contradicting` : "")
    : conflicted
      ? "Conflicting evidence — no directional conviction"
      : "Below conviction threshold";

  return {
    symbol: input.symbol,
    computedAt: new Date(input.now).toISOString(),
    side,
    longScore,
    shortScore,
    grade,
    conviction,
    confidence,
    ltp,
    changePct: m.returnDayPct,
    rvol: m.rvol,
    turnoverCr: m.turnoverCr,
    longFactors,
    shortFactors,
    agreeCount,
    conflictCount,
    coveragePct,
    dataStatus: m.dataStatus,
    rankable,
    optionBias: optionBiasTxt + (optBias.pcr != null ? ` (PCR ${optBias.pcr.toFixed(2)})` : ""),
    futuresBias,
    flowBias,
    locationNote: sr && !sr.insufficient ? sr.locationLabel : "N/A",
    headline,
    drivers,
    risks,
  };
}
