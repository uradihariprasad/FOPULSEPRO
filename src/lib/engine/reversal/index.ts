/**
 * REVERSAL RADAR — independent analysis engine
 *
 * Answers: "Which F&O stocks are stretched, and which of them show stronger
 * evidence of REVERSAL than of CONTINUATION?"
 *
 * Architecture (this module only — nothing outside is modified):
 *   EXTREME DETECTOR ─┐
 *   EXHAUSTION       ─┤
 *   PRICE ACTION     ─┼─► REVERSAL SCORER ─► REVERSAL vs CONTINUATION ─► tab
 *   VOLUME           ─┤
 *   FUTURES / OI     ─┤
 *   OPTIONS + S/R    ─┤   (READ-ONLY from the existing engines)
 *   MARKET CONTEXT   ─┘
 *
 * Hard rules:
 *   - RSI (or any single indicator) can never produce a reversal call
 *   - reversal and continuation are scored INDEPENDENTLY and compared
 *   - incomplete data yields INSUFFICIENT DATA, never a manufactured score
 */

import type { Candle, Stage1Metrics } from "../types";
import type { OptionChainStrike } from "@/lib/upstox/types";
import type { DynamicSRResult } from "../dynamic-sr";
import type { OrderFlowResult } from "../orderflow";
import { aggregate, clamp, ema } from "../indicators";
import {
  DEFAULT_EXTREME_CONFIG, detectExhaustion, detectExtreme, detectPriceAction,
  detectVolumeExhaustion, macd, roc,
  type ExhaustionState, type ExtremeConfig, type ExtremeState, type PriceActionState, type VolumeState,
} from "./detectors";

/* ------------------------------ public types ----------------------------- */

export type ReversalCategory =
  | "OVERBOUGHT_REVERSAL_WATCH"
  | "OVERSOLD_REVERSAL_WATCH"
  | "OVERBOUGHT_CONTINUATION_RISK"
  | "OVERSOLD_CONTINUATION_RISK"
  | "NOT_STRETCHED"
  | "INSUFFICIENT_DATA";

export const CATEGORY_LABEL: Record<ReversalCategory, string> = {
  OVERBOUGHT_REVERSAL_WATCH: "Overbought — Reversal Watch",
  OVERSOLD_REVERSAL_WATCH: "Oversold — Reversal Watch",
  OVERBOUGHT_CONTINUATION_RISK: "Overbought — Continuation Risk",
  OVERSOLD_CONTINUATION_RISK: "Oversold — Continuation Risk",
  NOT_STRETCHED: "Not Stretched",
  INSUFFICIENT_DATA: "Insufficient Data",
};

export interface ReversalWeights {
  extreme: number;
  exhaustion: number;
  priceAction: number;
  volume: number;
  futuresOi: number;
  optionSr: number;
  market: number;
}

export const DEFAULT_REVERSAL_WEIGHTS: ReversalWeights = {
  extreme: 15,
  exhaustion: 20,
  priceAction: 20,
  volume: 15,
  futuresOi: 15,
  optionSr: 10,
  market: 5,
};

export interface ScoreLine {
  key: string;
  label: string;
  weight: number;
  value: number | null;
  evidence: string;
}

export type DataQuality = "COMPLETE" | "PARTIAL" | "INSUFFICIENT";

export interface ReversalResult {
  symbol: string;
  computedAt: string;
  category: ReversalCategory;
  categoryLabel: string;
  /** EARLY = evidence just tipped over; CONFIRMED = decisive. */
  stage: "EARLY" | "CONFIRMED" | "NONE";
  side: "OVERBOUGHT" | "OVERSOLD" | null;
  /* scores */
  reversalScore: number;
  continuationScore: number;
  reversalEdge: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  /* headline metrics for the table */
  ltp: number | null;
  changePct: number | null;
  rsi: number | null;
  rsiFast: number | null;
  vwapDistPct: number | null;
  vwapDistAtr: number | null;
  bbPercent: number | null;
  momentumLabel: string;
  oiPosition: string;
  oiChangePct: number | null;
  srContext: string;
  srDistancePct: number | null;
  primaryReason: string;
  /* breakdowns */
  reversalLines: ScoreLine[];
  continuationLines: ScoreLine[];
  reversalWhy: string[];
  continuationWhy: string[];
  /* detail panel */
  extreme: ExtremeState;
  exhaustion: ExhaustionState;
  priceAction: PriceActionState;
  volume: VolumeState;
  options: { support: string; resistance: string; pcr: number | null; note: string };
  liquidity: { note: string; buyerAbsorption: boolean | null; sellerAbsorption: boolean | null };
  /* quality & state */
  dataQuality: DataQuality;
  dataGaps: string[];
  dataStatus: string;
  rankable: boolean;
  events: { type: string; message: string }[];
}

