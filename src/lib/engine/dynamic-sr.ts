/**
 * DYNAMIC SUPPORT & RESISTANCE ENGINE  —  OI-CENTRIC (replacement engine)
 *
 * This file REPLACES the previous price-structure-clustering S/R engine.
 * There is exactly ONE authoritative Dynamic S/R engine in the application.
 *
 * Methodology (option-chain driven, confirmed by price / volume / liquidity):
 *   1  nearby option-chain strikes around spot          (configurable window)
 *   2  Put-OI support candidates / Call-OI resistance candidates
 *   3  OI strength score  = totalOI 30 + ΔOI 25 + concentration 20
 *                           + stability 10 + fresh writing 15
 *   4  DYNAMIC CENTER     = strike ± capped premium adjustment,
 *                           pulled back by fresh-writing ratio,
 *                           blended with neighbour-strike OI "gravity"
 *   5  ADAPTIVE ZONE      = width scales inversely with OI concentration
 *   6  PRICE CONFIRMATION = real tests / bounces / rejections from candles,
 *                           effective level snapped to the actual reaction
 *                           extreme only after repeated confirmation
 *   7  LIQUIDITY LAYER    = bid/ask strength, imbalance, absorption,
 *                           bid/ask withdrawal (tracked over time)
 *   8  CONFIDENCE         = OI 45 + price action 25 + volume 15 + liquidity 15
 *   9  STATUS ENGINE      = strengthening / building / weakening /
 *                           breakout-breakdown risk / broken
 *  10  OI WALL MIGRATION  = dominant PE/CE strike movement over time
 *  11  OI-WEIGHTED EQUILIBRIUM exposed separately (never labelled S/R)
 *
 * Data integrity: every number traces to live Upstox data. Missing inputs are
 * reported through `dataAvailable` / `dataGaps` / null fields — never faked,
 * never NaN, never Infinity.
 */

import type { Candle, FuturesMetrics } from "./types";
import type { OptionChainStrike } from "@/lib/upstox/types";
import { aggregate, atr, clamp } from "./indicators";

/* ============================ configuration ============================= */

/** OI strength composition (must total 100). */
export interface SRWeights {
  totalOi: number;
  changeOi: number;
  concentration: number;
  stability: number;
  freshWriting: number;
}
export const DEFAULT_SR_WEIGHTS: SRWeights = {
  totalOi: 30,
  changeOi: 25,
  concentration: 20,
  stability: 10,
  freshWriting: 15,
};

/** Confidence composition (must total 100). */
export interface SRConfidenceWeights {
  oiStrength: number;
  priceAction: number;
  volume: number;
  liquidity: number;
}
/**
 * Price-anchored composition: a level must be respected BY PRICE first;
 * option-chain OI, volume-at-level and order-book act as confirmation.
 */
export const DEFAULT_CONFIDENCE_WEIGHTS: SRConfidenceWeights = {
  priceAction: 40,
  oiStrength: 30,
  volume: 15,
  liquidity: 15,
};

/** Engine tunables — configurable, defaults follow the reference behaviour. */
export const SR_CONFIG = {
  /** strikes considered on each side of spot */
  nearbyStrikes: 6,
  /** neighbour strikes contributing gravity/concentration around a candidate */
  neighbourRadius: 2,
  /** premium adjustment cap as a fraction of spot */
  premiumCapPct: 0.006,
  /** how much of the (capped) premium is applied to the center */
  premiumFactor: 0.8,
  /** fresh writing pulls the center back toward the defended strike */
  freshPull: 0.6,
  /** maximum share of the center taken from neighbour gravity */
  neighbourGravityMax: 0.45,
  /** zone width as a fraction of the strike gap (tight → wide) */
  zoneWidthMin: 0.14,
  zoneWidthMax: 0.62,
  /** price must test a zone this many times before the level is snapped */
  snapMinTests: 2,
  /** OI change magnitude (fraction of strike OI) treated as material */
  materialOiChange: 0.08,
  /** liquidity withdrawal threshold (fraction lost since last sample) */
  withdrawalPct: 0.25,
  /** breakout/breakdown acceptance: closes beyond zone required */
  acceptanceCloses: 2,
} as const;

/** Minimum OI strength for a strike to be shown as a level (anti-clutter). */
export const SR_MIN_STRENGTH = 35;

/* ============================== public types ============================= */

export type SupportStatus =
  | "STRONG_SUPPORT"
  | "SUPPORT"
  | "WEAK_SUPPORT"
  | "SUPPORT_BUILDING"
  | "SUPPORT_STRENGTHENING"
  | "SUPPORT_WEAKENING"
  | "BREAKDOWN_RISK"
  | "BROKEN_SUPPORT";

export type ResistanceStatus =
  | "STRONG_RESISTANCE"
  | "RESISTANCE"
  | "WEAK_RESISTANCE"
  | "RESISTANCE_BUILDING"
  | "RESISTANCE_STRENGTHENING"
  | "RESISTANCE_WEAKENING"
  | "BREAKOUT_RISK"
  | "BROKEN_RESISTANCE";

export type ZoneStatus = SupportStatus | ResistanceStatus;

export type TradeLocation =
  | "NEAR_STRONG_SUPPORT"
  | "NEAR_SUPPORT"
  | "MID_ZONE"
  | "NEAR_RESISTANCE"
  | "NEAR_STRONG_RESISTANCE"
  | "BREAKOUT_WATCH"
  | "BREAKDOWN_WATCH"
  | "INSUFFICIENT_DATA";

export type Confirmation = "CONFIRMED" | "CONTRADICTS" | "NEUTRAL" | "UNAVAILABLE";

export interface SRSourceTag {
  source: string;
  price: number;
  detail: string;
  weight: number;
}

export interface MigrationInfo {
  moved: boolean;
  from: number | null;
  to: number | null;
  direction: "UP" | "DOWN" | "NONE";
  note: string;
}

export interface DynamicZone {
  /* ---- identity & geometry (contract preserved for existing UI) ---- */
  id: string; // S1..S3 / R1..R3
  side: "SUPPORT" | "RESISTANCE";
  low: number;
  high: number;
  center: number; // == dynamicCenter (kept for existing consumers)
  widthAbs: number;
  widthPct: number;
  confidence: number; // 0-100 composite confidence
  status: ZoneStatus;
  statusLabel: string;
  tests: number;
  rejections: number;
  distancePct: number;
  distanceAbs: number;
  lastTouchAgoMin: number | null;
  sources: SRSourceTag[];
  sourceNames: string[];
  confirmations: {
    volume: Confirmation;
    vwap: Confirmation;
    futures: Confirmation;
    options: Confirmation;
    prevDayOr: Confirmation;
    liquidity: Confirmation;
  };
  breakRisk: "LOW" | "MEDIUM" | "HIGH";
  roleReversed: boolean;
  engulfsPrice: boolean;
  scoreBreakdown: { key: string; label: string; weight: number; value: number | null; note: string }[];
  coveragePct: number;
  note: string;

