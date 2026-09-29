/**
 * Shared engine types — used across Stage 1, Stage 2, the scanner service,
 * API routes and the UI. Every numeric market field is either a real Upstox
 * value, a deterministic derivation of real Upstox values, or null (N/A).
 */

export type Direction = "LONG" | "SHORT";
export type Trend = "BULLISH" | "BEARISH" | "NEUTRAL" | "INSUFFICIENT_DATA";
export type MomentumState =
  | "IDLE"
  | "EARLY_MOMENTUM"
  | "CONFIRMED_MOMENTUM";
export type SetupState =
  | "TRADE_SETUP"        // LONG/SHORT setup active with valid levels & R:R
  | "WAIT_BREAKOUT"
  | "WAIT_BREAKDOWN"
  | "WAIT_RETEST"
  | "NO_TRADE"
  | "INSUFFICIENT_DATA";
export type CandleDirection = "LONG_DIRECTION" | "SHORT_DIRECTION";
export type FuturesSignal =
  | "LONG_BUILDUP"
  | "SHORT_BUILDUP"
  | "SHORT_COVERING"
  | "LONG_UNWINDING"
  | "NEUTRAL"
  | "UNAVAILABLE";

export interface Candle {
  t: number; // epoch ms (Upstox candle timestamp)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  oi?: number | null;
}

export interface ScannerConfig {
  quotePollIntervalSec: number;
  stage2IntervalSec: number;
  /** Number of universe 1-minute candle refreshes per scan burst (budget). */
  universeCandleRefreshPerScan: number;
  rvolThreshold: number;
  /** Minimum acceptable average daily volume for liquidity. */
  minAvgDailyVolume: number;
  /**
   * Minimum intraday traded value (turnover) in ₹ crore required for a stock
   * to be eligible as a Stage-2 candidate. Turnover = real day volume × real
   * Upstox VWAP (average_price). Never estimated.
   */
  minTurnoverCr: number;
  stage2Candidates: number;
  topNSetups: number;
  enterScore: number;
  exitScore: number;
  minRR: number;
  openingRangeMinutes: number;
  baselineDays: number;
  /** If price is further than this % beyond the ideal entry, wait for retest. */
  maxBreakoutExtensionPct: number;
  quoteChunkSize: number;
  momentumWeights: {
    rvol: number;
    rs: number;
    rsAccel: number;
    trend5m: number;
    vwap: number;
    futures: number;
    liquidity: number;
    priceMomentum: number;
  };
  finalWeights: {
    priceStructure: number;
    rvol: number;
    rs: number;
    rsAccel: number;
    srQuality: number;
    optionConfluence: number;
    futures: number;
    trend5m: number;
    rr: number;
  };
}

export const DEFAULT_CONFIG: ScannerConfig = {
  quotePollIntervalSec: 15,
  stage2IntervalSec: 45,
  universeCandleRefreshPerScan: 40,
  rvolThreshold: 1.5,
  minAvgDailyVolume: 100000,
  minTurnoverCr: 150,
  stage2Candidates: 25,
  topNSetups: 10,
  enterScore: 75,
  exitScore: 60,
  minRR: 2,
  openingRangeMinutes: 15,
  baselineDays: 20,
  maxBreakoutExtensionPct: 0.7,
  quoteChunkSize: 120,
  momentumWeights: {
    rvol: 20,
    rs: 20,
    rsAccel: 20,
    trend5m: 15,
    vwap: 10,
    futures: 10,
    liquidity: 5,
    priceMomentum: 0,
  },
  finalWeights: {
    priceStructure: 20,
    rvol: 15,
    rs: 15,
    rsAccel: 10,
    srQuality: 15,
    optionConfluence: 10,
    futures: 5,
    trend5m: 5,
    rr: 5,
  },
};

