/** Deterministic technical indicators computed from real candle arrays. */

import type { Candle } from "./types";

export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function lastEma(values: number[], period: number): number | null {
  const e = ema(values, period);
  return e[e.length - 1] ?? null;
}

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

export function stddev(values: number[], period: number): number | null {
  const m = sma(values, period);
  if (m === null) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += (values[i] - m) ** 2;
  return Math.sqrt(s / period);
}

export interface BollingerBand {
  mid: number;
  upper: number;
  lower: number;
}

export function bollingerSeries(values: number[], period = 20, mult = 2): (BollingerBand | null)[] {
  const out: (BollingerBand | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    const slice = values.slice(0, i + 1);
    const m = sma(slice, period);
    const sd = stddev(slice, period);
    if (m === null || sd === null) {
      out.push(null);
      continue;
    }
    out.push({ mid: m, upper: m + mult * sd, lower: m - mult * sd });
  }
  return out;
}

/** Session VWAP from 1-minute candles (all real OHLCV). */
export function vwapSeries(candles: Candle[]): (number | null)[] {
  let pv = 0;
  let vv = 0;
  return candles.map((c) => {
    const tp = (c.h + c.l + c.c) / 3;
    pv += tp * c.v;
    vv += c.v;
    return vv > 0 ? pv / vv : null;
  });
}

/** Aggregate 1-minute candles into N-minute candles (real data re-binned). */
export function aggregate(candles: Candle[], minutes: number): Candle[] {
  if (minutes <= 1) return candles;
  const buckets = new Map<number, Candle>();
  for (const c of candles) {
    const d = new Date(c.t);
    d.setSeconds(0, 0);
    const m = d.getUTCMinutes() - (d.getUTCMinutes() % minutes);
    d.setUTCMinutes(m);
    // Align to the exchange session grid using candle timestamps directly.
    const key = d.getTime();
    const ex = buckets.get(key);
    if (!ex) {
      buckets.set(key, { t: key, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, oi: c.oi ?? null });
    } else {
      ex.h = Math.max(ex.h, c.h);
      ex.l = Math.min(ex.l, c.l);
      ex.c = c.c;
      ex.v += c.v;
      if (c.oi != null) ex.oi = c.oi;
    }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

export interface SwingPoint {
  index: number;
  time: number;
  price: number;
  kind: "HIGH" | "LOW";
}

/** Fractal swing detection: a pivot needs `strength` lower/higher neighbors. */
export function swings(candles: Candle[], strength = 3): SwingPoint[] {
  const out: SwingPoint[] = [];
  for (let i = strength; i < candles.length - strength; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= strength; j++) {
      if (candles[i - j].h >= c.h || candles[i + j].h >= c.h) isHigh = false;
      if (candles[i - j].l <= c.l || candles[i + j].l <= c.l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) out.push({ index: i, time: c.t, price: c.h, kind: "HIGH" });
    if (isLow) out.push({ index: i, time: c.t, price: c.l, kind: "LOW" });
  }
  return out;
}

/** Structure classification from the most recent swing sequence. */
export function swingStructure(sw: SwingPoint[]): {
  highs: SwingPoint[];
  lows: SwingPoint[];
  pattern: "HH_HL" | "LH_LL" | "MIXED" | "INSUFFICIENT";
} {
  const highs = sw.filter((s) => s.kind === "HIGH").slice(-3);
  const lows = sw.filter((s) => s.kind === "LOW").slice(-3);
  if (highs.length < 2 || lows.length < 2) return { highs, lows, pattern: "INSUFFICIENT" };
  const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
  const hl = lows[lows.length - 1].price > lows[lows.length - 2].price;
  const lh = !hh;
  const ll = !hl;
  if (hh && hl) return { highs, lows, pattern: "HH_HL" };
  if (lh && ll) return { highs, lows, pattern: "LH_LL" };
  return { highs, lows, pattern: "MIXED" };
}

export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const { h } = candles[i];
    const { l } = candles[i];
    const pc = candles[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return sma(trs, period);
}

/**
 * Time-of-day-adjusted RVOL: today's volume so far divided by the expected
 * volume so far (sum of historical average buckets up to now, with the
 * in-progress bucket prorated). All inputs are real Upstox volumes.
 *
 * @param volumeBuckets  avg volume per fixed-size bucket across the session
 * @param sessionMinutes minutes elapsed since session open (can be < 0)
 * @param bucketMinutes  minutes per bucket (e.g. 15)
 */
export function expectedVolumeToNow(
  volumeBuckets: number[],
  sessionMinutes: number,
  bucketMinutes = 15,
): number | null {
  if (!volumeBuckets.length || sessionMinutes <= 0) return null;
  let expected = 0;
  const full = Math.floor(sessionMinutes / bucketMinutes);
  for (let i = 0; i < Math.min(full, volumeBuckets.length); i++) expected += volumeBuckets[i];
  if (full < volumeBuckets.length) {
    const frac = (sessionMinutes - full * bucketMinutes) / bucketMinutes;
    expected += volumeBuckets[full] * frac;
  }
  return expected > 0 ? expected : null;
}

export function rvol(nowVolume: number | null, expected: number | null): number | null {
  if (nowVolume === null || expected === null || expected <= 0) return null;
  return nowVolume / expected;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function fmt(n: number | null | undefined, d = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "N/A";
  return n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
}