/* ------------------------------- tracker --------------------------------- */

export interface ReversalTracker {
  category: ReversalCategory | null;
  reversalScore: number | null;
  lastEventAt: number | null;
}
export function newReversalTracker(): ReversalTracker {
  return { category: null, reversalScore: null, lastEventAt: null };
}

/* -------------------------------- input ---------------------------------- */

export interface ReversalInput {
  symbol: string;
  metrics: Stage1Metrics;
  candles1m: Candle[] | null;
  optionChain: OptionChainStrike[] | null;
  /** READ-ONLY output of the existing Dynamic S/R engine (never mutated). */
  dynamicSR: DynamicSRResult | null;
  /** READ-ONLY output of the existing Order Flow engine (never mutated). */
  orderFlow: OrderFlowResult | null;
  niftyChangePct: number | null;
  tracker: ReversalTracker;
  now: number;
  weights?: ReversalWeights;
  extremeConfig?: ExtremeConfig;
}

const num = (n: number) => (Number.isFinite(n) ? n : 0);

/* ================================ engine ================================= */

export function computeReversal(input: ReversalInput): ReversalResult {
  const W = input.weights ?? DEFAULT_REVERSAL_WEIGHTS;
  const XC = input.extremeConfig ?? DEFAULT_EXTREME_CONFIG;
  const m = input.metrics;
  const ltp = m.ltp;
  const gaps: string[] = [];
  const events: { type: string; message: string }[] = [];

  const shell = (category: ReversalCategory, reason: string, extreme?: ExtremeState): ReversalResult => ({
    symbol: input.symbol,
    computedAt: new Date(input.now).toISOString(),
    category, categoryLabel: CATEGORY_LABEL[category], stage: "NONE", side: extreme?.side ?? null,
    reversalScore: 0, continuationScore: 0, reversalEdge: 0, confidence: "LOW",
    ltp, changePct: m.returnDayPct,
    rsi: extreme?.rsi ?? null, rsiFast: extreme?.rsiFast ?? null,
    vwapDistPct: extreme?.vwapDistPct ?? null, vwapDistAtr: extreme?.vwapDistAtr ?? null,
    bbPercent: extreme?.bbPercent ?? null,
    momentumLabel: "N/A", oiPosition: m.futures.signal, oiChangePct: m.futures.oiChangePct,
    srContext: "N/A", srDistancePct: null, primaryReason: reason,
    reversalLines: [], continuationLines: [], reversalWhy: [], continuationWhy: [],
    extreme: extreme ?? {
      side: null, strong: false, factors: [], factorsHit: 0, score: 0, rsi: null, rsiFast: null,
      vwapDistPct: null, vwapDistAtr: null, bbPercent: null, bbWidthPct: null, bbExpanding: null,
      emaExtAtr: null, reason,
    },
    exhaustion: {
      score: null, divergence: { present: false, kind: "NONE", detail: "n/a", strength: 0 },
      macdWeakening: null, rocDecelerating: null, bodiesShrinking: null, volumeNotConfirming: null,
      details: [], macdState: { macd: null, signal: null, hist: null, histPrev: null, histSlope: null }, roc5: null, rocPrev5: null,
    },
    priceAction: { score: null, signals: [], rejectionWick: false, engulfing: false, failedNewExtreme: false, structureBreak: false, vwapFlip: false },
    volume: { score: null, ratio: null, climax: null, progressPerVolume: null, nonConfirmation: null, evidence: "n/a" },
    options: { support: "N/A", resistance: "N/A", pcr: null, note: "option chain unavailable" },
    liquidity: { note: "N/A", buyerAbsorption: null, sellerAbsorption: null },
    dataQuality: category === "INSUFFICIENT_DATA" ? "INSUFFICIENT" : "PARTIAL",
    dataGaps: [...gaps, reason], dataStatus: m.dataStatus, rankable: false, events,
  });

  /* ---------------------------- data quality ----------------------------- */
  const fresh = m.dataStatus === "LIVE" || m.dataStatus === "RECENT";
  if (!fresh) return shell("INSUFFICIENT_DATA", `${m.dataStatus} market data`);
  if (ltp == null || ltp <= 0) return shell("INSUFFICIENT_DATA", "live price unavailable");

  const c1 = input.candles1m ?? [];
  // 5-minute series is the analysis timeframe; fall back to 3-minute early in
  // the session so RSI/MACD become available sooner, else report insufficient.
  const c5 = aggregate(c1, 5);
  const c3 = aggregate(c1, 3);
  // Use the richest series available; 3-minute keeps the radar usable early
  // in the session instead of staying blank until ~2.5 hours of trading.
  const series = c5.length >= 26 ? c5 : c3.length >= 26 ? c3 : c1.length >= 40 ? c1 : null;
  const timeframe = c5.length >= 26 ? "5m" : c3.length >= 26 ? "3m" : c1.length >= 40 ? "1m" : null;
  if (!series) return shell("INSUFFICIENT_DATA", `only ${c1.length} one-minute candles — need ~40 to analyse`);

  // ATR reference: intraday average true range on the analysis timeframe
  const atrIntraday = (() => {
    const n = 14;
    if (series.length < n + 1) return null;
    const trs: number[] = [];
    for (let i = 1; i < series.length; i++) {
      const { h, l } = series[i];
      const pc = series[i - 1].c;
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    const s = trs.slice(-n);
    return s.reduce((a, b) => a + b, 0) / s.length;
  })();

  /* ------------------------ STAGE 1: extreme check ----------------------- */
  const extreme = detectExtreme(series, ltp, m.vwap, atrIntraday, m.returnDayPct, XC, m.rvol, m.dayHigh, m.dayLow);
  if (extreme.side == null) {
    const r = shell("NOT_STRETCHED", extreme.reason ?? "not stretched", extreme);
    // still record state so transitions out of a watch are detected
    if (input.tracker.category && input.tracker.category !== "NOT_STRETCHED") {
      events.push({ type: "REVERSAL_INVALIDATED", message: `${input.symbol} no longer stretched` });
    }
    input.tracker.category = "NOT_STRETCHED";
    input.tracker.reversalScore = null;
    return { ...r, events };
  }
  const side = extreme.side;
  const ob = side === "OVERBOUGHT";
  const dir = ob ? 1 : -1;

  /* --------------------- STAGE 2: reversal evidence ---------------------- */
  const exhaustion = detectExhaustion(series, side);
  const priceAction = detectPriceAction(series, side, ltp, m.vwap);
  const volume = detectVolumeExhaustion(series, side);

  /* -------- futures / OI positioning (reversal vs continuation) ---------- */
  const oiSignal = m.futures.signal;
  const oiPosition = oiSignal === "UNAVAILABLE" ? "UNAVAILABLE" : oiSignal.replaceAll("_", " ");
  const futRev = (() => {
    if (oiSignal === "UNAVAILABLE") { gaps.push("futures OI unavailable"); return { value: null as number | null, note: "futures OI unavailable" }; }
    if (oiSignal === "NEUTRAL") return { value: 45, note: "OI change insignificant" };
    // Overbought: unwinding longs = reversal evidence; fresh longs = continuation
    if (ob) {
      if (oiSignal === "LONG_UNWINDING") return { value: 92, note: "long unwinding while extended — positions being cut" };
      if (oiSignal === "SHORT_COVERING") return { value: 68, note: "rally driven by short covering rather than fresh longs" };
      if (oiSignal === "LONG_BUILDUP") return { value: 12, note: "fresh long buildup — positioning still supports upside" };
      return { value: 35, note: "short buildup against an extended market" };
    }
    if (oiSignal === "SHORT_COVERING") return { value: 92, note: "short covering while oversold — shorts being closed" };
    if (oiSignal === "LONG_UNWINDING") return { value: 62, note: "decline driven by long unwinding rather than fresh shorts" };
    if (oiSignal === "SHORT_BUILDUP") return { value: 12, note: "fresh short buildup — positioning still supports downside" };
    return { value: 35, note: "long buildup into an oversold market" };
  })();

  /* ---------- option-chain + existing S/R confluence (read-only) --------- */
  const optionCtx = analyseOptions(input.optionChain, ltp, side);
  if (!input.optionChain || input.optionChain.length === 0) gaps.push("option chain unavailable");

  const sr = input.dynamicSR;
  const srZone = ob ? sr?.nearestResistance ?? null : sr?.nearestSupport ?? null;
  const srDistancePct = ob ? sr?.distanceToResistancePct ?? null : sr?.distanceToSupportPct ?? null;
  const srContext = srZone
    ? `${ob ? "R" : "S"} ${srZone.level.toFixed(2)} (${srZone.confidence}%, ${srZone.statusLabel})`
    : sr ? "no qualifying zone" : "S/R unavailable";
  if (!sr) gaps.push("dynamic S/R not computed for this symbol");

  const srRev = (() => {
    if (!srZone || srDistancePct == null) return { value: null as number | null, note: srContext };
    const near = Math.abs(srDistancePct) <= 0.6;
    const strong = srZone.confidence >= 65;
    const weakening = srZone.status.includes("WEAKENING") || srZone.status.includes("BROKEN");
    // price into a CONFIRMED barrier = reversal evidence; a weakening/broken
    // barrier while price pushes through = continuation, not reversal
    if (weakening) return { value: 18, note: `${ob ? "resistance" : "support"} ${srZone.statusLabel.toLowerCase()} — barrier failing` };
    if (near && strong) return { value: 92, note: `price into strong ${ob ? "resistance" : "support"} ${srZone.level.toFixed(2)} (${srZone.confidence}%)` };
    if (near) return { value: 66, note: `approaching ${ob ? "resistance" : "support"} ${srZone.level.toFixed(2)}` };
    return { value: 40, note: `${ob ? "resistance" : "support"} ${Math.abs(srDistancePct).toFixed(2)}% away` };
  })();

  const optRev = (() => {
    if (optionCtx.bias == null) return { value: null as number | null, note: optionCtx.note };
    // bias is +1 bullish .. -1 bearish; reversal for overbought wants bearish
    const v = clamp(50 - dir * optionCtx.bias * 45, 0, 100);
    return { value: v, note: optionCtx.note };
  })();

  // combine option + S/R into the single 10% confluence component
  const optSrValue = (() => {
    const vals = [srRev.value, optRev.value].filter((x): x is number => x != null);
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  })();

  /* ---------------------------- market context --------------------------- */
  const marketRev = (() => {
    if (input.niftyChangePct == null) return { value: null as number | null, note: "index context unavailable" };
    const idx = input.niftyChangePct;
    // an extended stock fighting the index is likelier to revert
    const against = dir * idx < -0.1;
    const with_ = dir * idx > 0.1;
    if (against) return { value: 80, note: `index ${idx >= 0 ? "+" : ""}${idx.toFixed(2)}% against the move` };
    if (with_) return { value: 28, note: `index ${idx >= 0 ? "+" : ""}${idx.toFixed(2)}% supporting the move` };
    return { value: 50, note: `index flat (${idx.toFixed(2)}%)` };
  })();

  /* ---------------------------- REVERSAL SCORE --------------------------- */
  const reversalLines: ScoreLine[] = [
    { key: "extreme", label: "Extreme condition", weight: W.extreme, value: extreme.score, evidence: `${extreme.factorsHit}/${extreme.factors.length} extension factors${extreme.strong ? " · STRONG" : ""} · ${extreme.factors.filter((f) => f.hit).map((f) => f.label).join(", ")}` },
    { key: "exhaustion", label: "Momentum exhaustion", weight: W.exhaustion, value: exhaustion.score, evidence: exhaustion.details.join(" · ") },
    { key: "priceAction", label: "Price-action reversal", weight: W.priceAction, value: priceAction.score, evidence: priceAction.signals.join(" · ") },
    { key: "volume", label: "Volume / participation", weight: W.volume, value: volume.score, evidence: volume.evidence },
    { key: "futuresOi", label: "Futures / OI positioning", weight: W.futuresOi, value: futRev.value, evidence: futRev.note },
    { key: "optionSr", label: "Option-chain & S/R", weight: W.optionSr, value: optSrValue, evidence: `${srRev.note}${optRev.value != null ? ` · ${optRev.note}` : ""}` },
    { key: "market", label: "Market context", weight: W.market, value: marketRev.value, evidence: marketRev.note },
  ];

  let rUsed = 0, rAcc = 0, rTot = 0;
  for (const l of reversalLines) { rTot += l.weight; if (l.value == null) continue; rUsed += l.weight; rAcc += l.weight * l.value; }
  const rCoverage = rTot > 0 ? rUsed / rTot : 0;
  const reversalScore = rUsed > 0 ? Math.round((rAcc / rUsed) * Math.sqrt(rCoverage)) : 0;

  /* --------------------------- CONTINUATION SCORE ------------------------ */
  const closes = series.map((c) => c.c);
  const e9 = ema(closes, 9), e20 = ema(closes, 20);
  const ema9 = e9[e9.length - 1], ema20 = e20[e20.length - 1];
  const mac = macd(closes);
  const roc5 = roc(closes, 5);

  const trendStrength = ema9 != null && ema20 != null
    ? clamp(50 + dir * ((ema9 - ema20) / (atrIntraday || 1)) * 45, 0, 100) : null;
  const accel = m.priceAccel != null ? clamp(50 + dir * m.priceAccel * 60, 0, 100) : null;
  const volConfirm = volume.ratio != null ? clamp((volume.ratio / 2) * 100, 0, 100) : null;
  const oiBuild = (() => {
    if (oiSignal === "UNAVAILABLE") return null;
    if (ob) return oiSignal === "LONG_BUILDUP" ? 95 : oiSignal === "SHORT_COVERING" ? 60 : oiSignal === "LONG_UNWINDING" ? 10 : 35;
    return oiSignal === "SHORT_BUILDUP" ? 95 : oiSignal === "LONG_UNWINDING" ? 60 : oiSignal === "SHORT_COVERING" ? 10 : 35;
  })();
  const vwapHold = m.vwap != null && ltp != null ? (dir * (ltp - m.vwap) > 0 ? 88 : 20) : null;
  const bbExpand = extreme.bbExpanding == null ? null : extreme.bbExpanding ? 85 : 30;
  const marketAlign = marketRev.value == null ? null : 100 - marketRev.value;
  const srBreak = (() => {
    if (!srZone) return null;
    if (srZone.status.includes("BROKEN")) return 92;
    if (srZone.status.includes("WEAKENING")) return 74;
    if (srZone.status.includes("STRONG")) return 18;
    return 45;
  })();
  const macdRunning = mac.histSlope == null ? null : (dir * mac.histSlope > 0 ? 85 : 25);

  const continuationLines: ScoreLine[] = [
    { key: "trend", label: "Trend strength", weight: 18, value: trendStrength, evidence: ema9 != null && ema20 != null ? `EMA9 ${ema9.toFixed(2)} vs EMA20 ${ema20.toFixed(2)} (${timeframe})` : "EMA N/A" },
    { key: "accel", label: "Price acceleration", weight: 14, value: accel, evidence: m.priceAccel != null ? `accel ${m.priceAccel >= 0 ? "+" : ""}${m.priceAccel.toFixed(2)}%${roc5 != null ? ` · ROC ${roc5.toFixed(2)}%` : ""}` : "N/A" },
    { key: "volume", label: "Volume confirmation", weight: 14, value: volConfirm, evidence: volume.ratio != null ? `last bar ${volume.ratio.toFixed(2)}× average` : "N/A" },
    { key: "oi", label: "OI buildup", weight: 16, value: oiBuild, evidence: `${oiPosition}${m.futures.oiChangePct != null ? ` · ΔOI ${m.futures.oiChangePct >= 0 ? "+" : ""}${m.futures.oiChangePct.toFixed(2)}%` : ""}` },
    { key: "vwap", label: "VWAP position", weight: 10, value: vwapHold, evidence: m.vwap != null ? `price ${ltp >= m.vwap ? "above" : "below"} VWAP ${m.vwap.toFixed(2)}` : "N/A" },
    { key: "bb", label: "Bollinger expansion", weight: 8, value: bbExpand, evidence: extreme.bbExpanding == null ? "N/A" : extreme.bbExpanding ? "bands expanding (trend energy)" : "bands contracting" },
    { key: "macd", label: "MACD persistence", weight: 8, value: macdRunning, evidence: mac.hist != null ? `histogram ${mac.hist.toFixed(3)} (slope ${mac.histSlope?.toFixed(3) ?? "N/A"})` : "N/A" },
    { key: "srBreak", label: "S/R breakout", weight: 12, value: srBreak, evidence: srZone ? `${srZone.statusLabel} at ${srZone.level.toFixed(2)}` : "no zone" },
  ];

  let cUsed = 0, cAcc = 0, cTot = 0;
  for (const l of continuationLines) { cTot += l.weight; if (l.value == null) continue; cUsed += l.weight; cAcc += l.weight * l.value; }
  const cCoverage = cTot > 0 ? cUsed / cTot : 0;
  const continuationScore = cUsed > 0 ? Math.round((cAcc / cUsed) * Math.sqrt(cCoverage)) : 0;

  const reversalEdge = reversalScore - continuationScore;

  /* ------------------------------ category ------------------------------- */
  /*
   * EARLY-reversal staging. A name enters the watch list as soon as reversal
   * evidence merely EDGES OUT continuation (early), and is promoted when the
   * evidence is decisive (confirmed). Previously both thresholds were high,
   * which left the tab empty for most of the session.
   */
  const REVERSAL_MIN_EARLY = 46;
  const EDGE_MIN_EARLY = 2;
  const REVERSAL_MIN_CONFIRMED = 62;
  const EDGE_MIN_CONFIRMED = 14;

  const confirmed = reversalScore >= REVERSAL_MIN_CONFIRMED && reversalEdge >= EDGE_MIN_CONFIRMED;
  const early = reversalScore >= REVERSAL_MIN_EARLY && reversalEdge >= EDGE_MIN_EARLY;
  const stage: "EARLY" | "CONFIRMED" | "NONE" = confirmed ? "CONFIRMED" : early ? "EARLY" : "NONE";

  const category: ReversalCategory = (() => {
    const watch = confirmed || early;
    if (ob) return watch ? "OVERBOUGHT_REVERSAL_WATCH" : "OVERBOUGHT_CONTINUATION_RISK";
    return watch ? "OVERSOLD_REVERSAL_WATCH" : "OVERSOLD_CONTINUATION_RISK";
  })();

  /* ----------------------------- data quality ---------------------------- */
  const dataQuality: DataQuality =
    rCoverage >= 0.85 && gaps.length === 0 ? "COMPLETE" : rCoverage >= 0.5 ? "PARTIAL" : "INSUFFICIENT";

  const confidence: "HIGH" | "MEDIUM" | "LOW" = (() => {
    if (dataQuality === "INSUFFICIENT") return "LOW";
    const strongEvidence = [exhaustion.score, priceAction.score].filter((x): x is number => x != null && x >= 60).length;
    if (reversalEdge >= 20 && reversalScore >= 66 && strongEvidence >= 2) return "HIGH";
    if (reversalEdge >= 8 && reversalScore >= 52 && strongEvidence >= 1) return "MEDIUM";
    return "LOW";
  })();

  /* --------------------------- explanations ------------------------------ */
  const reversalWhy = reversalLines
    .filter((l) => l.value != null && l.value >= 60)
    .sort((a, b) => (b.value as number) - (a.value as number))
    .map((l) => `${l.label}: ${l.evidence}`);
  const continuationWhy = continuationLines
    .filter((l) => l.value != null && l.value >= 60)
    .sort((a, b) => (b.value as number) - (a.value as number))
    .map((l) => `${l.label}: ${l.evidence}`);

  const primaryReason = (() => {
    const top = reversalLines.filter((l) => l.value != null).sort((a, b) => (b.value as number) - (a.value as number))[0];
    if (category.includes("CONTINUATION_RISK")) {
      const c = continuationLines.filter((l) => l.value != null).sort((a, b) => (b.value as number) - (a.value as number))[0];
      return c ? `Trend intact — ${c.label.toLowerCase()}` : "continuation evidence dominates";
    }
    if (!top) return "insufficient evidence";
    if (exhaustion.divergence.present) return `${exhaustion.divergence.kind === "BEARISH" ? "Bearish" : "Bullish"} divergence + ${top.label.toLowerCase()}`;
    return `${top.label} — ${top.evidence.split(" · ")[0]}`;
  })();

  const momentumLabel = (() => {
    if (exhaustion.divergence.present) return `${exhaustion.divergence.kind === "BEARISH" ? "Bearish" : "Bullish"} divergence`;
    if (exhaustion.macdWeakening === true) return "Weakening";
    if (macdRunning != null && macdRunning >= 80) return "Strong";
    return "Neutral";
  })();

  /* -------------------------- state transitions -------------------------- */
  const prev = input.tracker;
  if (prev.category !== category) {
    if (category === "OVERBOUGHT_REVERSAL_WATCH" || category === "OVERSOLD_REVERSAL_WATCH") {
      events.push({ type: `${side}_REVERSAL_CONFIRMED`, message: `${input.symbol} ${CATEGORY_LABEL[category]} (rev ${reversalScore} vs cont ${continuationScore})` });
    } else if (prev.category?.includes("REVERSAL_WATCH")) {
      events.push({ type: "REVERSAL_INVALIDATED", message: `${input.symbol} reversal evidence no longer dominant` });
    } else if (category.includes("CONTINUATION_RISK")) {
      events.push({ type: "CONTINUATION_DOMINATING", message: `${input.symbol} extreme but continuation dominates (edge ${reversalEdge})` });
    }
  } else if (prev.reversalScore != null && reversalScore - prev.reversalScore >= 10) {
    events.push({ type: "REVERSAL_CONFIDENCE_INCREASED", message: `${input.symbol} reversal evidence ${prev.reversalScore} → ${reversalScore}` });
  }
  if (extreme.strong && category.includes("CONTINUATION_RISK") && prev.category !== category) {
    events.push({ type: "EXTREME_WITHOUT_CONFIRMATION", message: `${input.symbol} strongly ${side.toLowerCase()} with no reversal confirmation` });
  }
  input.tracker.category = category;
  input.tracker.reversalScore = reversalScore;
  if (events.length) input.tracker.lastEventAt = input.now;

  const rankable = dataQuality !== "INSUFFICIENT" && fresh;

  return {
    symbol: input.symbol,
    computedAt: new Date(input.now).toISOString(),
    category, categoryLabel: CATEGORY_LABEL[category], stage, side,
    reversalScore: num(reversalScore), continuationScore: num(continuationScore), reversalEdge: num(reversalEdge),
    confidence,
    ltp, changePct: m.returnDayPct,
    rsi: extreme.rsi, rsiFast: extreme.rsiFast,
    vwapDistPct: extreme.vwapDistPct, vwapDistAtr: extreme.vwapDistAtr,
    bbPercent: extreme.bbPercent,
    momentumLabel, oiPosition, oiChangePct: m.futures.oiChangePct,
    srContext, srDistancePct,
    primaryReason,
    reversalLines, continuationLines, reversalWhy, continuationWhy,
    extreme, exhaustion, priceAction, volume,
    options: optionCtx.view,
    liquidity: {
      note: input.orderFlow ? `buy-side ${input.orderFlow.buyerScore} / sell-side ${input.orderFlow.sellerScore}` : "order-flow unavailable",
      buyerAbsorption: input.orderFlow?.buyerAbsorption ?? null,
      sellerAbsorption: input.orderFlow?.sellerAbsorption ?? null,
    },
    dataQuality, dataGaps: gaps, dataStatus: m.dataStatus, rankable, events,
  };
}

/* ------------------------- option-chain analysis ------------------------- */

function analyseOptions(
  chain: OptionChainStrike[] | null, spot: number, side: "OVERBOUGHT" | "OVERSOLD",
): { bias: number | null; note: string; view: ReversalResult["options"] } {
  const blank = { bias: null, note: "option chain unavailable", view: { support: "N/A", resistance: "N/A", pcr: null, note: "option chain unavailable" } };
  if (!chain || chain.length === 0 || spot <= 0) return blank;
  const rows = chain.filter((s) => s.strike_price != null && Math.abs((s.strike_price as number) - spot) / spot <= 0.05);
  if (!rows.length) return blank;

  let ceOi = 0, peOi = 0, ceChg = 0, peChg = 0;
  let ceChgKnown = false, peChgKnown = false;
  let bestCe: { k: number; oi: number } | null = null;
  let bestPe: { k: number; oi: number } | null = null;
  for (const r of rows) {
    const k = r.strike_price as number;
    const ce = r.call_options?.market_data;
    const pe = r.put_options?.market_data;
    if (ce?.oi != null) {
      ceOi += ce.oi;
      if (k >= spot * 0.995 && (!bestCe || ce.oi > bestCe.oi)) bestCe = { k, oi: ce.oi };
      if (ce.prev_oi != null) { ceChg += ce.oi - ce.prev_oi; ceChgKnown = true; }
    }
    if (pe?.oi != null) {
      peOi += pe.oi;
      if (k <= spot * 1.005 && (!bestPe || pe.oi > bestPe.oi)) bestPe = { k, oi: pe.oi };
      if (pe.prev_oi != null) { peChg += pe.oi - pe.prev_oi; peChgKnown = true; }
    }
  }
  if (ceOi <= 0 && peOi <= 0) return blank;
  const pcr = ceOi > 0 ? peOi / ceOi : null;

  // bias: +1 bullish positioning .. -1 bearish positioning
  let bias = 0;
  const bits: string[] = [];
  if (pcr != null) { bias += clamp((pcr - 1) * 0.5, -0.35, 0.35); bits.push(`PCR ${pcr.toFixed(2)}`); }
  if (ceChgKnown || peChgKnown) {
    const base = Math.max(ceOi, peOi, 1);
    bias += clamp((peChg / base) * 3, -0.4, 0.4);   // PE writing = bullish
    bias -= clamp((ceChg / base) * 3, -0.4, 0.4);   // CE writing = bearish
    if (ceChgKnown) bits.push(`CE OI ${ceChg >= 0 ? "+" : ""}${(ceChg / 1000).toFixed(0)}K${ceChg > 0 ? " (writing)" : ceChg < 0 ? " (unwinding)" : ""}`);
    if (peChgKnown) bits.push(`PE OI ${peChg >= 0 ? "+" : ""}${(peChg / 1000).toFixed(0)}K${peChg > 0 ? " (writing)" : peChg < 0 ? " (unwinding)" : ""}`);
  }
  bias = clamp(bias, -1, 1);

  const note = side === "OVERBOUGHT"
    ? `${bits.join(" · ")}${bias < -0.1 ? " — positioning turning bearish" : bias > 0.1 ? " — positioning still bullish" : ""}`
    : `${bits.join(" · ")}${bias > 0.1 ? " — positioning turning bullish" : bias < -0.1 ? " — positioning still bearish" : ""}`;

  return {
    bias,
    note: note || "option OI present",
    view: {
      support: bestPe ? `PE ${bestPe.k} (${(bestPe.oi / 1000).toFixed(0)}K)` : "N/A",
      resistance: bestCe ? `CE ${bestCe.k} (${(bestCe.oi / 1000).toFixed(0)}K)` : "N/A",
      pcr,
      note: note || "option OI present",
    },
  };
}
