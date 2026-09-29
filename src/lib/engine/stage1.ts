/**
 * Stage 1 — fast market-wide filtering & momentum scoring.
 * Computes RVOL (time-of-day adjusted), RS vs NIFTY, RS acceleration,
 * VWAP relationship, 1-min momentum and 5-min trend from real data only.
 */

import type {
  Candle,
  Direction,
  FuturesMetrics,
  ScannerConfig,
  Stage1Metrics,
  Trend,
} from "./types";
import type { DataStatus } from "@/lib/market/time";
import { clamp, ema, expectedVolumeToNow, lastEma, swingStructure, swings, aggregate } from "./indicators";
import { sessionMinutes } from "@/lib/market/time";

export interface PriceSnap {
  ts: number;
  ltp: number;
  volume: number | null;
}

export interface Stage1Input {
  symbol: string;
  quote: {
    ltp: number | null;
    prevClose: number | null;
    dayOpen: number | null;
    dayHigh: number | null;
    dayLow: number | null;
    dayVolume: number | null;
    vwap: number | null; // real Upstox average_price
  };
  dataStatus: DataStatus;
  lastQuoteTs: number | null;
  ring: PriceSnap[];
  niftyRing: PriceSnap[];
  baseline: {
    avgDailyVolume: number | null;
    volumeBuckets: number[] | null;
  } | null;
  candles1m: Candle[] | null;
  futures: FuturesMetrics;
  config: ScannerConfig;
  now: number;
}

function ltpAtOrBefore(ring: PriceSnap[], targetTs: number): number | null {
  for (let i = ring.length - 1; i >= 0; i--) {
    if (ring[i].ts <= targetTs) return ring[i].ltp;
  }
  return ring.length > 0 ? ring[0].ltp : null;
}

export function compute5mTrend(candles1m: Candle[] | null): Trend {
  if (!candles1m || candles1m.length < 15) return "INSUFFICIENT_DATA";
  const c5 = aggregate(candles1m, 5);
  if (c5.length < 14) return "INSUFFICIENT_DATA";
  const closes = c5.map((c) => c.c);
  const e9 = lastEma(closes, 9);
  const e20 = lastEma(closes, 20);
  const e50 = c5.length >= 55 ? lastEma(closes, 50) : null;
  if (e9 === null || e20 === null) return "INSUFFICIENT_DATA";
  const price = closes[closes.length - 1];
  const structure = swingStructure(swings(c5, 2)).pattern;

  let bull = 0;
  let bear = 0;
  if (e9 > e20) bull++; else bear++;
  if (e50 !== null) {
    if (e20 > e50) bull++; else bear++;
    if (price > e50) bull++; else bear++;
  }
  if (price > e20) bull++; else bear++;
  if (structure === "HH_HL") bull++;
  if (structure === "LH_LL") bear++;
  if (bull >= 3 && bull >= bear + 2) return "BULLISH";
  if (bear >= 3 && bear >= bull + 2) return "BEARISH";
  return "NEUTRAL";
}

export function futuresSignal(priceChgPct: number | null, oiChgPct: number | null): FuturesMetrics["signal"] {
  if (priceChgPct === null || oiChgPct === null) return "UNAVAILABLE";
  const p = priceChgPct > 0.08 ? 1 : priceChgPct < -0.08 ? -1 : 0;
  const oi = oiChgPct > 0.15 ? 1 : oiChgPct < -0.15 ? -1 : 0;
  if (p > 0 && oi > 0) return "LONG_BUILDUP";
  if (p < 0 && oi > 0) return "SHORT_BUILDUP";
  if (p > 0 && oi < 0) return "SHORT_COVERING";
  if (p < 0 && oi < 0) return "LONG_UNWINDING";
  return "NEUTRAL";
}