export function mergeConfig(input: Partial<ScannerConfig> | null | undefined): ScannerConfig {
  const cfg: ScannerConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (!input || typeof input !== "object") return cfg;
  const c = input as Record<string, unknown>;
  for (const k of Object.keys(cfg) as (keyof ScannerConfig)[]) {
    if (c[k] === undefined || c[k] === null) continue;
    if (typeof cfg[k] === "object" && cfg[k] !== null && !Array.isArray(cfg[k])) {
      const target = cfg[k] as unknown as Record<string, unknown>;
      const src = c[k] as Record<string, unknown>;
      if (typeof src === "object") {
        for (const sk of Object.keys(target)) {
          const v = src[sk];
          if (typeof v === "number" && Number.isFinite(v)) target[sk] = v;
        }
      }
    } else {
      const v = c[k];
      if (typeof v === "number" && Number.isFinite(v)) (cfg as unknown as Record<string, unknown>)[k] = v;
    }
  }
  // clamp
  cfg.quotePollIntervalSec = Math.min(120, Math.max(5, cfg.quotePollIntervalSec));
  cfg.stage2IntervalSec = Math.min(300, Math.max(15, cfg.stage2IntervalSec));
  cfg.universeCandleRefreshPerScan = Math.min(150, Math.max(5, cfg.universeCandleRefreshPerScan));
  cfg.minTurnoverCr = Math.min(100000, Math.max(0, cfg.minTurnoverCr));
  cfg.stage2Candidates = Math.min(60, Math.max(5, cfg.stage2Candidates));
  cfg.topNSetups = Math.min(25, Math.max(1, cfg.topNSetups));
  cfg.rvolThreshold = Math.min(20, Math.max(0.5, cfg.rvolThreshold));
  cfg.enterScore = Math.min(100, Math.max(1, cfg.enterScore));
  cfg.exitScore = Math.min(cfg.enterScore - 1, Math.max(0, cfg.exitScore));
  cfg.minRR = Math.min(10, Math.max(0.5, cfg.minRR));
  cfg.quoteChunkSize = Math.min(480, Math.max(20, cfg.quoteChunkSize));
  return cfg;
}

/* ----------------------- Stage 1 (fast filter) ----------------------- */

export interface FuturesMetrics {
  ltp: number | null;
  volume: number | null;
  oi: number | null;
  oiChange: number | null; // vs previous day OI (real delta)
  oiChangePct: number | null;
  priceChangePct: number | null; // vs previous futures close
  signal: FuturesSignal;
  dataStatus: string;
  expiry: string | null;
}

export interface Stage1Metrics {
  symbol: string;
  ltp: number | null;
  prevClose: number | null;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  dayVolume: number | null;
  vwap: number | null; // Upstox average_price — session VWAP
  returnDayPct: number | null;
  return5mPct: number | null;
  return15mPct: number | null;
  priceAccel: number | null;
  rvol: number | null; // time-of-day adjusted
  avgDailyVolume: number | null;
  /** Intraday traded value in ₹ crore = real day volume × real Upstox VWAP. */
  turnoverCr: number | null;
  /** True only when turnover is known AND clears the configured minimum. */
  liquidityPass: boolean | null;
  rsNiftyPct: number | null;
  rsSectorPct: number | null; // always null (no sector feed from Upstox) -> N/A
  rsAccelPct: number | null;
  aboveVwap: boolean | null;
  trend5m: Trend;
  trend5mStaleSince: string | null;
  futures: FuturesMetrics;
  momentumScore: number;
  direction: Direction | null;
  momentumState: MomentumState;
  isStage2Candidate: boolean;
  stage2BlockedReasons: string[];
  dataStatus: DataStatusCode;
  lastQuoteAt: string | null;
  candlesUpdatedAt: string | null;
}

export type DataStatusCode = "LIVE" | "RECENT" | "STALE" | "PARTIAL" | "UNAVAILABLE";

/* ----------------------- Stage 2 (deep analysis) ----------------------- */

export type LevelSource =
  | "PREV_DAY_HIGH"
  | "PREV_DAY_LOW"
  | "PREV_DAY_CLOSE"
  | "OPEN"
  | "OPENING_RANGE_HIGH"
  | "OPENING_RANGE_LOW"
  | "SWING_HIGH"
  | "SWING_LOW"
  | "CONSOLIDATION"
  | "VOLUME_PROFILE"
  | "VWAP"
  | "OPTION_CE_OI"
  | "OPTION_PE_OI"
  | "BROKEN_RESISTANCE"
  | "BROKEN_SUPPORT";

export interface ZoneMember {
  source: LevelSource;
  price: number;
  detail?: string;
  weight: number; // 0-1 normalized strength of the originating evidence
}

export interface SRZone {
  id: string;
  kind: "SUPPORT" | "RESISTANCE";
  low: number;
  high: number;
  center: number;
  strength: number; // 0-100 confluence score
  sources: LevelSource[];
  members: ZoneMember[];
  touches: number;
  distancePct: number;
  status: "ACTIVE" | "ENGULFING" | "BROKEN";
  note: string;
}

export interface OptionStrikeInfo {
  strike: number;
  side: "CE" | "PE";
  oi: number | null;
  oiChange: number | null;
  volume: number | null;
  ltp: number | null;
  score: number; // 0-100
  role: "SUPPORT" | "RESISTANCE" | "OMNI";
  unwinding: boolean | null; // true when OI decreased materially (real inferable)
  buildup: boolean | null;
}