  /* ---- new OI-engine fields (additive) ---- */
  level: number; // market-confirmed effective level (snapped when confirmed)
  dynamicCenter: number;
  strength: number; // 0-100 OI positioning strength
  strike: number;
  oi: number | null;
  changeOi: number | null;
  oiConcentration: number | null; // 0-1
  oiStability: number | null; // 0-1
  freshWriting: number | null; // 0-1 ratio of fresh OI
  premiumAdj: number | null;
  neighbourStrikes: { strike: number; oi: number }[];
  priceConfirmation: Confirmation;
  volumeConfirmation: Confirmation;
  liquidityConfirmation: Confirmation;
  bounceCount: number;
  rejectionCount: number;
  migration: MigrationInfo;
  distanceFromSpot: number;
  marketConfirmed: boolean;
}

export interface LiquiditySnapshot {
  bidStrength: number | null;
  askStrength: number | null;
  bidAskRatio: number | null;
  imbalance: number | null; // -1..1 (positive = bid heavy)
  buyerAbsorption: boolean | null;
  sellerAbsorption: boolean | null;
  bidWithdrawal: boolean | null;
  askWithdrawal: boolean | null;
  levels: number | null;
  note: string;
}

export interface OiEquilibrium {
  putWeightedAvg: number | null;
  callWeightedAvg: number | null;
  pivot: number | null;
  pcr: number | null;
  note: string;
}

export interface DynamicSRResult {
  symbol: string;
  computedAt: string;
  ltp: number | null;
  vwap: number | null;
  atr: number | null;
  supports: DynamicZone[];
  resistances: DynamicZone[];
  nearestSupport: DynamicZone | null;
  nearestResistance: DynamicZone | null;
  activeZone: DynamicZone | null;
  dayHigh: number | null;
  dayLow: number | null;
  distanceToSupportPct: number | null;
  distanceToResistancePct: number | null;
  location: TradeLocation;
  locationLabel: string;
  vwapRelation: "ABOVE" | "BELOW" | "AT" | "UNAVAILABLE";
  futuresConfirmation: Confirmation;
  futuresNote: string;
  optionsConfirmation: Confirmation;
  optionsNote: string;
  breakoutRisk: "LOW" | "MEDIUM" | "HIGH";
  breakdownRisk: "LOW" | "MEDIUM" | "HIGH";
  dataGaps: string[];
  insufficient: boolean;

  /* ---- new engine fields ---- */
  dataAvailable: boolean;
  dataFreshness: "LIVE" | "RECENT" | "STALE" | "UNAVAILABLE";
  reason: string | null;
  liquidity: LiquiditySnapshot;
  equilibrium: OiEquilibrium;
  expiry: string | null;
  approachingZone: DynamicZone | null;
  insideZone: boolean;
  /** state transitions detected this cycle (alert source, no repeats) */
  events: { type: string; message: string }[];
}

/* ------------------------------- tracker -------------------------------- */

export interface SRTracker {
  /** confidence history per zone key (for strengthening / weakening) */
  zones: Record<string, { conf: number; prevConf: number | null; strength: number; status: ZoneStatus | null; firstSeen: number; lastSeen: number }>;
  /** OI samples per strike for stability + migration */
  strikeOi: Record<string, { pe: number[]; ce: number[] }>;
  dominant: { pe: number | null; ce: number | null; peAt: number | null; ceAt: number | null };
  depth: { bid: number | null; ask: number | null; at: number | null };
}

export function newSRTracker(): SRTracker {
  return {
    zones: {},
    strikeOi: {},
    dominant: { pe: null, ce: null, peAt: null, ceAt: null },
    depth: { bid: null, ask: null, at: null },
  };
}

export const STATUS_LABEL: Record<ZoneStatus, string> = {
  STRONG_SUPPORT: "Strong Support",
  SUPPORT: "Support",
  WEAK_SUPPORT: "Weak Support",
  SUPPORT_BUILDING: "Support Building",
  SUPPORT_STRENGTHENING: "Support Strengthening",
  SUPPORT_WEAKENING: "Support Weakening",
  BREAKDOWN_RISK: "Breakdown Risk",
  BROKEN_SUPPORT: "Broken Support",
  STRONG_RESISTANCE: "Strong Resistance",
  RESISTANCE: "Resistance",
  WEAK_RESISTANCE: "Weak Resistance",
  RESISTANCE_BUILDING: "Resistance Building",
  RESISTANCE_STRENGTHENING: "Resistance Strengthening",
  RESISTANCE_WEAKENING: "Resistance Weakening",
  BREAKOUT_RISK: "Breakout Risk",
  BROKEN_RESISTANCE: "Broken Resistance",
};

export const LOCATION_LABEL: Record<TradeLocation, string> = {
  NEAR_STRONG_SUPPORT: "Near Strong Support",
  NEAR_SUPPORT: "Near Support",
  MID_ZONE: "Mid-Zone",
  NEAR_RESISTANCE: "Near Resistance",
  NEAR_STRONG_RESISTANCE: "Near Strong Resistance",
  BREAKOUT_WATCH: "Breakout Watch",
  BREAKDOWN_WATCH: "Breakdown Watch",
  INSUFFICIENT_DATA: "Insufficient Data",
};

/* -------------------------------- input --------------------------------- */

export interface DepthLevel {
  price: number;
  quantity: number;
  orders: number;
}

export interface DynamicSRInput {
  symbol: string;
  ltp: number | null;
  vwap: number | null;
  candles1m: Candle[] | null;
  prevDay: { high: number | null; low: number | null; close: number | null };
  dailyAtr: number | null;
  futures: FuturesMetrics;
  optionChain: OptionChainStrike[] | null;
  optionExpiry?: string | null;
  tickSize: number | null;
  tracker: SRTracker;
  now: number;
  /** live market depth from the existing quote feed (confirmation layer) */
  depth?: { buy: DepthLevel[]; sell: DepthLevel[] } | null;
  dayVolume?: number | null;
  avgDailyVolume?: number | null;
  quoteAgeSec?: number | null;
  weights?: SRWeights;
  confidenceWeights?: SRConfidenceWeights;
}

/* ------------------------------ safe helpers ---------------------------- */

const safe = (n: number | null | undefined): number | null =>
  n == null || !Number.isFinite(n) ? null : n;