export function computeStage1(input: Stage1Input): Stage1Metrics {
  const { quote, config } = input;
  const nowMs = input.now;

  const niftyNow = input.niftyRing.length ? input.niftyRing[input.niftyRing.length - 1].ltp : null;
  const niftyStream = input.niftyRing;

  const returnDayPct =
    quote.ltp != null && quote.prevClose != null && quote.prevClose > 0
      ? ((quote.ltp - quote.prevClose) / quote.prevClose) * 100
      : null;

  const ltp5 = quote.ltp != null ? ltpAtOrBefore(input.ring, nowMs - 5 * 60_000) : null;
  const ltp15 = quote.ltp != null ? ltpAtOrBefore(input.ring, nowMs - 15 * 60_000) : null;
  const return5mPct =
    quote.ltp != null && ltp5 != null && ltp5 > 0 ? ((quote.ltp - ltp5) / ltp5) * 100 : null;
  const return15mPct =
    quote.ltp != null && ltp15 != null && ltp15 > 0 ? ((quote.ltp - ltp15) / ltp15) * 100 : null;
  const ltp10 = quote.ltp != null ? ltpAtOrBefore(input.ring, nowMs - 10 * 60_000) : null;
  const return5mPrevPct =
    ltp5 != null && ltp10 != null && ltp10 > 0 ? ((ltp5 - ltp10) / ltp10) * 100 : null;
  const priceAccel = return5mPct != null && return5mPrevPct != null ? return5mPct - return5mPrevPct : null;

  // RVOL — time-of-day adjusted against real historical buckets
  const sessMin = sessionMinutes(new Date(nowMs));
  const expected =
    input.baseline?.volumeBuckets != null
      ? expectedVolumeToNow(input.baseline.volumeBuckets, sessMin, 15)
      : null;
  const rvolVal =
    quote.dayVolume != null && expected != null ? quote.dayVolume / expected : null;

  // RS vs NIFTY (requires NIFTY prev-close anchored series — embedded in ring
  // via normalize: we store NIFTY return% instead of raw ltp upstream when
  // possible; here compute from both rings when available)
  let rsNiftyPct: number | null = null;
  if (returnDayPct != null && niftyStream.length > 0 && niftyNow != null) {
    // niftyRing ltp field carries DAY RETURN % values (set by service)
    const niftyReturnNow = niftyNow;
    rsNiftyPct = returnDayPct - niftyReturnNow;
  }

  // RS acceleration: change of RS over the last 5 minutes
  let rsAccelPct: number | null = null;
  if (return5mPct != null && niftyStream.length >= 2) {
    const n5 = ltpAtOrBefore(niftyStream, nowMs - 5 * 60_000);
    const nNow = niftyNow;
    if (n5 != null && nNow != null) {
      const nifty5m = nNow - n5; // difference of return% values ≈ NIFTY 5m return
      rsAccelPct = return5mPct - nifty5m;
    }
  }

  const aboveVwap = quote.ltp != null && quote.vwap != null ? quote.ltp >= quote.vwap : null;
  const trend5m = compute5mTrend(input.candles1m);

  // Liquidity as REAL traded value: day volume × Upstox VWAP (average_price).
  // Both inputs come straight from the quote feed; if either is missing the
  // turnover stays null (N/A) and is never estimated from a substitute price.
  const turnoverCr =
    quote.dayVolume != null && quote.dayVolume > 0 && quote.vwap != null && quote.vwap > 0
      ? (quote.dayVolume * quote.vwap) / 1e7
      : null;
  const liquidityPass = turnoverCr == null ? null : turnoverCr >= config.minTurnoverCr;

  /* ------------------------------ direction ------------------------------ */
  let dirScore = 0;
  if (rsNiftyPct != null) dirScore += rsNiftyPct * 45;
  if (returnDayPct != null) dirScore += returnDayPct * 6;
  if (aboveVwap === true) dirScore += 12;
  if (aboveVwap === false) dirScore -= 12;
  if (trend5m === "BULLISH") dirScore += 18;
  if (trend5m === "BEARISH") dirScore -= 18;
  const direction: Direction | null = dirScore > 4 ? "LONG" : dirScore < -4 ? "SHORT" : null;

  /* ------------------------------- scoring ------------------------------- */
  const sign = direction === "SHORT" ? -1 : 1;
  const parts: { key: string; weight: number; value: number | null }[] = [
    { key: "rvol", weight: config.momentumWeights.rvol, value: rvolVal != null ? clamp((rvolVal / (2 * config.rvolThreshold)) * 100, 0, 100) : null },
    { key: "rs", weight: config.momentumWeights.rs, value: rsNiftyPct != null && direction != null ? clamp(50 + sign * rsNiftyPct * 40, 0, 100) : null },
    { key: "rsAccel", weight: config.momentumWeights.rsAccel, value: rsAccelPct != null && direction != null ? clamp(50 + sign * rsAccelPct * 60, 0, 100) : null },
    {
      key: "trend5m",
      weight: config.momentumWeights.trend5m,
      value:
        trend5m === "INSUFFICIENT_DATA" || direction == null
          ? null
          : trend5m === "NEUTRAL"
            ? 45
            : (trend5m === "BULLISH" && direction === "LONG") || (trend5m === "BEARISH" && direction === "SHORT")
              ? 90
              : 20,
    },
    { key: "vwap", weight: config.momentumWeights.vwap, value: aboveVwap === null || direction == null ? null : aboveVwap === (direction === "LONG") ? 85 : 25 },
    {
      key: "futures",
      weight: config.momentumWeights.futures,
      value:
        input.futures.signal === "UNAVAILABLE" || direction == null
          ? null
          : input.futures.signal === "NEUTRAL"
            ? 50
            : (input.futures.signal === "LONG_BUILDUP" && direction === "LONG") ||
                (input.futures.signal === "SHORT_BUILDUP" && direction === "SHORT")
              ? 90
              : (input.futures.signal === "SHORT_COVERING" && direction === "LONG") ||
                  (input.futures.signal === "LONG_UNWINDING" && direction === "SHORT")
                ? 70
                : 20,
    },
    {
      key: "liquidity",
      weight: config.momentumWeights.liquidity,
      value:
        input.baseline?.avgDailyVolume != null
          ? clamp((input.baseline.avgDailyVolume / (2 * config.minAvgDailyVolume)) * 100, 0, 100)
          : quote.dayVolume != null
            ? clamp((quote.dayVolume / (2 * config.minAvgDailyVolume)) * 100, 0, 100)
            : null,
    },
    {
      key: "priceMomentum",
      weight: config.momentumWeights.priceMomentum,
      value: return5mPct != null && direction != null ? clamp(50 + sign * return5mPct * 25, 0, 100) : null,
    },
  ];

  let wSum = 0;
  let acc = 0;
  let totalW = 0;
  for (const p of parts) {
    totalW += p.weight;
    if (p.value == null || p.weight <= 0) continue;
    wSum += p.weight;
    acc += p.weight * p.value;
  }
  // Coverage dampening: a stock scored on a single available metric must not
  // outrank one scored across the full panel (no data → no confidence).
  const coverage = totalW > 0 ? wSum / totalW : 0;
  const base = wSum > 0 ? acc / wSum : 0;
  const momentumScore = Math.round(base * Math.sqrt(coverage));

  /* ------------------------- stage-2 block reasons ----------------------- */
  const blocked: string[] = [];
  if (input.dataStatus === "STALE" || input.dataStatus === "UNAVAILABLE") blocked.push("market data stale/unavailable");
  if (rvolVal != null && rvolVal < config.rvolThreshold * 0.66) blocked.push(`RVOL ${rvolVal.toFixed(2)}x below threshold`);
  if (rvolVal == null && quote.dayVolume != null) blocked.push("RVOL baseline missing");
  if (input.baseline?.avgDailyVolume != null && input.baseline.avgDailyVolume < config.minAvgDailyVolume)
    blocked.push("liquidity below minimum");
  if (liquidityPass === false)
    blocked.push(`turnover ₹${turnoverCr!.toFixed(0)} Cr below ₹${config.minTurnoverCr} Cr`);
  if (liquidityPass === null) blocked.push("turnover unavailable — liquidity unverified");
  if (trend5m === "INSUFFICIENT_DATA") blocked.push("insufficient 5-min history");
  if (direction == null) blocked.push("no directional edge");

  return {
    symbol: input.symbol,
    ltp: quote.ltp,
    prevClose: quote.prevClose,
    dayOpen: quote.dayOpen,
    dayHigh: quote.dayHigh,
    dayLow: quote.dayLow,
    dayVolume: quote.dayVolume,
    vwap: quote.vwap,
    returnDayPct,
    return5mPct,
    return15mPct,
    priceAccel,
    rvol: rvolVal,
    avgDailyVolume: input.baseline?.avgDailyVolume ?? null,
    turnoverCr,
    liquidityPass,
    rsNiftyPct,
    rsSectorPct: null, // Upstox provides no sector attribution feed → N/A
    rsAccelPct,
    aboveVwap,
    trend5m,
    trend5mStaleSince: null,
    futures: input.futures,
    momentumScore,
    direction,
    momentumState: "IDLE",
    isStage2Candidate: false,
    stage2BlockedReasons: blocked,
    dataStatus: input.dataStatus,
    lastQuoteAt: input.lastQuoteTs ? new Date(input.lastQuoteTs).toISOString() : null,
    candlesUpdatedAt: null,
  };
}