export interface TradePlan {
  direction: Direction;
  setupState: SetupState;
  entryLow: number | null;
  entryHigh: number | null;
  entryRef: number | null;
  stop: number | null;
  stopNote: string | null;
  target1: number | null;
  target2: number | null;
  target3: number | null;
  risk: number | null;
  rr1: number | null;
  invalidationText: string | null;
  reasonsNoTrade: string[];
}

export interface Explanation {
  summary: string;
  whyNow: string[];
  confirmations: string[];
  invalidation: string | null;
  cautions: string[];
}

export interface Stage2Result {
  symbol: string;
  analyzedAt: string;
  direction: Direction | null;
  finalScore: number;
  setupState: SetupState;
  support: SRZone | null;
  resistance: SRZone | null;
  supportNext: SRZone | null;
  resistanceNext: SRZone | null;
  optionSupport: OptionStrikeInfo | null;
  optionResistance: OptionStrikeInfo | null;
  allSupports: SRZone[];
  allResistances: SRZone[];
  tradePlan: TradePlan;
  explanation: Explanation;
  structureNotes: string[];
  scoreBreakdown: Record<string, { weight: number; value: number | null; contribution: number; note: string }>;
  dataGaps: string[];
}

/* ----------------------------- Universe ------------------------------ */

export interface UniverseSymbol {
  symbol: string;
  name: string;
  isin: string | null;
  equityKey: string;
  futuresKey: string | null;
  futuresTradingSymbol: string | null;
  futuresExpiry: number | null; // epoch ms
  lotSize: number | null;
  tickSize: number | null;
}

export interface DashboardPayload {
  generatedAt: string;
  engine: {
    running: boolean;
    connected: boolean;
    userName: string | null;
    lastScanAt: string | null;
    lastStage2At: string | null;
    lastQuoteAt: string | null;
    cycleMs: number;
    marketPhase: string;
    exchangeStatus: string | null;
    message: string | null;
    tokenInvalid: boolean;
  };
  market: {
    niftyLtp: number | null;
    niftyChangePct: number | null;
    niftyOpen: number | null;
    niftyVwap: number | null;
    regime: string | null;
    advances: number | null;
    declines: number | null;
    unchanged: number | null;
    dataStatus: DataStatusCode;
  };
  universe: {
    total: number;
    withQuotes: number;
    universeUpdatedAt: string | null;
    baselinesReady: number;
    baselineProgress: number;
    /** Stage-1 names excluded by the ₹ crore turnover gate. */
    illiquidFiltered: number;
    liquidCount: number;
  };
  pipeline: {
    stage1Scanned: number;
    earlyMomentum: number;
    confirmedMomentum: number;
    candidatesLong: number;
    candidatesShort: number;
    stage2Analyzed: number;
    setups: number;
  };
  config: ScannerConfig;
  topSetups: SetupCardData[];
  earlyMomentum: Stage1Metrics[];
  confirmedMomentum: Stage1Metrics[];
  breakoutWatch: Stage1Metrics[];
  breakdownWatch: Stage1Metrics[];
  strongestRs: Stage1Metrics[];
  strongestRw: Stage1Metrics[];
  highestRvol: Stage1Metrics[];
  candidates: Stage1Metrics[];
}

export interface SetupCardData {
  stage1: Stage1Metrics;
  stage2: Stage2Result;
}

/* ------------------------- Stock detail view ------------------------- */

export interface OptionChainRow {
  strike: number;
  ceOi: number | null;
  ceOiChange: number | null;
  ceVolume: number | null;
  ceLtp: number | null;
  peOi: number | null;
  peOiChange: number | null;
  peVolume: number | null;
  peLtp: number | null;
  highlight: "SUPPORT" | "RESISTANCE" | "BOTH" | null;
  pcrNote: string | null;
}

export interface StockDetailPayload {
  symbol: string;
  name: string;
  equityKey: string;
  futuresKey: string | null;
  futuresExpiry: string | null;
  stage1: Stage1Metrics | null;
  stage2: Stage2Result | null;
  candles1m: Candle[];
  candles5m: Candle[];
  optionChain: OptionChainRow[];
  optionExpiry: string | null;
  optionPcr: number | null;
  spotPrice: number | null;
  futures: {
    ltp: number | null;
    prevClose: number | null;
    volume: number | null;
    oi: number | null;
    oiChange: number | null;
    basis: number | null;
    basisPct: number | null;
    signal: FuturesSignal;
    dataStatus: string;
  };
  baseline: {
    avgDailyVolume: number | null;
    pdh: number | null;
    pdl: number | null;
    pdc: number | null;
    atr14: number | null;
  };
  marketPhase: string;
  dataStatus: DataStatusCode;
  generatedAt: string;
  /** ADDITIVE: intraday dynamic S/R zones (independent engine). */
  dynamicSR?: unknown | null;
}