const div = (a: number, b: number): number => (b === 0 || !Number.isFinite(b) ? 0 : a / b);
const num = (n: number): number => (Number.isFinite(n) ? n : 0);

/* ================================ engine ================================= */

export function computeDynamicSR(input: DynamicSRInput): DynamicSRResult {
  const W = input.weights ?? DEFAULT_SR_WEIGHTS;
  const CW = input.confidenceWeights ?? DEFAULT_CONFIDENCE_WEIGHTS;
  const gaps: string[] = [];
  const events: { type: string; message: string }[] = [];
  const ltp = safe(input.ltp);
  const c1 = input.candles1m ?? [];

  const freshness: DynamicSRResult["dataFreshness"] =
    input.quoteAgeSec == null ? "UNAVAILABLE" : input.quoteAgeSec <= 90 ? "LIVE" : input.quoteAgeSec <= 300 ? "RECENT" : "STALE";

  const shell = (reason: string): DynamicSRResult => ({
    symbol: input.symbol,
    computedAt: new Date(input.now).toISOString(),
    ltp,
    vwap: safe(input.vwap),
    atr: safe(input.dailyAtr),
    supports: [], resistances: [],
    nearestSupport: null, nearestResistance: null, activeZone: null,
    dayHigh: c1.length ? Math.max(...c1.map((c) => c.h)) : null,
    dayLow: c1.length ? Math.min(...c1.map((c) => c.l)) : null,
    distanceToSupportPct: null, distanceToResistancePct: null,
    location: "INSUFFICIENT_DATA", locationLabel: LOCATION_LABEL.INSUFFICIENT_DATA,
    vwapRelation: "UNAVAILABLE",
    futuresConfirmation: "UNAVAILABLE", futuresNote: "UNAVAILABLE",
    optionsConfirmation: "UNAVAILABLE", optionsNote: "UNAVAILABLE",
    breakoutRisk: "LOW", breakdownRisk: "LOW",
    dataGaps: [...gaps, reason], insufficient: true,
    dataAvailable: false, dataFreshness: freshness, reason,
    liquidity: emptyLiquidity("market depth unavailable"),
    equilibrium: { putWeightedAvg: null, callWeightedAvg: null, pivot: null, pcr: null, note: "option chain unavailable" },
    expiry: input.optionExpiry ?? null,
    approachingZone: null, insideZone: false, events,
  });

  if (ltp == null || ltp <= 0) return shell("Live spot price unavailable");
  if (!input.optionChain || input.optionChain.length === 0)
    return shell("Option chain unavailable — OI-based S/R cannot be derived");

  /* ---------------------- 1. nearby strike window ---------------------- */
  const rows = input.optionChain
    .filter((s) => safe(s.strike_price ?? null) != null)
    .map((s) => ({
      strike: s.strike_price as number,
      peOi: safe(s.put_options?.market_data?.oi ?? null),
      pedOi: s.put_options?.market_data?.oi != null && s.put_options?.market_data?.prev_oi != null
        ? (s.put_options.market_data.oi as number) - (s.put_options.market_data.prev_oi as number) : null,
      pePrem: safe(s.put_options?.market_data?.ltp ?? null),
      peVol: safe(s.put_options?.market_data?.volume ?? null),
      ceOi: safe(s.call_options?.market_data?.oi ?? null),
      cedOi: s.call_options?.market_data?.oi != null && s.call_options?.market_data?.prev_oi != null
        ? (s.call_options.market_data.oi as number) - (s.call_options.market_data.prev_oi as number) : null,
      cePrem: safe(s.call_options?.market_data?.ltp ?? null),
      ceVol: safe(s.call_options?.market_data?.volume ?? null),
    }))
    .sort((a, b) => a.strike - b.strike);

  if (rows.length < 3) return shell("Too few strikes in option chain");

  const gaps2 = rows.slice(1).map((r, i) => r.strike - rows[i].strike).filter((g) => g > 0).sort((a, b) => a - b);
  const strikeGap = gaps2.length ? gaps2[Math.floor(gaps2.length / 2)] : Math.max(ltp * 0.01, 1);

  const atmIdx = rows.reduce((best, r, i) => (Math.abs(r.strike - ltp) < Math.abs(rows[best].strike - ltp) ? i : best), 0);
  const lo = Math.max(0, atmIdx - SR_CONFIG.nearbyStrikes);
  const hi = Math.min(rows.length, atmIdx + SR_CONFIG.nearbyStrikes + 1);
  const window = rows.slice(lo, hi);
  if (window.length < 3) return shell("Insufficient strikes near spot");

  /* ---------------------- OI sample tracking (stability / migration) --- */
  for (const r of window) {
    const key = String(r.strike);
    const t = (input.tracker.strikeOi[key] ??= { pe: [], ce: [] });
    if (r.peOi != null) { t.pe.push(r.peOi); if (t.pe.length > 10) t.pe.shift(); }
    if (r.ceOi != null) { t.ce.push(r.ceOi); if (t.ce.length > 10) t.ce.shift(); }
  }

  const maxPe = Math.max(...window.map((r) => r.peOi ?? 0), 1);
  const maxCe = Math.max(...window.map((r) => r.ceOi ?? 0), 1);
  const maxDPe = Math.max(...window.map((r) => Math.abs(r.pedOi ?? 0)), 1);
  const maxDCe = Math.max(...window.map((r) => Math.abs(r.cedOi ?? 0)), 1);
  const maxVol = Math.max(...window.map((r) => Math.max(r.peVol ?? 0, r.ceVol ?? 0)), 1);

  /* ---------------------- 11. OI-weighted equilibrium ------------------ */
  const sumPe = window.reduce((a, r) => a + (r.peOi ?? 0), 0);
  const sumCe = window.reduce((a, r) => a + (r.ceOi ?? 0), 0);
  const putWAvg = sumPe > 0 ? window.reduce((a, r) => a + r.strike * (r.peOi ?? 0), 0) / sumPe : null;
  const callWAvg = sumCe > 0 ? window.reduce((a, r) => a + r.strike * (r.ceOi ?? 0), 0) / sumCe : null;
  const equilibrium: OiEquilibrium = {
    putWeightedAvg: putWAvg,
    callWeightedAvg: callWAvg,
    pivot: putWAvg != null && callWAvg != null ? (putWAvg + callWAvg) / 2 : null,
    pcr: sumCe > 0 ? sumPe / sumCe : null,
    note: "OI-weighted equilibrium — reference only, not a support/resistance level",
  };

  /* ---------------------- 9. liquidity confirmation layer -------------- */
  const liq = computeLiquidity(input, ltp);

  /* ---------------------- price series for confirmation ---------------- */
  const c3 = aggregate(c1, 3);
  const c5 = aggregate(c1, 5);
  const intradayAtr = c5.length >= 15 ? atr(c5, 14) : null;
  const dayHigh = c1.length ? Math.max(...c1.map((c) => c.h)) : null;
  const dayLow = c1.length ? Math.min(...c1.map((c) => c.l)) : null;
  if (c1.length < 20) gaps.push("limited intraday candles — price confirmation reduced");

  const volConfirm: Confirmation = (() => {
    const dv = safe(input.dayVolume ?? null);
    const av = safe(input.avgDailyVolume ?? null);
    if (dv == null) return "UNAVAILABLE";
    if (av == null || av <= 0) return "NEUTRAL";
    const ratio = dv / av;
    return ratio >= 0.9 ? "CONFIRMED" : ratio >= 0.45 ? "NEUTRAL" : "CONTRADICTS";
  })();
  const volScore = volConfirm === "CONFIRMED" ? 85 : volConfirm === "NEUTRAL" ? 50 : volConfirm === "CONTRADICTS" ? 25 : null;

  /* ==================== 3/4. CANDIDATE GENERATION =======================
   * Levels are ANCHORED TO REAL PRICE INTERACTION inside today's traded
   * range, then scored/confirmed with option-chain OI, order flow, volume
   * and futures. Every displayed level is therefore a price the market has
   * actually traded and reacted at; OI walls far outside the intraday range
   * can no longer become levels (they remain context only).
   * ===================================================================== */
  const candidates: DynamicZone[] = [];

  if (dayHigh == null || dayLow == null || c3.length < 6) {
    return shell("Insufficient intraday candles to anchor S/R to real price interaction");
  }

  const tol = clamp(
    Math.max(
      input.dailyAtr != null ? input.dailyAtr * 0.08 : 0,
      intradayAtr != null ? intradayAtr * 0.45 : 0,
      ltp * 0.0007,
      (input.tickSize ?? 0) * 2,
    ),
    ltp * 0.0007,
    ltp * 0.004,
  );

  interface Touch { price: number; t: number; vol: number; bounce: boolean; rejection: boolean }
  const touchPts: Touch[] = [];
  for (let i = 0; i < c3.length; i++) {
    const c = c3[i];
    const range = c.h - c.l;
    const body = Math.abs(c.c - c.o);
    const upWick = c.h - Math.max(c.c, c.o);
    const dnWick = Math.min(c.c, c.o) - c.l;
    const prev = c3[i - 1];
    const next = c3[i + 1];
    // A reaction is either a wick-dominant candle OR a genuine swing turn:
    // price made a local low and turned up (bounce) / local high and turned
    // down (rejection). This catches real reversals on any candle shape.
    const turnUp = !!prev && !!next && c.l <= prev.l && c.l <= next.l && next.c > c.c;
    const turnDown = !!prev && !!next && c.h >= prev.h && c.h >= next.h && next.c < c.c;
    touchPts.push({
      price: c.h, t: c.t, vol: c.v, bounce: false,
      rejection: turnDown || (range > 0 && upWick > range * 0.45 && upWick > body),
    });
    touchPts.push({
      price: c.l, t: c.t, vol: c.v, rejection: false,
      bounce: turnUp || (range > 0 && dnWick > range * 0.45 && dnWick > body),
    });
  }

  const refs: { price: number; label: string }[] = [];
  const pushRef = (p: number | null | undefined, label: string) => {
    if (p != null && Number.isFinite(p) && p >= dayLow && p <= dayHigh) refs.push({ price: p, label });
  };
  pushRef(input.vwap, "VWAP");
  pushRef(input.prevDay.high, "PDH");
  pushRef(input.prevDay.low, "PDL");
  pushRef(input.prevDay.close, "PDC");
  if (c1.length >= 5) {
    const or5 = c1.slice(0, 5);
    pushRef(Math.max(...or5.map((c) => c.h)), "OR5m_HIGH");
    pushRef(Math.min(...or5.map((c) => c.l)), "OR5m_LOW");
  }
  if (c1.length >= 15) {
    const or15 = c1.slice(0, 15);
    pushRef(Math.max(...or15.map((c) => c.h)), "OR15m_HIGH");
    pushRef(Math.min(...or15.map((c) => c.l)), "OR15m_LOW");
  }

  const volAtPrice = new Map<number, number>();
  let totalVol = 0;
  for (const c of c1) {
    if (c.v <= 0) continue;
    const key = Math.round(((c.h + c.l + c.c) / 3) / tol) * tol;
    volAtPrice.set(key, (volAtPrice.get(key) ?? 0) + c.v);
    totalVol += c.v;
  }
  const maxNodeVol = Math.max(...[...volAtPrice.values(), 1]);

  // Bin every interaction, then keep LOCAL PEAKS — the prices the market
  // returned to most often. (Chained clustering would merge a trending
  // session into one blob, which is why levels must come from peaks.)
  interface Cluster { prices: number[]; weights: number[]; touches: number; bounces: number; rejections: number; lastT: number }
  const bins = new Map<number, Cluster>();
  for (const t of touchPts) {
    const key = Math.round(t.price / tol);
    const b = bins.get(key) ?? { prices: [], weights: [], touches: 0, bounces: 0, rejections: 0, lastT: 0 };
    b.prices.push(t.price);
    b.weights.push(t.bounce || t.rejection ? 3 : 1);
    b.touches++;
    if (t.bounce) b.bounces++;
    if (t.rejection) b.rejections++;
    b.lastT = Math.max(b.lastT, t.t);
    bins.set(key, b);
  }
  const score = (b: Cluster | undefined) => (b ? b.touches + (b.bounces + b.rejections) * 2 : 0);
  const peaks: { key: number; s: number; c: Cluster }[] = [];
  for (const [key, b] of bins) {
    if (b.touches < 2) continue;
    const s = score(b);
    // local maximum against both neighbouring bins (ties allowed; duplicates
    // are removed afterwards by keeping the strongest peak in each area)
    if (s < score(bins.get(key - 1)) || s < score(bins.get(key + 1))) continue;
    peaks.push({ key, s, c: b });
  }
  peaks.sort((a, b) => b.s - a.s);
  const clusters: Cluster[] = [];
  const takenKeys: number[] = [];
  for (const { key, s, c: b } of peaks) {
    if (takenKeys.some((k) => Math.abs(k - key) <= 1)) continue; // same area
    takenKeys.push(key);
    // merge the immediate neighbours into the peak for an exact price
    const merged: Cluster = { prices: [...b.prices], weights: [...b.weights], touches: b.touches, bounces: b.bounces, rejections: b.rejections, lastT: b.lastT };
    for (const nk of [key - 1, key + 1]) {
      const nbBin = bins.get(nk);
      if (!nbBin || score(nbBin) >= s) continue;
      merged.prices.push(...nbBin.prices);
      merged.weights.push(...nbBin.weights);
      merged.touches += nbBin.touches;
      merged.bounces += nbBin.bounces;
      merged.rejections += nbBin.rejections;
      merged.lastT = Math.max(merged.lastT, nbBin.lastT);
    }
    clusters.push(merged);
  }

  const lastBarT = c1[c1.length - 1].t;
  const strikeOf = (p: number) => {
    let best: (typeof window)[number] | null = null;
    for (const r of window) if (best == null || Math.abs(r.strike - p) < Math.abs(best.strike - p)) best = r;
    return best != null && Math.abs(best.strike - p) <= strikeGap * 0.75 ? best : null;
  };

  for (const cl of clusters) {
    if (cl.touches < 2) continue;
    const wsum = cl.weights.reduce((a, b) => a + b, 0) || 1;
    const level = cl.prices.reduce((a, p, i) => a + p * cl.weights[i], 0) / wsum;
    if (level < dayLow - tol || level > dayHigh + tol) continue;

    const zLow = level - tol * 0.5;
    const zHigh = level + tol * 0.5;
    const engulfsPrice = ltp >= zLow && ltp <= zHigh;
    const side: "SUPPORT" | "RESISTANCE" = level <= ltp ? "SUPPORT" : "RESISTANCE";
    const isSup = side === "SUPPORT";
    const reactions = isSup ? cl.bounces : cl.rejections;

    const hitRefs = refs.filter((r) => Math.abs(r.price - level) <= tol);

    let nodeVol = 0;
    for (const [p, v] of volAtPrice) if (Math.abs(p - level) <= tol) nodeVol += v;
    const volNodeScore = maxNodeVol > 0 ? clamp(div(nodeVol, maxNodeVol) * 100, 0, 100) : null;

    const near = strikeOf(level);
    const oi = near ? (isSup ? near.peOi : near.ceOi) : null;
    const dOi = near ? (isSup ? near.pedOi : near.cedOi) : null;
    const prem = near ? (isSup ? near.pePrem : near.cePrem) : null;
    const maxOi = isSup ? maxPe : maxCe;
    const maxD = isSup ? maxDPe : maxDCe;

    let concentration: number | null = null;
    let stability: number | null = null;
    let freshRatio = 0;
    let unwinding = false;
    const nb: { strike: number; oi: number }[] = [];
    if (near && oi != null && oi > 0) {
      const idx = window.findIndex((r) => r.strike === near.strike);
      for (let k = idx - SR_CONFIG.neighbourRadius; k <= idx + SR_CONFIG.neighbourRadius; k++) {
        if (k < 0 || k >= window.length) continue;
        const o = isSup ? window[k].peOi : window[k].ceOi;
        if (o != null && o > 0) nb.push({ strike: window[k].strike, oi: o });
      }
      const nbTotal = nb.reduce((a, x) => a + x.oi, 0);
      concentration = nbTotal > 0 ? clamp(div(oi, nbTotal), 0, 1) : 1;
      const samples = (isSup ? input.tracker.strikeOi[String(near.strike)]?.pe : input.tracker.strikeOi[String(near.strike)]?.ce) ?? [];
      if (samples.length >= 3) {
        const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
        if (mean > 0) {
          const sd = Math.sqrt(samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length);
          stability = clamp(1 - div(sd, mean) * 4, 0, 1);
        }
      }
      freshRatio = dOi != null && dOi > 0 ? clamp(div(dOi, oi), 0, 1) : 0;
      unwinding = dOi != null && dOi < -oi * SR_CONFIG.materialOiChange;
    }

    const sParts = [
      { key: "totalOi", label: "Total OI", weight: W.totalOi, value: oi == null ? null : clamp(div(oi, maxOi) * 100, 0, 100), note: oi == null ? "no strike near level" : `${isSup ? "PE" : "CE"} OI ${fmtK(oi)} @ ${near!.strike}` },
      { key: "changeOi", label: "Change in OI", weight: W.changeOi, value: dOi == null ? null : clamp(50 + div(dOi, maxD) * 50, 0, 100), note: dOi == null ? "dOI unavailable" : `dOI ${dOi >= 0 ? "+" : ""}${fmtK(dOi)}${unwinding ? " (unwinding)" : dOi > 0 ? " (writing)" : ""}` },
      { key: "concentration", label: "OI concentration", weight: W.concentration, value: concentration == null ? null : clamp(concentration * 100, 0, 100), note: concentration == null ? "n/a" : `${Math.round(concentration * 100)}% of local OI` },
      { key: "stability", label: "OI stability", weight: W.stability, value: stability == null ? null : clamp(stability * 100, 0, 100), note: stability == null ? "building history" : `${Math.round(stability * 100)}% stable` },
      { key: "freshWriting", label: "Fresh writing", weight: W.freshWriting, value: oi == null ? null : clamp(freshRatio * 200, 0, 100), note: freshRatio > 0 ? `${Math.round(freshRatio * 100)}% fresh OI` : "no fresh writing" },
    ];
    let sw = 0, sacc = 0, stot = 0;
    for (const p of sParts) { stot += p.weight; if (p.value == null) continue; sw += p.weight; sacc += p.weight * p.value; }
    let strength = sw > 0 ? Math.round(div(sacc, sw) * Math.sqrt(div(sw, stot))) : 0;
    if (unwinding) strength = Math.round(strength * 0.75);
    strength = Math.round(clamp(strength, 0, 100));

    const premAdj = prem != null && oi != null && oi >= maxOi * 0.4
      ? Math.min(prem, ltp * SR_CONFIG.premiumCapPct) * SR_CONFIG.premiumFactor * 0.35
      : 0;
    const dynamicCenter = num(isSup ? level - premAdj : level + premAdj);

    const recencyW = clamp(1 - div(lastBarT - cl.lastT, 3.5 * 3600_000), 0.3, 1);
    const priceScore = clamp(Math.min(cl.touches, 12) * 5 + reactions * 14 + hitRefs.length * 8, 0, 100) * recencyW;
    const priceConfirmation: Confirmation = reactions >= 2 ? "CONFIRMED" : cl.touches >= 3 ? "NEUTRAL" : "CONTRADICTS";
    const marketConfirmed = reactions >= SR_CONFIG.snapMinTests;

    const accBuf = Math.max((intradayAtr ?? 0) * 0.25, ltp * 0.0008);
    const recent = c5.slice(-6);
    const brokenNow = isSup
      ? recent.filter((c) => c.c < zLow - accBuf).length >= SR_CONFIG.acceptanceCloses && ltp < zLow - accBuf
      : recent.filter((c) => c.c > zHigh + accBuf).length >= SR_CONFIG.acceptanceCloses && ltp > zHigh + accBuf;

    const liqConf = liquidityConfirmationFor(side, liq);
    const liqScore = liqConf === "CONFIRMED" ? 85 : liqConf === "NEUTRAL" ? 50 : liqConf === "CONTRADICTS" ? 22 : null;

    const cParts = [
      { key: "priceAction", label: "Price interaction", weight: CW.priceAction, value: priceScore as number | null, note: `${cl.touches} touches, ${reactions} ${isSup ? "bounce" : "rejection"}(s)${hitRefs.length ? `, ${hitRefs.map((r) => r.label).join("+")}` : ""}` },
      { key: "oiStrength", label: "Option-chain OI", weight: CW.oiStrength, value: oi == null ? null : strength, note: oi == null ? "no OI wall at this price" : `strike ${near!.strike} strength ${strength}` },
      { key: "volume", label: "Volume at level", weight: CW.volume, value: volNodeScore ?? volScore, note: volNodeScore != null ? `${Math.round(div(nodeVol, Math.max(totalVol, 1)) * 100)}% of day volume traded here` : String(volConfirm) },
      { key: "liquidity", label: "Order-book", weight: CW.liquidity, value: liqScore, note: liq.note },
    ];
    let cw2 = 0, cacc = 0, ctot = 0;
    for (const p of cParts) { ctot += p.weight; if (p.value == null) continue; cw2 += p.weight; cacc += p.weight * p.value; }
    const coverage = div(cw2, ctot);
    let confidence = cw2 > 0 ? Math.round(div(cacc, cw2) * Math.sqrt(coverage)) : 0;
    const distancePct = Math.abs(div(level - ltp, ltp)) * 100;
    if (brokenNow) confidence = Math.round(confidence * 0.5);
    confidence = Math.round(clamp(confidence, 0, 100));

    const withdrawal = isSup ? liq.bidWithdrawal === true : liq.askWithdrawal === true;
    let breakRisk: "LOW" | "MEDIUM" | "HIGH" = "LOW";
    if (distancePct <= 0.4 && (unwinding || withdrawal)) breakRisk = "HIGH";
    else if (distancePct <= 0.7 || unwinding) breakRisk = "MEDIUM";

    const migration = near && oi != null
      ? migrationFor(side, near.strike, oi, maxOi, input.tracker, input.now)
      : { moved: false, from: null, to: null, direction: "NONE" as const, note: "" };

    const zKey = `${side}:${(Math.round(level / Math.max(tol, 0.01)) * Math.max(tol, 0.01)).toFixed(2)}`;
    const prior = input.tracker.zones[zKey];
    const delta = prior ? confidence - prior.conf : 0;
    const status = classify(side, confidence, strength, delta, freshRatio, unwinding, brokenNow, breakRisk);
    if (prior && prior.status && prior.status !== status) {
      events.push({ type: status, message: `${input.symbol} ${level.toFixed(2)} ${STATUS_LABEL[status]}` });
    }
    if (migration.moved) events.push({ type: "OI_WALL_MIGRATION", message: `${input.symbol} ${side === "SUPPORT" ? "PUT" : "CALL"} wall ${migration.from} -> ${migration.to}` });
    input.tracker.zones[zKey] = { conf: confidence, prevConf: prior?.conf ?? null, strength, status, firstSeen: prior?.firstSeen ?? input.now, lastSeen: input.now };

    const srcTags: SRSourceTag[] = [
      { source: "PRICE_INTERACTION", price: level, detail: `${cl.touches} touches, ${reactions} ${isSup ? "bounce" : "rejection"}(s)`, weight: 1 },
      ...hitRefs.map((r) => ({ source: r.label, price: r.price, detail: r.label.replaceAll("_", " "), weight: 0.7 })),
      ...(volNodeScore != null && volNodeScore >= 50 ? [{ source: "VOLUME_NODE", price: level, detail: "high volume traded at this price", weight: 0.8 }] : []),
      ...(near && oi != null ? [{ source: isSup ? "PE_OI" : "CE_OI", price: near.strike, detail: `${isSup ? "PE" : "CE"} OI ${fmtK(oi)} @ ${near.strike}`, weight: clamp(div(oi, maxOi), 0, 1) }] : []),
      ...nb.filter((x) => near && x.strike !== near.strike).map((x) => ({ source: "NEIGHBOUR_OI", price: x.strike, detail: `neighbour ${x.strike} OI ${fmtK(x.oi)}`, weight: 0.4 })),
    ];

    candidates.push({
      id: "", side,
      low: num(zLow), high: num(zHigh), center: dynamicCenter,
      widthAbs: num(zHigh - zLow), widthPct: num(div(zHigh - zLow, ltp) * 100),
      confidence, status, statusLabel: STATUS_LABEL[status],
      tests: cl.touches, rejections: reactions,
      distancePct: num(distancePct), distanceAbs: num(Math.abs(level - ltp)),
      lastTouchAgoMin: Math.round((lastBarT - cl.lastT) / 60000),
      sources: srcTags, sourceNames: [...new Set(srcTags.map((s) => s.source))],
      confirmations: {
        volume: volNodeScore == null ? volConfirm : volNodeScore >= 55 ? "CONFIRMED" : volNodeScore >= 25 ? "NEUTRAL" : "CONTRADICTS",
        vwap: input.vwap == null ? "UNAVAILABLE" : (isSup ? ltp >= input.vwap : ltp <= input.vwap) ? "CONFIRMED" : "NEUTRAL",
        futures: futuresConfirmationFor(side, input.futures).confirmation,
        options: oi == null ? "UNAVAILABLE" : unwinding ? "CONTRADICTS" : strength >= 55 ? "CONFIRMED" : "NEUTRAL",
        prevDayOr: hitRefs.some((r) => ["PDH", "PDL", "PDC", "OR5m_HIGH", "OR5m_LOW", "OR15m_HIGH", "OR15m_LOW"].includes(r.label)) ? "CONFIRMED" : "NEUTRAL",
        liquidity: liqConf,
      },
      breakRisk, roleReversed: false, engulfsPrice,
      scoreBreakdown: [
        ...cParts.map((p) => ({ key: `conf_${p.key}`, label: `Confidence - ${p.label}`, weight: p.weight, value: p.value == null ? null : Math.round(p.value), note: p.note })),
        ...sParts.map((p) => ({ key: p.key, label: `OI - ${p.label}`, weight: p.weight, value: p.value == null ? null : Math.round(p.value), note: p.note })),
      ],
      coveragePct: Math.round(coverage * 100),
      note: brokenNow ? "broken with candle-close acceptance" : engulfsPrice ? "price is trading inside this level" : migration.moved ? migration.note : "",
      level: num(level), dynamicCenter, strength, strike: near?.strike ?? 0,
      oi, changeOi: dOi, oiConcentration: concentration, oiStability: stability,
      freshWriting: oi == null ? null : num(freshRatio), premiumAdj: premAdj,
      neighbourStrikes: nb,
      priceConfirmation, volumeConfirmation: volConfirm, liquidityConfirmation: liqConf,
      bounceCount: cl.bounces, rejectionCount: cl.rejections,
      migration, distanceFromSpot: num(level - ltp),
      marketConfirmed,
    });
  }

  /* ---------------------- 15/16. rank & select ------------------------- */
  const relevance = (z: DynamicZone) => z.confidence * 0.6 + z.strength * 0.4 - Math.min(30, z.distancePct * 6);

  /*
   * Meaningfulness gate — a strike only qualifies as a displayed level when
   * its option positioning is materially significant (real OI wall) or price
   * has repeatedly reacted there. Filler strikes that merely exist in the
   * chain (tiny OI, negligible concentration) are never shown, so S1/R1 are
   * always genuine walls rather than the nearest arbitrary strike.
   */
  const meaningful = (z: DynamicZone) =>
    z.confidence >= 22 &&
    // price must have genuinely respected the level, or a real OI wall /
    // structural reference must sit exactly on it
    (z.marketConfirmed ||
      z.tests >= 3 ||
      z.strength >= SR_MIN_STRENGTH ||
      z.sourceNames.some((s) => ["VWAP", "PDH", "PDL", "PDC", "VOLUME_NODE", "OR5m_HIGH", "OR5m_LOW", "OR15m_HIGH", "OR15m_LOW"].includes(s)));

  const supports = candidates
    .filter((z) => z.side === "SUPPORT" && !z.engulfsPrice && z.high < ltp && z.status !== "BROKEN_SUPPORT" && meaningful(z))
    .sort((a, b) => relevance(b) - relevance(a))
    .slice(0, 3)
    .sort((a, b) => b.center - a.center);
  const resistances = candidates
    .filter((z) => z.side === "RESISTANCE" && !z.engulfsPrice && z.low > ltp && z.status !== "BROKEN_RESISTANCE" && meaningful(z))
    .sort((a, b) => relevance(b) - relevance(a))
    .slice(0, 3)
    .sort((a, b) => a.center - b.center);
  supports.forEach((z, i) => (z.id = `S${i + 1}`));
  resistances.forEach((z, i) => (z.id = `R${i + 1}`));

  const nS = supports[0] ?? null;
  const nR = resistances[0] ?? null;
  const activeZone = candidates.find((z) => z.engulfsPrice) ?? null;
  const approaching = [...supports, ...resistances].find((z) => z.distancePct <= 0.3) ?? null;

  const location = classifyLocation(ltp, nS, nR);
  const vwapRelation: DynamicSRResult["vwapRelation"] =
    input.vwap == null ? "UNAVAILABLE"
      : Math.abs(div(ltp - input.vwap, ltp)) < 0.0008 ? "AT"
      : ltp > input.vwap ? "ABOVE" : "BELOW";

  const fut = futuresConfirmationFor(nR ? "RESISTANCE" : "SUPPORT", input.futures);
  const optNote = equilibrium.pcr != null
    ? `PCR ${equilibrium.pcr.toFixed(2)} · pivot ${equilibrium.pivot != null ? equilibrium.pivot.toFixed(2) : "N/A"}`
    : "option OI present";

  if (supports.length === 0) gaps.push("no qualifying Put-OI support below spot");
  if (resistances.length === 0) gaps.push("no qualifying Call-OI resistance above spot");

  return {
    symbol: input.symbol,
    computedAt: new Date(input.now).toISOString(),
    ltp, vwap: safe(input.vwap), atr: safe(input.dailyAtr ?? intradayAtr),
    supports, resistances,
    nearestSupport: nS, nearestResistance: nR, activeZone,
    dayHigh, dayLow,
    distanceToSupportPct: nS ? num(div(ltp - nS.center, ltp) * 100) : null,
    distanceToResistancePct: nR ? num(div(nR.center - ltp, ltp) * 100) : null,
    location, locationLabel: LOCATION_LABEL[location],
    vwapRelation,
    futuresConfirmation: fut.confirmation, futuresNote: fut.note,
    optionsConfirmation: "CONFIRMED", optionsNote: optNote,
    breakoutRisk: nR?.breakRisk ?? "LOW", breakdownRisk: nS?.breakRisk ?? "LOW",
    dataGaps: gaps,
    insufficient: supports.length === 0 && resistances.length === 0,
    dataAvailable: true, dataFreshness: freshness, reason: null,
    liquidity: liq, equilibrium, expiry: input.optionExpiry ?? null,
    approachingZone: approaching, insideZone: activeZone != null,
    events,
  };
}

