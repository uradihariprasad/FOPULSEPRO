/**
 * REVERSAL RADAR — detector layer (independent module)
 *
 * Pure, read-only analytics used exclusively by the Reversal Radar tab.
 * Nothing here mutates or re-implements an existing engine: shared maths
 * (EMA / ATR / Bollinger / aggregation) is imported from the existing
 * indicator library, and all market inputs are supplied by the caller.
 *
 * Contains:
 *   RSI (Wilder) · MACD · ROC · pivots · divergence
 *   extreme detector · momentum-exhaustion detector
 *   price-action reversal detector · volume/participation detector
 */

import type { Candle } from "../types";
import { bollingerSeries, clamp, ema } from "../indicators";

/* ------------------------------ primitives ------------------------------- */

/** Wilder RSI series (same length as input; null until seeded). */
export function rsiSeries(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface MacdState {
  macd: number | null;
  signal: number | null;
  hist: number | null;
  histPrev: number | null;
  histSlope: number | null; // hist - histPrev
}

export function macd(closes: number[], fast = 12, slow = 26, sig = 9): MacdState {
  if (closes.length < slow + sig) return { macd: null, signal: null, hist: null, histPrev: null, histSlope: null };
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const a = ef[i], b = es[i];
    if (a == null || b == null) continue;
    line.push(a - b);
  }
  if (line.length < sig + 2) return { macd: null, signal: null, hist: null, histPrev: null, histSlope: null };
  const sigArr = ema(line, sig);
  const n = line.length - 1;
  const s = sigArr[n], sPrev = sigArr[n - 1];
  if (s == null || sPrev == null) return { macd: null, signal: null, hist: null, histPrev: null, histSlope: null };
  const hist = line[n] - s;
  const histPrev = line[n - 1] - sPrev;
  return { macd: line[n], signal: s, hist, histPrev, histSlope: hist - histPrev };
}

/** Rate of change over `n` bars, in %. */
export function roc(closes: number[], n: number): number | null {
  if (closes.length <= n) return null;
  const a = closes[closes.length - 1 - n];
  if (!Number.isFinite(a) || a === 0) return null;
  return ((closes[closes.length - 1] - a) / a) * 100;
}