/* ============================== sub-systems ============================== */

function fmtK(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${Math.round(n)}`;
}

function emptyLiquidity(note: string): LiquiditySnapshot {
  return {
    bidStrength: null, askStrength: null, bidAskRatio: null, imbalance: null,
    buyerAbsorption: null, sellerAbsorption: null, bidWithdrawal: null, askWithdrawal: null,
    levels: null, note,
  };
}

/** 9. Liquidity / order-book engine (confirmation layer only). */
function computeLiquidity(input: DynamicSRInput, ltp: number): LiquiditySnapshot {
  const d = input.depth;
  if (!d || (d.buy.length === 0 && d.sell.length === 0)) return emptyLiquidity("market depth unavailable");
  const bid = d.buy.reduce((a, l) => a + num(l.quantity), 0);
  const ask = d.sell.reduce((a, l) => a + num(l.quantity), 0);
  if (bid + ask <= 0) return emptyLiquidity("no depth quantity reported");

  const ratio = ask > 0 ? bid / ask : null;
  const imbalance = clamp(div(bid - ask, bid + ask), -1, 1);

  const prev = input.tracker.depth;
  const bidWithdrawal = prev.bid != null && prev.bid > 0 ? bid < prev.bid * (1 - SR_CONFIG.withdrawalPct) : null;
  const askWithdrawal = prev.ask != null && prev.ask > 0 ? ask < prev.ask * (1 - SR_CONFIG.withdrawalPct) : null;
  input.tracker.depth = { bid, ask, at: input.now };

  // Absorption: heavy resting size on one side while price is not moving
  // through it — bid absorbing sellers / ask absorbing buyers.
  const buyerAbsorption = imbalance >= 0.25;
  const sellerAbsorption = imbalance <= -0.25;

  const note = `bid ${fmtK(bid)} / ask ${fmtK(ask)} · imbalance ${(imbalance * 100).toFixed(0)}%` +
    (bidWithdrawal ? " · bid withdrawal" : "") + (askWithdrawal ? " · ask withdrawal" : "");

  return {
    bidStrength: bid, askStrength: ask, bidAskRatio: ratio, imbalance,
    buyerAbsorption, sellerAbsorption, bidWithdrawal, askWithdrawal,
    levels: Math.max(d.buy.length, d.sell.length), note,
  };
}

function liquidityConfirmationFor(side: "SUPPORT" | "RESISTANCE", l: LiquiditySnapshot): Confirmation {
  if (l.imbalance == null) return "UNAVAILABLE";
  if (side === "SUPPORT") {
    if (l.bidWithdrawal) return "CONTRADICTS";
    if (l.buyerAbsorption) return "CONFIRMED";
    if (l.sellerAbsorption) return "CONTRADICTS";
    return "NEUTRAL";
  }
  if (l.askWithdrawal) return "CONTRADICTS";
  if (l.sellerAbsorption) return "CONFIRMED";
  if (l.buyerAbsorption) return "CONTRADICTS";
  return "NEUTRAL";
}

/** 12. OI wall migration — dominant strike movement over time. */
function migrationFor(
  side: "SUPPORT" | "RESISTANCE",
  strike: number,
  oi: number,
  maxOi: number,
  tracker: SRTracker,
  now: number,
): MigrationInfo {
  const isDominant = oi >= maxOi * 0.999;
  const key = side === "SUPPORT" ? "pe" : "ce";
  const prev = key === "pe" ? tracker.dominant.pe : tracker.dominant.ce;
  if (!isDominant) {
    return { moved: false, from: prev, to: prev, direction: "NONE", note: "" };
  }
  if (prev == null) {
    if (key === "pe") { tracker.dominant.pe = strike; tracker.dominant.peAt = now; }
    else { tracker.dominant.ce = strike; tracker.dominant.ceAt = now; }
    return { moved: false, from: null, to: strike, direction: "NONE", note: "" };
  }
  if (prev === strike) return { moved: false, from: prev, to: strike, direction: "NONE", note: "" };
  const direction: "UP" | "DOWN" = strike > prev ? "UP" : "DOWN";
  if (key === "pe") { tracker.dominant.pe = strike; tracker.dominant.peAt = now; }
  else { tracker.dominant.ce = strike; tracker.dominant.ceAt = now; }
  const label = side === "SUPPORT" ? "PUT wall" : "CALL wall";
  const strengthening = side === "SUPPORT" ? direction === "UP" : direction === "DOWN";
  return {
    moved: true, from: prev, to: strike, direction,
    note: `${label} migrated ${prev} → ${strike} (${strengthening ? "positioning strengthening" : "positioning weakening"})`,
  };
}

function prevDayConfirmation(
  pd: { high: number | null; low: number | null; close: number | null },
  low: number,
  high: number,
): Confirmation {
  const vals = [pd.high, pd.low, pd.close].filter((v): v is number => v != null);
  if (!vals.length) return "UNAVAILABLE";
  return vals.some((v) => v >= low && v <= high) ? "CONFIRMED" : "NEUTRAL";
}

function futuresConfirmationFor(
  side: "SUPPORT" | "RESISTANCE",
  f: FuturesMetrics,
): { value: number | null; confirmation: Confirmation; note: string } {
  if (f.signal === "UNAVAILABLE") return { value: null, confirmation: "UNAVAILABLE", note: "futures UNAVAILABLE" };
  if (f.signal === "NEUTRAL") return { value: 50, confirmation: "NEUTRAL", note: "futures positioning ambiguous" };
  const bullish = f.signal === "LONG_BUILDUP" || f.signal === "SHORT_COVERING";
  const aligned = side === "SUPPORT" ? bullish : !bullish;
  return {
    value: aligned ? 88 : 26,
    confirmation: aligned ? "CONFIRMED" : "CONTRADICTS",
    note: `${f.signal.replaceAll("_", " ").toLowerCase()} characteristics`,
  };
}

/** 11. Status engine — evidence-driven, never sticky. */
function classify(
  side: "SUPPORT" | "RESISTANCE",
  confidence: number,
  strength: number,
  delta: number,
  freshRatio: number,
  unwinding: boolean,
  broken: boolean,
  risk: "LOW" | "MEDIUM" | "HIGH",
): ZoneStatus {
  if (side === "SUPPORT") {
    if (broken) return "BROKEN_SUPPORT";
    if (risk === "HIGH" && confidence < 70) return "BREAKDOWN_RISK";
    if (unwinding || delta <= -6) return "SUPPORT_WEAKENING";
    if (freshRatio >= 0.25 && confidence < 75) return "SUPPORT_BUILDING";
    if (delta >= 6) return "SUPPORT_STRENGTHENING";
    if (confidence >= 75 && strength >= 60) return "STRONG_SUPPORT";
    if (confidence >= 55) return "SUPPORT";
    return "WEAK_SUPPORT";
  }
  if (broken) return "BROKEN_RESISTANCE";
  if (risk === "HIGH" && confidence < 70) return "BREAKOUT_RISK";
  if (unwinding || delta <= -6) return "RESISTANCE_WEAKENING";
  if (freshRatio >= 0.25 && confidence < 75) return "RESISTANCE_BUILDING";
  if (delta >= 6) return "RESISTANCE_STRENGTHENING";
  if (confidence >= 75 && strength >= 60) return "STRONG_RESISTANCE";
  if (confidence >= 55) return "RESISTANCE";
  return "WEAK_RESISTANCE";
}

function classifyLocation(ltp: number, s: DynamicZone | null, r: DynamicZone | null): TradeLocation {
  if (!s && !r) return "INSUFFICIENT_DATA";
  const ds = s ? div(ltp - s.level, ltp) * 100 : Infinity;
  const dr = r ? div(r.level - ltp, ltp) * 100 : Infinity;
  if (r && dr <= 0.35 && r.breakRisk === "HIGH") return "BREAKOUT_WATCH";
  if (s && ds <= 0.35 && s.breakRisk === "HIGH") return "BREAKDOWN_WATCH";
  if (s && ds <= 0.5) return s.confidence >= 75 ? "NEAR_STRONG_SUPPORT" : "NEAR_SUPPORT";
  if (r && dr <= 0.5) return r.confidence >= 75 ? "NEAR_STRONG_RESISTANCE" : "NEAR_RESISTANCE";
  return "MID_ZONE";
}