/** Fractal pivot indices. */
export function pivots(values: number[], strength: number, kind: "HIGH" | "LOW"): number[] {
  const out: number[] = [];
  for (let i = strength; i < values.length - strength; i++) {
    let ok = true;
    for (let j = 1; j <= strength; j++) {
      if (kind === "HIGH" && (values[i - j] >= values[i] || values[i + j] >= values[i])) { ok = false; break; }
      if (kind === "LOW" && (values[i - j] <= values[i] || values[i + j] <= values[i])) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

export interface Divergence {
  present: boolean;
  kind: "BEARISH" | "BULLISH" | "NONE";
  detail: string;
  strength: number; // 0-1
}

/**
 * Classic divergence: price makes a higher high while the oscillator makes a
 * lower high (bearish), or price makes a lower low while the oscillator makes
 * a higher low (bullish). Requires two confirmed pivots.
 */
export function divergence(
  highs: number[], lows: number[], osc: (number | null)[], side: "OVERBOUGHT" | "OVERSOLD",
): Divergence {
  const none: Divergence = { present: false, kind: "NONE", detail: "no confirmed divergence", strength: 0 };
  const strength = 2;
  if (side === "OVERBOUGHT") {
    const ph = pivots(highs, strength, "HIGH").filter((i) => osc[i] != null).slice(-2);
    if (ph.length < 2) return { ...none, detail: "insufficient pivots for divergence" };
    const [a, b] = ph;
    const priceHH = highs[b] > highs[a];
    const oscLH = (osc[b] as number) < (osc[a] as number);
    if (priceHH && oscLH) {
      const gap = (osc[a] as number) - (osc[b] as number);
      return {
        present: true, kind: "BEARISH",
        detail: `price HH ${highs[a].toFixed(2)}→${highs[b].toFixed(2)} vs RSI LH ${(osc[a] as number).toFixed(0)}→${(osc[b] as number).toFixed(0)}`,
        strength: clamp(gap / 12, 0.2, 1),
      };
    }
    return { ...none, detail: priceHH ? "price HH with RSI confirming (no divergence)" : "no higher high" };
  }
  const pl = pivots(lows, strength, "LOW").filter((i) => osc[i] != null).slice(-2);
  if (pl.length < 2) return { ...none, detail: "insufficient pivots for divergence" };
  const [a, b] = pl;
  const priceLL = lows[b] < lows[a];
  const oscHL = (osc[b] as number) > (osc[a] as number);
  if (priceLL && oscHL) {
    const gap = (osc[b] as number) - (osc[a] as number);
    return {
      present: true, kind: "BULLISH",
      detail: `price LL ${lows[a].toFixed(2)}→${lows[b].toFixed(2)} vs RSI HL ${(osc[a] as number).toFixed(0)}→${(osc[b] as number).toFixed(0)}`,
      strength: clamp(gap / 12, 0.2, 1),
    };
  }
  return { ...none, detail: priceLL ? "price LL with RSI confirming (no divergence)" : "no lower low" };
}

/* --------------------------- extreme detector ---------------------------- */

export interface ExtremeConfig {
  rsiOverbought: number;
  rsiStrongOverbought: number;
  rsiOversold: number;
  rsiStrongOversold: number;
  vwapAtrExtension: number; // |price-vwap| / ATR considered stretched
  bbPercentHigh: number;    // %B considered stretched (0-1 scale)
  bbPercentLow: number;
  rvolExpansion: number;    // participation expansion considered abnormal
  rangeExpansionAtr: number;// day range measured in ATR units
  minFactors: number;       // how many factors must agree
}

export const DEFAULT_EXTREME_CONFIG: ExtremeConfig = {
  // EARLY-reversal tuning: a stock is "stretched enough to watch" well before
  // it prints a textbook 70/30 RSI. Strong tiers remain for high conviction.
  rsiOverbought: 62,
  rsiStrongOverbought: 72,
  rsiOversold: 38,
  rsiStrongOversold: 28,
  vwapAtrExtension: 0.7,
  bbPercentHigh: 0.78,
  bbPercentLow: 0.22,
  rvolExpansion: 1.2,
  rangeExpansionAtr: 8,
  minFactors: 2,
};

export interface ExtremeState {
  side: "OVERBOUGHT" | "OVERSOLD" | null;
  strong: boolean;
  factors: { key: string; label: string; hit: boolean; value: number | null; evidence: string }[];
  factorsHit: number;
  score: number;            // 0-100 how stretched
  rsi: number | null;
  rsiFast: number | null;
  vwapDistPct: number | null;
  vwapDistAtr: number | null;
  bbPercent: number | null; // 0-1
  bbWidthPct: number | null;
  bbExpanding: boolean | null;
  emaExtAtr: number | null;
  reason: string | null;
}

export function detectExtreme(
  candles: Candle[], ltp: number, vwap: number | null, atrRef: number | null,
  returnDayPct: number | null, cfg: ExtremeConfig,
  rvol?: number | null, dayHigh?: number | null, dayLow?: number | null,
): ExtremeState {
  const empty = (reason: string): ExtremeState => ({
    side: null, strong: false, factors: [], factorsHit: 0, score: 0,
    rsi: null, rsiFast: null, vwapDistPct: null, vwapDistAtr: null,
    bbPercent: null, bbWidthPct: null, bbExpanding: null, emaExtAtr: null, reason,
  });
  if (candles.length < 20) return empty("insufficient candle history");

  const closes = candles.map((c) => c.c);
  const r14 = rsiSeries(closes, 14);
  const r7 = rsiSeries(closes, 7);
  const rsi = r14[r14.length - 1];
  const rsiFast = r7[r7.length - 1];

  const bb = bollingerSeries(closes, 20, 2);
  const bbNow = bb[bb.length - 1];
  const bbPrev = bb.length > 6 ? bb[bb.length - 6] : null;
  const bbPercent = bbNow && bbNow.upper > bbNow.lower ? clamp((ltp - bbNow.lower) / (bbNow.upper - bbNow.lower), -0.5, 1.5) : null;
  const bbWidthPct = bbNow && bbNow.mid > 0 ? ((bbNow.upper - bbNow.lower) / bbNow.mid) * 100 : null;
  const bbExpanding = bbNow && bbPrev ? (bbNow.upper - bbNow.lower) > (bbPrev.upper - bbPrev.lower) * 1.03 : null;

  const vwapDistPct = vwap != null && vwap > 0 ? ((ltp - vwap) / vwap) * 100 : null;
  const vwapDistAtr = vwap != null && atrRef != null && atrRef > 0 ? (ltp - vwap) / atrRef : null;

  const e20 = ema(closes, 20);
  const ema20 = e20[e20.length - 1];
  const emaExtAtr = ema20 != null && atrRef != null && atrRef > 0 ? (ltp - ema20) / atrRef : null;

  /*
   * Which side the stock is stretched toward is decided by a VOTE across
   * independent measures — never by RSI alone (an early reversal naturally
   * pulls RSI back toward 50 while the stock is still stretched).
   */
  const votes =
    (returnDayPct != null ? Math.sign(returnDayPct) * 2 : 0) +
    (vwapDistAtr != null ? Math.sign(vwapDistAtr) : 0) +
    (emaExtAtr != null ? Math.sign(emaExtAtr) : 0) +
    (rsi != null ? Math.sign(rsi - 50) : 0);
  const side: "OVERBOUGHT" | "OVERSOLD" = votes >= 0 ? "OVERBOUGHT" : "OVERSOLD";
  const dir = side === "OVERBOUGHT" ? 1 : -1;

  const factors = [
    {
      key: "rsi", label: "RSI extreme",
      hit: rsi != null && (side === "OVERBOUGHT" ? rsi >= cfg.rsiOverbought : rsi <= cfg.rsiOversold),
      value: rsi, evidence: rsi == null ? "RSI N/A" : `RSI(14) ${rsi.toFixed(1)}${rsiFast != null ? ` · RSI(7) ${rsiFast.toFixed(1)}` : ""}`,
    },
    {
      key: "vwap", label: "VWAP extension",
      hit: vwapDistAtr != null && dir * vwapDistAtr >= cfg.vwapAtrExtension,
      value: vwapDistAtr,
      evidence: vwapDistAtr == null ? "VWAP/ATR N/A" : `${vwapDistAtr >= 0 ? "+" : ""}${vwapDistAtr.toFixed(2)} ATR from VWAP (${vwapDistPct != null ? `${vwapDistPct >= 0 ? "+" : ""}${vwapDistPct.toFixed(2)}%` : "N/A"})`,
    },
    {
      key: "bb", label: "Bollinger position",
      hit: bbPercent != null && (side === "OVERBOUGHT" ? bbPercent >= cfg.bbPercentHigh : bbPercent <= cfg.bbPercentLow),
      value: bbPercent, evidence: bbPercent == null ? "BB N/A" : `%B ${(bbPercent * 100).toFixed(0)}%${bbExpanding != null ? ` · bands ${bbExpanding ? "expanding" : "contracting"}` : ""}`,
    },
    {
      key: "ema", label: "ATR extension from EMA20",
      hit: emaExtAtr != null && dir * emaExtAtr >= cfg.vwapAtrExtension * 0.8,
      value: emaExtAtr, evidence: emaExtAtr == null ? "N/A" : `${emaExtAtr >= 0 ? "+" : ""}${emaExtAtr.toFixed(2)} ATR from EMA20`,
    },
    {
      key: "return", label: "Day return",
      hit: returnDayPct != null && dir * returnDayPct >= 2.0,
      value: returnDayPct, evidence: returnDayPct == null ? "N/A" : `${returnDayPct >= 0 ? "+" : ""}${returnDayPct.toFixed(2)}% on the day`,
    },
    {
      key: "volumeExp", label: "Volume expansion",
      hit: rvol != null && rvol >= cfg.rvolExpansion,
      value: rvol ?? null, evidence: rvol == null ? "RVOL N/A" : `RVOL ${rvol.toFixed(2)}x`,
    },
    {
      key: "rangeExp", label: "Range expansion",
      hit: dayHigh != null && dayLow != null && atrRef != null && atrRef > 0 && (dayHigh - dayLow) / atrRef >= cfg.rangeExpansionAtr,
      value: dayHigh != null && dayLow != null && atrRef != null && atrRef > 0 ? (dayHigh - dayLow) / atrRef : null,
      evidence: dayHigh != null && dayLow != null && atrRef != null && atrRef > 0
        ? `day range ${((dayHigh - dayLow) / atrRef).toFixed(1)}× ATR`
        : "day range N/A",
    },
  ];

  const factorsHit = factors.filter((f) => f.hit).length;
  const strong = rsi != null && (side === "OVERBOUGHT" ? rsi >= cfg.rsiStrongOverbought : rsi <= cfg.rsiStrongOversold);
  const score = Math.round(clamp((factorsHit / factors.length) * 100, 0, 100));

  if (factorsHit < cfg.minFactors) {
    return {
      side: null, strong: false, factors, factorsHit, score,
      rsi, rsiFast, vwapDistPct, vwapDistAtr, bbPercent, bbWidthPct, bbExpanding, emaExtAtr,
      reason: `only ${factorsHit}/${cfg.minFactors} extension factors met — not stretched`,
    };
  }
  return {
    side, strong, factors, factorsHit, score,
    rsi, rsiFast, vwapDistPct, vwapDistAtr, bbPercent, bbWidthPct, bbExpanding, emaExtAtr, reason: null,
  };
}

/* -------------------------- exhaustion detector -------------------------- */

export interface ExhaustionState {
  score: number | null;   // 0-100 evidence that momentum is failing
  divergence: Divergence;
  macdWeakening: boolean | null;
  rocDecelerating: boolean | null;
  bodiesShrinking: boolean | null;
  volumeNotConfirming: boolean | null;
  details: string[];
  macdState: MacdState;
  roc5: number | null;
  rocPrev5: number | null;
}

export function detectExhaustion(candles: Candle[], side: "OVERBOUGHT" | "OVERSOLD"): ExhaustionState {
  const details: string[] = [];
  if (candles.length < 30) {
    return {
      score: null, divergence: { present: false, kind: "NONE", detail: "insufficient history", strength: 0 },
      macdWeakening: null, rocDecelerating: null, bodiesShrinking: null, volumeNotConfirming: null,
      details: ["insufficient history for exhaustion analysis"],
      macdState: { macd: null, signal: null, hist: null, histPrev: null, histSlope: null }, roc5: null, rocPrev5: null,
    };
  }
  const closes = candles.map((c) => c.c);
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  const dir = side === "OVERBOUGHT" ? 1 : -1;

  const rsi = rsiSeries(closes, 14);
  const div = divergence(highs, lows, rsi, side);
  if (div.present) details.push(`${div.kind.toLowerCase()} divergence: ${div.detail}`);

  const mac = macd(closes);
  // weakening = histogram moving against the prevailing direction
  const macdWeakening = mac.histSlope == null ? null : dir * mac.histSlope < 0;
  if (macdWeakening) details.push(`MACD histogram ${dir > 0 ? "falling" : "rising"} (${mac.hist?.toFixed(3) ?? "N/A"})`);

  const roc5 = roc(closes, 5);
  const rocPrev5 = closes.length > 11 ? roc(closes.slice(0, -5), 5) : null;
  const rocDecelerating = roc5 != null && rocPrev5 != null ? dir * roc5 < dir * rocPrev5 : null;
  if (rocDecelerating) details.push(`ROC decelerating ${rocPrev5!.toFixed(2)}% → ${roc5!.toFixed(2)}%`);

  const bodyOf = (c: Candle) => Math.abs(c.c - c.o);
  const recentBodies = candles.slice(-4).map(bodyOf);
  const priorBodies = candles.slice(-12, -4).map(bodyOf);
  const rb = recentBodies.reduce((a, b) => a + b, 0) / (recentBodies.length || 1);
  const pb = priorBodies.reduce((a, b) => a + b, 0) / (priorBodies.length || 1);
  const bodiesShrinking = pb > 0 ? rb < pb * 0.7 : null;
  if (bodiesShrinking) details.push(`candle bodies shrinking (${rb.toFixed(2)} vs ${pb.toFixed(2)})`);

  // new extreme without volume confirmation
  const volumeNotConfirming = (() => {
    const win = candles.slice(-20);
    if (win.length < 12) return null;
    const extIdx = side === "OVERBOUGHT"
      ? win.reduce((b, c, i) => (c.h > win[b].h ? i : b), 0)
      : win.reduce((b, c, i) => (c.l < win[b].l ? i : b), 0);
    if (extIdx < win.length - 6) return null; // extreme is not recent
    const extVol = win[extIdx].v;
    const avgVol = win.reduce((a, c) => a + c.v, 0) / win.length;
    if (avgVol <= 0) return null;
    const notConfirmed = extVol < avgVol * 1.05;
    if (notConfirmed) details.push(`new ${side === "OVERBOUGHT" ? "high" : "low"} on ${(extVol / avgVol).toFixed(2)}× average volume (not confirmed)`);
    return notConfirmed;
  })();

  const parts = [
    // Divergence is a BONUS signal: when present it is powerful evidence, but
    // its absence must not zero-out the average (other exhaustion signals are
    // independently valid). Insufficient pivot data excludes it entirely.
    div.present ? 100 * div.strength
      : div.detail.includes("insufficient") ? null
      : 30,
    macdWeakening === true ? 100 : macdWeakening === false ? 20 : null,
    rocDecelerating === true ? 100 : rocDecelerating === false ? 20 : null,
    bodiesShrinking === true ? 100 : bodiesShrinking === false ? 30 : null,
    volumeNotConfirming === true ? 100 : volumeNotConfirming === false ? 25 : null,
  ].filter((x): x is number => x != null);
  const score = parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length) : null;
  if (!details.length) details.push("momentum still intact — no exhaustion evidence");

  return { score, divergence: div, macdWeakening, rocDecelerating, bodiesShrinking, volumeNotConfirming, details, macdState: mac, roc5, rocPrev5 };
}

/* ----------------------- price-action reversal --------------------------- */

export interface PriceActionState {
  score: number | null;
  signals: string[];
  rejectionWick: boolean;
  engulfing: boolean;
  failedNewExtreme: boolean;
  structureBreak: boolean;
  vwapFlip: boolean;
}

export function detectPriceAction(
  candles: Candle[], side: "OVERBOUGHT" | "OVERSOLD", ltp: number, vwap: number | null,
): PriceActionState {
  const signals: string[] = [];
  if (candles.length < 12) {
    return { score: null, signals: ["insufficient candles for price action"], rejectionWick: false, engulfing: false, failedNewExtreme: false, structureBreak: false, vwapFlip: false };
  }
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const range = last.h - last.l;
  const body = Math.abs(last.c - last.o);
  const ob = side === "OVERBOUGHT";

  const upWick = last.h - Math.max(last.c, last.o);
  const dnWick = Math.min(last.c, last.o) - last.l;
  const rejectionWick = range > 0 && (ob ? upWick > range * 0.45 && upWick > body : dnWick > range * 0.45 && dnWick > body);
  if (rejectionWick) signals.push(ob ? "upper-wick rejection on the latest bar" : "lower-wick rejection on the latest bar");

  const engulfing = ob
    ? last.c < last.o && prev.c > prev.o && last.c <= prev.o && last.o >= prev.c
    : last.c > last.o && prev.c < prev.o && last.c >= prev.o && last.o <= prev.c;
  if (engulfing) signals.push(ob ? "bearish engulfing candle" : "bullish engulfing candle");

  const win = candles.slice(-12);
  const extreme = ob ? Math.max(...win.map((c) => c.h)) : Math.min(...win.map((c) => c.l));
  const recent3 = candles.slice(-3);
  const failedNewExtreme = ob
    ? Math.max(...recent3.map((c) => c.h)) < extreme * 0.9995
    : Math.min(...recent3.map((c) => c.l)) > extreme * 1.0005;
  if (failedNewExtreme) signals.push(ob ? `failed to make a new high (peak ${extreme.toFixed(2)})` : `failed to make a new low (trough ${extreme.toFixed(2)})`);

  // short-term structure break: close beyond the most recent opposite pivot
  const structureBreak = (() => {
    const lows = win.map((c) => c.l);
    const highs = win.map((c) => c.h);
    if (ob) {
      const pl = pivots(lows, 1, "LOW");
      const lvl = pl.length ? lows[pl[pl.length - 1]] : Math.min(...lows.slice(0, -1));
      const broke = last.c < lvl;
      if (broke) signals.push(`closed below short-term support ${lvl.toFixed(2)}`);
      return broke;
    }
    const ph = pivots(highs, 1, "HIGH");
    const lvl = ph.length ? highs[ph[ph.length - 1]] : Math.max(...highs.slice(0, -1));
    const broke = last.c > lvl;
    if (broke) signals.push(`closed above short-term resistance ${lvl.toFixed(2)}`);
    return broke;
  })();

  const vwapFlip = (() => {
    if (vwap == null) return false;
    const wasBeyond = candles.slice(-8, -1).some((c) => (ob ? c.c > vwap : c.c < vwap));
    const nowFlipped = ob ? ltp < vwap : ltp > vwap;
    const flip = wasBeyond && nowFlipped;
    if (flip) signals.push(ob ? "lost VWAP after extended upside" : "reclaimed VWAP after extended downside");
    return flip;
  })();

  const hits = [rejectionWick, engulfing, failedNewExtreme, structureBreak, vwapFlip].filter(Boolean).length;
  const score = Math.round(clamp((hits / 5) * 100 + (hits >= 2 ? 10 : 0), 0, 100));
  if (!signals.length) signals.push("no reversal price action yet");
  return { score, signals, rejectionWick, engulfing, failedNewExtreme, structureBreak, vwapFlip };
}

/* ------------------------ volume / participation ------------------------- */

export interface VolumeState {
  score: number | null;
  ratio: number | null;      // last bar vs average
  climax: boolean | null;
  progressPerVolume: number | null;
  nonConfirmation: boolean | null;
  evidence: string;
}

export function detectVolumeExhaustion(candles: Candle[], side: "OVERBOUGHT" | "OVERSOLD"): VolumeState {
  if (candles.length < 15) {
    return { score: null, ratio: null, climax: null, progressPerVolume: null, nonConfirmation: null, evidence: "insufficient volume history" };
  }
  const lastV = candles[candles.length - 1].v;
  const prior = candles.slice(-11, -1).map((c) => c.v);
  const avg = prior.reduce((a, b) => a + b, 0) / (prior.length || 1);
  const ratio = avg > 0 ? lastV / avg : null;
  const climax = ratio != null ? ratio >= 2.5 : null;

  // price progress achieved per unit of volume — falling = effort without result
  const seg = (from: number, to: number) => {
    const s = candles.slice(from, to);
    const move = Math.abs(s[s.length - 1].c - s[0].o);
    const vol = s.reduce((a, c) => a + c.v, 0);
    return vol > 0 ? move / vol : null;
  };
  const recentPPV = seg(candles.length - 6, candles.length);
  const priorPPV = seg(candles.length - 14, candles.length - 6);
  const progressPerVolume = recentPPV;
  const efficiencyFalling = recentPPV != null && priorPPV != null && priorPPV > 0 ? recentPPV < priorPPV * 0.7 : null;

  const win = candles.slice(-20);
  const extIdx = side === "OVERBOUGHT"
    ? win.reduce((b, c, i) => (c.h > win[b].h ? i : b), 0)
    : win.reduce((b, c, i) => (c.l < win[b].l ? i : b), 0);
  const avgAll = win.reduce((a, c) => a + c.v, 0) / win.length;
  const nonConfirmation = avgAll > 0 ? win[extIdx].v < avgAll : null;

  const parts = [
    climax === true ? 85 : climax === false ? 40 : null,
    efficiencyFalling === true ? 95 : efficiencyFalling === false ? 25 : null,
    nonConfirmation === true ? 90 : nonConfirmation === false ? 30 : null,
  ].filter((x): x is number => x != null);
  const score = parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length) : null;

  const bits: string[] = [];
  if (ratio != null) bits.push(`last bar ${ratio.toFixed(2)}× avg`);
  if (climax) bits.push("climax volume");
  if (efficiencyFalling) bits.push("price progress per unit volume falling");
  if (nonConfirmation) bits.push(`${side === "OVERBOUGHT" ? "high" : "low"} made on below-average volume`);
  return { score, ratio, climax, progressPerVolume, nonConfirmation, evidence: bits.join(" · ") || "volume behaviour neutral" };
}
