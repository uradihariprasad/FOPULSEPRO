/**
 * ScannerService — the two-stage scanning engine.
 *
 * STAGE 1 (all universe): batched full quotes every poll cycle + rotating
 * 1-minute candle refreshes -> RVOL / RS / RS-accel / VWAP / momentum / 5-min
 * trend -> hysteresis state machine -> top candidates.
 *
 * STAGE 2 (candidates only): daily structure, intraday candles, option chain,
 * futures confirmation -> combined dynamic S/R -> trade setup + R:R ->
 * final score -> Top setups.
 *
 * All numbers originate from Upstox; gaps surface as N/A / INSUFFICIENT DATA.
 */

import { db } from "@/db";
import { settings, upstoxAuth, universeSymbols, baselines, signalEvents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { UpstoxClient, TokenInvalidError, UpstoxError, parseUpstoxTs } from "@/lib/upstox/client";
import { downloadInstrumentMaster, buildUniverse, findNiftyKey } from "@/lib/upstox/instruments";
import type { FullMarketQuote, OptionChainStrike } from "@/lib/upstox/types";
import {
  DEFAULT_CONFIG,
  mergeConfig,
  type Candle,
  type DashboardPayload,
  type FuturesMetrics,
  type OptionChainRow,
  type ScannerConfig,
  type SetupCardData,
  type Stage1Metrics,
  type Stage2Result,
  type StockDetailPayload,
  type UniverseSymbol,
  type MomentumState,
  type DataStatusCode,
} from "@/lib/engine/types";
import { computeStage1, futuresSignal, type PriceSnap } from "@/lib/engine/stage1";
import {
  computeOrderFlow,
  newFlowTracker,
  ORDERFLOW_MIN_RANK_SCORE,
  type FlowTracker,
  type OrderFlowResult,
} from "@/lib/engine/orderflow";
import {
  computeDynamicSR,
  newSRTracker,
  type DynamicSRResult,
  type SRTracker,
} from "@/lib/engine/dynamic-sr";
import {
  computeConviction,
  CONVICTION_MIN_SCORE,
  type ConvictionResult,
} from "@/lib/engine/conviction";
import {
  computeMomentumRadar,
  RADAR_MIN_SCORE,
  type MomentumRadarResult,
} from "@/lib/engine/momentum-radar";
import {
  computeReversal,
  newReversalTracker,
  type ReversalResult,
  type ReversalTracker,
} from "@/lib/engine/reversal";
import { analyzeLevels } from "@/lib/engine/levels";
import { buildSetup } from "@/lib/engine/setup";
import { aggregate, atr } from "@/lib/engine/indicators";
import { marketPhase, istParts, istDateString, freshnessStatus, type DataStatus } from "@/lib/market/time";

const CONFIG_KEY = "scanner_config";
const MAX_RING = 260; // ~65 min of 15s snapshots

interface SymbolState {
  u: UniverseSymbol;
  ring: PriceSnap[];
  quote: FullMarketQuote | null;
  futQuote: FullMarketQuote | null;
  stage1: Stage1Metrics | null;
  momentumState: MomentumState;
  belowEnterSince: number | null;
  candidate: boolean;
  belowExitScans: number;
  candles1m: { at: number; data: Candle[] } | null;
  daily: { at: number; data: Candle[] } | null;
  futDaily: { at: number; data: Candle[] } | null;
  optionExpiry: { date: string | null; at: number } | null;
  optionChain: { at: number; expiry: string; spot: number | null; strikes: OptionChainStrike[] } | null;
  stage2: Stage2Result | null;
  prevSetupState: string | null;
  orderFlow: OrderFlowResult | null;
  flowTracker: FlowTracker;
  dominanceHistory: { ts: number; buyer: number; seller: number }[];
  dynamicSR: DynamicSRResult | null;
  srTracker: SRTracker;
  conviction: ConvictionResult | null;
  radar: MomentumRadarResult | null;
  rvolHistory: { ts: number; rvol: number }[];
  reversal: ReversalResult | null;
  reversalTracker: ReversalTracker;
  baseline: {
    avgDailyVolume: number | null;
    buckets: number[] | null;
    pdh: number | null; pdl: number | null; pdc: number | null; atr14: number | null;
    futPrevOi: number | null; futPrevClose: number | null; tradeDate: string | null;
  } | null;
}

export class ScannerService {
  readonly client = new UpstoxClient();
  config: ScannerConfig = DEFAULT_CONFIG;
  running = false;
  connected = false;
  userName: string | null = null;
  tokenInvalid = false;
  message: string | null = "waiting for Upstox token";

  universe: UniverseSymbol[] = [];
  universeUpdatedAt: number | null = null;
  symbols = new Map<string, SymbolState>();
  niftyKey = "NSE_INDEX|Nifty 50";
  niftyRing: PriceSnap[] = [];
  niftyQuote: FullMarketQuote | null = null;
  exchangeStatus: string | null = null;

  baselinesReady = 0;
  baselineTarget = 0;
  baselineRunning = false;
  universeRefreshing = false;

  lastQuoteAt: number | null = null;
  lastScanAt: number | null = null;
  lastStage2At: number | null = null;

  private quoteTimer: NodeJS.Timeout | null = null;
  private stageTimer: NodeJS.Timeout | null = null;
  private slowTimer: NodeJS.Timeout | null = null;
  private rotateIdx = 0;
  private statusFetchedAt = 0;
  private candleBootstrapped = false;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private dayStamp = istDateString();
  private candleInflight = new Set<string>();
  private baselineInflight = new Set<string>();

  /* ------------------------------- boot & auth ------------------------------ */

  async init() {
    await this.loadConfig();
    await this.loadToken();
    await this.loadUniverseFromDb();
    await this.loadBaselinesFromDb();
    if (this.connected) {
      this.start();
    }
  }

  private async loadConfig() {
    try {
      const rows = await db.select().from(settings).where(eq(settings.key, CONFIG_KEY));
      if (rows[0]) this.config = mergeConfig(rows[0].value as Partial<ScannerConfig>);
    } catch {
      this.config = DEFAULT_CONFIG;
    }
  }

  async updateConfig(partial: Partial<ScannerConfig>): Promise<ScannerConfig> {
    this.config = mergeConfig({ ...this.config, ...partial });
    await db
      .insert(settings)
      .values({ key: CONFIG_KEY, value: this.config as unknown as Record<string, unknown>, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: this.config as unknown as Record<string, unknown>, updatedAt: new Date() } });
    return this.config;
  }

  private async loadToken() {
    try {
      const rows = await db.select().from(upstoxAuth).where(eq(upstoxAuth.id, 1));
      if (rows[0]) {
        this.client.setToken(rows[0].accessToken);
        this.userName = rows[0].userName ?? null;
        this.connected = true;
        this.tokenInvalid = false;
        this.message = null;
      }
    } catch (e) {
      this.connected = false;
      this.message = "auth store unavailable";
    }
  }

  async connectToken(token: string): Promise<{ ok: boolean; userName?: string; error?: string }> {
    const probe = new UpstoxClient();
    probe.setToken(token);
    try {
      const profile = (await probe.profile()) ?? {};
      const name = profile.user_name ?? profile.user_id ?? "Upstox user";
      // persist server-side only
      await db
        .insert(upstoxAuth)
        .values({ id: 1, accessToken: token, userId: profile.user_id ?? null, userName: name, createdAt: new Date() })
        .onConflictDoUpdate({
          target: upstoxAuth.id,
          set: { accessToken: token, userId: profile.user_id ?? null, userName: name, createdAt: new Date() },
        });
      this.client.setToken(token);
      this.userName = name;
      this.connected = true;
      this.tokenInvalid = false;
      this.message = null;
      this.start();
      void this.ensureUniverse().catch(() => void 0);
      return { ok: true, userName: name };
    } catch (e) {
      const err = e instanceof UpstoxError ? `Upstox rejected the token (${e.message})` : "validation failed";
      return { ok: false, error: err };
    }
  }

  async disconnect() {
    try {
      await db.delete(upstoxAuth).where(eq(upstoxAuth.id, 1));
    } catch {
      // ignore
    }
    this.client.setToken(null);
    this.connected = false;
    this.userName = null;
    this.tokenInvalid = false;
    this.message = "token removed";
    this.stop();
  }

  /* ------------------------------ universe --------------------------------- */

  private async loadUniverseFromDb() {
    try {
      const rows = await db.select().from(universeSymbols);
      if (rows.length) {
        this.universe = rows.map((r) => ({
          symbol: r.symbol,
          name: r.name,
          isin: r.isin,
          equityKey: r.equityKey,
          futuresKey: r.futuresKey,
          futuresTradingSymbol: r.futuresTradingSymbol,
          futuresExpiry: r.futuresExpiry,
          lotSize: r.lotSize,
          tickSize: r.tickSize,
        }));
        this.symbols.clear();
        for (const u of this.universe) this.symbols.set(u.symbol, this.newSymbolState(u));
        this.universeUpdatedAt = rows[0].updatedAt?.getTime() ?? null;
      }
    } catch {
      this.universe = [];
    }
  }

  async ensureUniverse(force = false): Promise<{ count: number; error?: string }> {
    if (this.universeRefreshing) return { count: this.universe.length };
    this.universeRefreshing = true;
    try {
      const instruments = await downloadInstrumentMaster(force);
      this.niftyKey = findNiftyKey(instruments);
      const univ = buildUniverse(instruments);
      if (univ.length === 0) throw new Error("universe build returned 0 symbols");
      const now = new Date();
      // persist: upsert actives, mark missing inactive
      for (const u of univ) {
        await db
          .insert(universeSymbols)
          .values({ ...u, active: true, updatedAt: now })
          .onConflictDoUpdate({
            target: universeSymbols.symbol,
            set: {
              name: u.name, isin: u.isin, equityKey: u.equityKey,
              futuresKey: u.futuresKey, futuresTradingSymbol: u.futuresTradingSymbol,
              futuresExpiry: u.futuresExpiry, lotSize: u.lotSize, tickSize: u.tickSize,
              active: true, updatedAt: now,
            },
          });
      }
      const keep = new Set(univ.map((u) => u.symbol));
      try {
        await db.update(universeSymbols).set({ active: false }).where(eq(universeSymbols.active, true));
        for (const s of keep) await db.update(universeSymbols).set({ active: true }).where(eq(universeSymbols.symbol, s));
      } catch { /* non-fatal */ }
      this.universe = univ;
      this.universeUpdatedAt = Date.now();
      for (const u of univ) {
        if (!this.symbols.has(u.symbol)) this.symbols.set(u.symbol, this.newSymbolState(u));
        else this.symbols.get(u.symbol)!.u = u;
      }
      for (const sym of [...this.symbols.keys()]) {
        if (!keep.has(sym)) this.symbols.delete(sym);
      }
      return { count: univ.length };
    } catch (e) {
      return { count: this.universe.length, error: e instanceof Error ? e.message : "universe refresh failed" };
    } finally {
      this.universeRefreshing = false;
    }
  }

  private newSymbolState(u: UniverseSymbol): SymbolState {
    return {
      u,
      ring: [],
      quote: null,
      futQuote: null,
      stage1: null,
      momentumState: "IDLE",
      belowEnterSince: null,
      candidate: false,
      belowExitScans: 0,
      candles1m: null,
      daily: null,
      futDaily: null,
      optionExpiry: null,
      optionChain: null,
      stage2: null,
      prevSetupState: null,
      orderFlow: null,
      flowTracker: newFlowTracker(),
      dominanceHistory: [],
      dynamicSR: null,
      srTracker: newSRTracker(),
      conviction: null,
      radar: null,
      rvolHistory: [],
      reversal: null,
      reversalTracker: newReversalTracker(),
      baseline: null,
    };
  }

  /* ------------------------------ baselines -------------------------------- */

  private async loadBaselinesFromDb() {
    try {
      const rows = await db.select().from(baselines);
      for (const r of rows) {
        const s = this.symbols.get(r.symbol);
        if (!s) continue;
        s.baseline = {
          avgDailyVolume: r.avgDailyVolume,
          buckets: (r.volumeBuckets as number[] | null) ?? null,
          pdh: r.pdh, pdl: r.pdl, pdc: r.pdc, atr14: r.atr14,
          futPrevOi: r.futPrevOi, futPrevClose: r.futPrevClose,
          tradeDate: r.tradeDate,
        };
      }
      this.baselinesReady = rows.filter((r) => r.tradeDate === istDateString()).length;
    } catch { /* ignore */ }
  }

  /** Build baselines for all symbols (or a subset) from real Upstox history. */
  async refreshBaselines(symbols?: string[]): Promise<{ done: number; total: number }> {
    if (this.baselineRunning) return { done: this.baselinesReady, total: this.baselineTarget };
    const list = symbols ?? this.universe.map((u) => u.symbol);
    this.baselineRunning = true;
    this.baselineTarget = list.length;
    let done = 0;
    try {
      const queue = [...list];
      const worker = async () => {
        while (queue.length) {
          const sym = queue.shift();
          if (!sym) break;
          await this.buildBaseline(sym);
          done++;
          this.baselinesReady = done;
        }
      };
      await Promise.all([worker(), worker()]);
    } finally {
      this.baselineRunning = false;
    }
    return { done, total: list.length };
  }

  private async buildBaseline(symbol: string) {
    const s = this.symbols.get(symbol);
    if (!s || this.baselineInflight.has(symbol)) return;
    this.baselineInflight.add(symbol);
    try {
      const today = istDateString();
      if (s.baseline?.tradeDate === today && s.baseline.avgDailyVolume != null) return;
      const to = today;
      const from60 = shiftDays(today, -45);
      const from12 = shiftDays(today, -12);

      const daily = await this.client.historicalCandles(s.u.equityKey, "days", 1, to, from60).catch(() => [] as Candle[]);
      const mins = await this.client.historicalCandles(s.u.equityKey, "minutes", "15", to, from12).catch(() => [] as Candle[]);
      const futDaily = s.u.futuresKey
        ? await this.client.historicalCandles(s.u.futuresKey, "days", 1, to, from60).catch(() => [] as Candle[])
        : ([] as Candle[]);

      const completedDaily = daily.filter((c) => istDateString(new Date(c.t)) < today);
      const vols = completedDaily.slice(-this.config.baselineDays).map((c) => c.v);
      const avgDailyVolume = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
      const atr14v = atr(completedDaily.slice(-20), 14);
      const prevDay = completedDaily[completedDaily.length - 1] ?? null;

      // volume-by-time buckets from real 15-min history
      const bucketCount = 26; // 09:15..15:45
      const sums = new Array<number>(bucketCount).fill(0);
      const counts = new Array<number>(bucketCount).fill(0);
      for (const c of mins) {
        if (istDateString(new Date(c.t)) >= today) continue;
        const p = istParts(new Date(c.t));
        const idx = Math.floor((p.minutesOfDay - 555) / 15);
        if (idx >= 0 && idx < bucketCount) {
          sums[idx] += c.v;
          counts[idx] += 1;
        }
      }
      const buckets = counts.some((n) => n > 0)
        ? sums.map((v, i) => (counts[i] > 0 ? v / counts[i] : 0))
        : null;

      const futCompleted = futDaily.filter((c) => istDateString(new Date(c.t)) < today);
      const futPrev = futCompleted[futCompleted.length - 1] ?? null;

      s.baseline = {
        avgDailyVolume,
        buckets,
        pdh: prevDay?.h ?? null,
        pdl: prevDay?.l ?? null,
        pdc: prevDay?.c ?? null,
        atr14: atr14v,
        futPrevOi: futPrev?.oi ?? null,
        futPrevClose: futPrev?.c ?? null,
        tradeDate: today,
      };
      await db
        .insert(baselines)
        .values({
          symbol,
          tradeDate: today,
          avgDailyVolume,
          volumeBuckets: buckets ?? null,
          pdh: prevDay?.h ?? null,
          pdl: prevDay?.l ?? null,
          pdc: prevDay?.c ?? null,
          atr14: atr14v,
          futPrevOi: futPrev?.oi ?? null,
          futPrevClose: futPrev?.c ?? null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: baselines.symbol,
          set: { tradeDate: today, avgDailyVolume, volumeBuckets: buckets ?? null, pdh: prevDay?.h ?? null, pdl: prevDay?.l ?? null, pdc: prevDay?.c ?? null, atr14: atr14v, futPrevOi: futPrev?.oi ?? null, futPrevClose: futPrev?.c ?? null, updatedAt: new Date() },
        });
    } catch {
      // baseline stays missing — RVOL shows N/A
    } finally {
      this.baselineInflight.delete(symbol);
    }
  }

  /* ------------------------------ lifecycle -------------------------------- */

  start() {
    if (this.running) return;
    if (!this.connected) {
      this.message = "connect Upstox to start";
      return;
    }
    this.running = true;
    this.message = null;
    // self-rescheduling timers so config changes apply without restart
    const quoteLoop = async () => {
      if (!this.running) return;
      await this.tickQuotes();
      this.quoteTimer = setTimeout(() => void quoteLoop(), this.config.quotePollIntervalSec * 1000);
    };
    const stageLoop = async () => {
      if (!this.running) return;
      await this.tickStage2();
      this.stageTimer = setTimeout(() => void stageLoop(), this.config.stage2IntervalSec * 1000);
    };
    const slowLoop = async () => {
      if (!this.running) return;
      await this.tickSlow();
      this.slowTimer = setTimeout(() => void slowLoop(), 60_000);
    };
    void quoteLoop();
    void stageLoop();
    void slowLoop();
  }

  stop() {
    this.running = false;
    for (const t of [this.quoteTimer, this.stageTimer, this.slowTimer]) if (t) clearTimeout(t);
    this.quoteTimer = this.stageTimer = this.slowTimer = null;
  }

  private async tickSlow() {
    if (!this.connected) return;
    const today = istDateString();
    // daily rollover handling: universe + baselines + expiry changes
    if (today !== this.dayStamp) {
      this.dayStamp = today;
      void this.ensureUniverse().catch(() => void 0);
      void this.refreshBaselines().catch(() => void 0);
    }
    if (!this.universe.length && !this.universeRefreshing) void this.ensureUniverse().catch(() => void 0);
    if (this.baselinesReady < Math.min(10, this.universe.length) && !this.baselineRunning) {
      void this.refreshBaselines().catch(() => void 0);
    }
    if (Date.now() - this.statusFetchedAt > 60_000) {
      this.statusFetchedAt = Date.now();
      this.exchangeStatus = await this.client.exchangeStatus();
    }
    // Render-friendly keep-alive: on free/starter hosts that sleep on HTTP
    // inactivity, the engine pings itself once a minute so scanning stays live.
    if (process.env.ENABLE_KEEPALIVE === "true") {
      const port = process.env.PORT ?? "3000";
      void fetch(`http://127.0.0.1:${port}/api/health`).catch(() => void 0);
    }
  }

  private handleFatalAuth(e: unknown): boolean {
    if (e instanceof TokenInvalidError) {
      this.tokenInvalid = true;
      this.message = "Upstox token rejected (401). Reconnect with a fresh token.";
      this.stop();
      return true;
    }
    return false;
  }

  /* --------------------------- STAGE 1 — fast filter ------------------------ */

  private async tickQuotes() {
    if (!this.running || !this.client.hasToken()) return;
    if (!this.universe.length) {
      if (!this.universeRefreshing) void this.ensureUniverse();
      return;
    }
    try {
      const keys: string[] = [this.niftyKey];
      for (const u of this.universe) {
        keys.push(u.equityKey);
        if (u.futuresKey) keys.push(u.futuresKey);
      }
      const quotes = await this.client.fullQuotes(keys, this.config.quoteChunkSize).catch((e) => {
        if (this.handleFatalAuth(e)) return new Map<string, FullMarketQuote>();
        throw e;
      });
      this.lastQuoteAt = Date.now();

      const now = Date.now();
      this.niftyQuote = quotes.get(this.niftyKey) ?? null;
      const nq = this.niftyQuote;
      // previous close derived as last_price - net_change (verified against
      // the v3 LTP "cp" field) — ohlc.close in live quotes is the live price.
      if (nq?.last_price != null) {
        const nPrev = nq.net_change != null ? nq.last_price - nq.net_change : null;
        if (nPrev != null && nPrev > 0) {
          const nRet = ((nq.last_price - nPrev) / nPrev) * 100;
          this.pushRing(this.niftyRing, { ts: now, ltp: nRet, volume: nq.volume ?? null });
        }
      }

      for (const s of this.symbols.values()) {
        const q = quotes.get(s.u.equityKey) ?? null;
        const fq = s.u.futuresKey ? (quotes.get(s.u.futuresKey) ?? null) : null;
        s.quote = q;
        s.futQuote = fq;
        if (q?.last_price != null) {
          const ts = parseUpstoxTs(q.last_trade_time) ?? parseUpstoxTs(q.timestamp) ?? now;
          this.pushRing(s.ring, { ts, ltp: q.last_price, volume: q.volume ?? null });
        }
      }

      // candle refresh budget: candidates first, then universe rotation
      await this.refreshCandles();
      this.lastScanAt = Date.now();
      await this.computeAllStage1();
    } catch (e) {
      if (!this.handleFatalAuth(e)) {
        this.message = e instanceof UpstoxError ? `data error: ${e.message}` : null;
      }
    }
  }

  private pushRing(ring: PriceSnap[], snap: PriceSnap) {
    const tail = ring[ring.length - 1];
    if (tail && Math.abs(snap.ts - tail.ts) < 4000 && Math.abs(snap.ltp - tail.ltp) === 0 && snap.volume === tail.volume) {
      return; // duplicate tick
    }
    ring.push(snap);
    if (ring.length > MAX_RING) ring.splice(0, ring.length - MAX_RING);
  }

  private async refreshCandles() {
    if (!this.client.hasToken()) return;
    const budget = this.config.universeCandleRefreshPerScan;
    const targets: string[] = [];
    const candidateList = this.candidateList();
    // Stage-2 candidates and confirmed momentum refreshed every cycle
    for (const s of candidateList) {
      const st = s.candles1m;
      if (!st || Date.now() - st.at > 50_000) targets.push(s.u.symbol);
    }
    // universe rotation: least-recently refreshed first
    const rest = [...this.symbols.values()].filter((s) => !candidateList.includes(s));
    rest.sort((a, b) => (a.candles1m?.at ?? 0) - (b.candles1m?.at ?? 0));
    let i = this.rotateIdx % Math.max(1, rest.length);
    let added = 0;
    while (targets.length < budget && added < budget && rest.length > 0) {
      targets.push(rest[i % rest.length].u.symbol);
      i++;
      added++;
    }
    this.rotateIdx = (this.rotateIdx + added) % Math.max(1, rest.length || 1);

    const queue = [...targets];
    const worker = async () => {
      while (queue.length) {
        const sym = queue.shift();
        if (!sym || this.candleInflight.has(sym)) continue;
        this.candleInflight.add(sym);
        const st = this.symbols.get(sym);
        if (st) {
          await this.client
            .intradayCandles(st.u.equityKey, "minutes", "1")
            .then((c) => {
              if (c.length) st.candles1m = { at: Date.now(), data: c };
            })
            .catch(() => void 0);
        }
        this.candleInflight.delete(sym);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  private futuresMetricsFor(s: SymbolState): FuturesMetrics {
    const fq = s.futQuote;
    if (!s.u.futuresKey) {
      return { ltp: null, volume: null, oi: null, oiChange: null, oiChangePct: null, priceChangePct: null, signal: "UNAVAILABLE", dataStatus: "UNAVAILABLE", expiry: null };
    }
    const ltp = fq?.last_price ?? null;
    const nc = fq?.net_change ?? null;
    const prevClose = ltp != null && nc != null ? ltp - nc : (s.baseline?.futPrevClose ?? null);
    const priceChangePct = ltp != null && prevClose != null && prevClose > 0 ? ((ltp - prevClose) / prevClose) * 100 : null;
    const oi = typeof fq?.oi === "number" ? fq.oi : null;
    const prevOi = s.baseline?.futPrevOi ?? null;
    const oiChange = oi != null && prevOi != null ? oi - prevOi : null;
    const oiChangePct = oiChange != null && prevOi && prevOi > 0 ? (oiChange / prevOi) * 100 : null;
    const ts = parseUpstoxTs(fq?.last_trade_time) ?? parseUpstoxTs(fq?.timestamp);
    return {
      ltp,
      volume: fq?.volume ?? null,
      oi,
      oiChange,
      oiChangePct,
      priceChangePct,
      signal: futuresSignal(priceChangePct, oiChangePct),
      dataStatus: fq ? freshnessStatus(ts) : "UNAVAILABLE",
      expiry: s.u.futuresExpiry ? istDateString(new Date(s.u.futuresExpiry)) : null,
    };
  }

  private async computeAllStage1() {
    const now = Date.now();
    // live index return (same series RS is measured against) — read-only input
    const niftyRetNow = this.niftyRing.length ? this.niftyRing[this.niftyRing.length - 1].ltp : null;
    for (const s of this.symbols.values()) {
      const q = s.quote;
      const nc = q?.net_change ?? null;
      const ltp = q?.last_price ?? null;
      const prevClose = ltp != null && nc != null ? ltp - nc : (s.baseline?.pdc ?? null);
      const ts = parseUpstoxTs(q?.last_trade_time) ?? parseUpstoxTs(q?.timestamp);
      let status: DataStatus = freshnessStatus(ts ?? (ltp != null ? s.ring[s.ring.length - 1]?.ts : null));
      if (ltp != null && status !== "UNAVAILABLE") {
        const missing = q?.ohlc?.open == null || q?.average_price == null;
        if (missing && status === "LIVE") status = "PARTIAL";
      }
      const trendStaleMs = s.candles1m ? now - s.candles1m.at : Infinity;
      const st = computeStage1({
        symbol: s.u.symbol,
        quote: {
          ltp,
          prevClose,
          dayOpen: q?.ohlc?.open ?? null,
          dayHigh: q?.ohlc?.high ?? null,
          dayLow: q?.ohlc?.low ?? null,
          dayVolume: q?.volume ?? null,
          vwap: q?.average_price ?? null,
        },
        dataStatus: status as DataStatusCode as DataStatus,
        lastQuoteTs: ts,
        ring: s.ring,
        niftyRing: this.niftyRing,
        baseline: s.baseline ? { avgDailyVolume: s.baseline.avgDailyVolume, volumeBuckets: s.baseline.buckets } : null,
        candles1m: s.candles1m?.data ?? null,
        futures: this.futuresMetricsFor(s),
        config: this.config,
        now,
      });
      st.trend5mStaleSince = trendStaleMs > 180_000 && s.candles1m ? new Date(s.candles1m.at).toISOString() : null;
      st.candlesUpdatedAt = s.candles1m ? new Date(s.candles1m.at).toISOString() : null;
      st.momentumState = s.momentumState;
      st.isStage2Candidate = s.candidate;
      this.transition(s, st);
      s.stage1 = st;

      // ---- ADDITIVE: ORDER FLOW DOMINANCE (independent of pipeline) ----
      // Pure computation over data already collected above; no extra API calls.
      s.orderFlow = computeOrderFlow({
        symbol: s.u.symbol,
        eq: s.quote,
        metrics: st,
        ring: s.ring,
        candles1m: s.candles1m?.data ?? null,
        config: this.config,
        now,
        history: s.dominanceHistory,
        tracker: s.flowTracker,
      });
      const tail = s.dominanceHistory[s.dominanceHistory.length - 1];
      if (!tail || now - tail.ts >= 60_000) {
        s.dominanceHistory.push({ ts: now, buyer: s.orderFlow.buyerScore, seller: s.orderFlow.sellerScore });
        if (s.dominanceHistory.length > 12) s.dominanceHistory.splice(0, s.dominanceHistory.length - 12);
      }

      // ---- ADDITIVE: MOMENTUM RADAR (burst detection, all liquid stocks) ----
      // Runs across the liquid universe (not just candidates) because a burst
      // appears before a stock qualifies for Stage 2. Cached data only.
      if (st.rvol != null) {
        const tailR = s.rvolHistory[s.rvolHistory.length - 1];
        if (!tailR || now - tailR.ts >= 60_000) {
          s.rvolHistory.push({ ts: now, rvol: st.rvol });
          if (s.rvolHistory.length > 15) s.rvolHistory.splice(0, s.rvolHistory.length - 15);
        }
      }
      if (st.liquidityPass === true) {
        try {
          s.radar = computeMomentumRadar({
            symbol: s.u.symbol,
            metrics: st,
            candles1m: s.candles1m?.data ?? null,
            ring: s.ring,
            rvolHistory: s.rvolHistory,
            now,
          });
        } catch {
          s.radar = null;
        }
      } else {
        s.radar = null;
      }

      // ---- ADDITIVE: REVERSAL RADAR (independent module) ----
      // Reads existing outputs (S/R, order flow, option chain) without
      // modifying them. Cached data only — no extra Upstox requests.
      if (st.liquidityPass === true) {
        try {
          s.reversal = computeReversal({
            symbol: s.u.symbol,
            metrics: st,
            candles1m: s.candles1m?.data ?? null,
            optionChain: s.optionChain?.strikes ?? null,
            dynamicSR: s.dynamicSR,
            orderFlow: s.orderFlow,
            niftyChangePct: niftyRetNow,
            tracker: s.reversalTracker,
            now,
          });
          for (const ev of s.reversal.events) {
            this.logEvent(s.u.symbol, "REVERSAL", ev.type, s.reversal.side, s.reversal.reversalScore, { message: ev.message });
          }
        } catch {
          s.reversal = null;
        }
      } else {
        s.reversal = null;
      }
    }
    this.selectCandidates();
    // ADDITIVE: dynamic S/R for Stage-1 filtered stocks (cached data only).
    this.computeDynamicSRForCandidates(now);
  }

  /**
   * Builds the Dynamic S/R engine input from data ALREADY cached by the
   * existing pipeline (quote depth, option chain, candles, baselines) —
   * no additional Upstox requests, no duplicate polling.
   */
  private srInputFor(s: SymbolState, candles: Candle[] | null, now: number) {
    const q = s.quote;
    const tsMs = parseUpstoxTs(q?.last_trade_time) ?? parseUpstoxTs(q?.timestamp);
    return {
      symbol: s.u.symbol,
      ltp: s.stage1?.ltp ?? null,
      vwap: s.stage1?.vwap ?? null,
      candles1m: candles,
      prevDay: {
        high: s.baseline?.pdh ?? null,
        low: s.baseline?.pdl ?? null,
        close: s.baseline?.pdc ?? null,
      },
      dailyAtr: s.baseline?.atr14 ?? null,
      futures: s.stage1!.futures,
      optionChain: s.optionChain?.strikes ?? null,
      optionExpiry: s.optionChain?.expiry ?? s.optionExpiry?.date ?? null,
      tickSize: s.u.tickSize,
      tracker: s.srTracker,
      now,
      depth: q?.depth?.buy || q?.depth?.sell
        ? { buy: q?.depth?.buy ?? [], sell: q?.depth?.sell ?? [] }
        : null,
      dayVolume: s.stage1?.dayVolume ?? null,
      avgDailyVolume: s.baseline?.avgDailyVolume ?? null,
      quoteAgeSec: tsMs != null ? Math.max(0, (now - tsMs) / 1000) : null,
    };
  }

  /**
   * Dynamic S/R engine pass (OI-centric).
   * Runs only for Stage-1 filtered (liquid) candidates, purely over data
   * already cached by the existing pipeline — zero extra Upstox requests.
   */
  private computeDynamicSRForCandidates(now: number) {
    for (const s of this.symbols.values()) {
      if (!s.candidate || !s.stage1) continue;
      const candles = s.candles1m?.data ?? null;
      try {
        s.dynamicSR = computeDynamicSR(this.srInputFor(s, candles, now));
        // Alerts: only real state transitions are emitted by the engine, so
        // this never fires repeatedly for an unchanged state.
        for (const ev of s.dynamicSR.events) {
          this.logEvent(s.u.symbol, "SR", ev.type, s.stage1.direction, s.dynamicSR.nearestSupport?.confidence ?? null, { message: ev.message });
        }
      } catch {
        // never allow the additive module to disturb the main pipeline
        s.dynamicSR = null;
      }
      // ADDITIVE: momentum conviction fusion (uses only cached evidence).
      try {
        s.conviction = computeConviction({
          symbol: s.u.symbol,
          metrics: s.stage1,
          orderFlow: s.orderFlow,
          dynamicSR: s.dynamicSR,
          optionChain: s.optionChain?.strikes ?? null,
          candles1m: candles,
          now,
        });
      } catch {
        s.conviction = null;
      }
    }
  }

  /** Hysteresis state machine: EARLY -> CONFIRMED with score gates. */
  private transition(s: SymbolState, m: Stage1Metrics) {
    const cfg = this.config;
    const dir = m.direction;
    const signMatch = (v: number | null) => v != null && dir != null && Math.sign(v) === (dir === "LONG" ? 1 : -1);
    const earlyOk =
      m.rvol != null &&
      m.rvol >= cfg.rvolThreshold &&
      signMatch(m.rsNiftyPct) &&
      signMatch(m.rsAccelPct);
    const confirmedOk =
      earlyOk &&
      m.momentumScore >= cfg.enterScore * 0.8 &&
      ((dir === "LONG" && m.trend5m === "BULLISH") || (dir === "SHORT" && m.trend5m === "BEARISH")) &&
      m.aboveVwap === (dir === "LONG") &&
      m.dataStatus !== "STALE" &&
      m.dataStatus !== "UNAVAILABLE";

    const prev = s.momentumState;
    let next: MomentumState = prev;
    if (confirmedOk) next = "CONFIRMED_MOMENTUM";
    else if (earlyOk && prev !== "CONFIRMED_MOMENTUM") next = "EARLY_MOMENTUM";
    else if (!earlyOk && prev !== "IDLE") {
      // hysteresis: only drop after sustained weakness
      if (s.belowEnterSince == null) s.belowEnterSince = Date.now();
      if (Date.now() - s.belowEnterSince > 120_000) next = "IDLE";
    }
    if (earlyOk) s.belowEnterSince = null;

    if (next !== prev) {
      s.momentumState = next;
      this.logEvent(s.u.symbol, prev, next, dir ?? null, m.momentumScore, { rvol: m.rvol, rs: m.rsNiftyPct });
    }
  }

  private selectCandidates() {
    const cfg = this.config;
    const all = [...this.symbols.values()].filter((s) => s.stage1 && s.stage1.direction != null);
    // HARD liquidity gate: only stocks whose REAL traded value (day volume ×
    // Upstox VWAP) is verified at or above the configured ₹ crore minimum can
    // become Stage-2 candidates. Unverifiable turnover never passes.
    const liquid = all.filter((s) => s.stage1!.liquidityPass === true);
    const eligible = liquid.filter((s) => s.stage1!.stage2BlockedReasons.length <= 2);
    const longs = eligible.filter((s) => s.stage1!.direction === "LONG").sort((a, b) => b.stage1!.momentumScore - a.stage1!.momentumScore);
    const shorts = eligible.filter((s) => s.stage1!.direction === "SHORT").sort((a, b) => b.stage1!.momentumScore - a.stage1!.momentumScore);

    const cap = cfg.stage2Candidates;
    const chosen = new Map<string, SymbolState>();
    const perSide = Math.ceil(cap / 2);
    // strong threshold entries first
    for (const list of [longs, shorts]) {
      let n = 0;
      for (const s of list) {
        if (n >= perSide) break;
        if (s.stage1!.momentumScore >= cfg.enterScore) {
          chosen.set(s.u.symbol, s);
          n++;
        }
      }
    }
    // hysteresis retention (still subject to the liquidity gate)
    for (const s of liquid) {
      if (s.candidate && !chosen.has(s.u.symbol) && s.stage1!.momentumScore >= cfg.exitScore) {
        s.belowExitScans = 0;
        if (chosen.size < cap) chosen.set(s.u.symbol, s);
      }
    }
    // backfill by rank so the pipe stays populated with the best available
    for (const s of [...longs, ...shorts].sort((a, b) => b.stage1!.momentumScore - a.stage1!.momentumScore)) {
      if (chosen.size >= cap) break;
      if (!chosen.has(s.u.symbol)) chosen.set(s.u.symbol, s);
    }

    for (const s of this.symbols.values()) {
      const nowCand = chosen.has(s.u.symbol);
      if (nowCand !== s.candidate) {
        this.logEvent(s.u.symbol, s.candidate ? "CANDIDATE" : "IDLE", nowCand ? "CANDIDATE" : "DROPPED", s.stage1?.direction ?? null, s.stage1?.momentumScore ?? null, null);
      }
      s.candidate = nowCand;
    }
  }

  candidateList(): SymbolState[] {
    return [...this.symbols.values()].filter((s) => s.candidate);
  }

  /* --------------------------- STAGE 2 — deep analysis ---------------------- */

  private async tickStage2() {
    if (!this.running || !this.client.hasToken()) return;
    const cands = this.candidateList();
    for (const s of cands) {
      await this.analyzeDeep(s).catch(() => void 0);
    }
    this.lastStage2At = Date.now();
  }

  async analyzeDeep(s: SymbolState): Promise<Stage2Result | null> {
    if (!s.stage1 || s.stage1.ltp == null) return null;
    const today = istDateString();

    // daily structure (cache per ~30 min)
    if (!s.daily || Date.now() - s.daily.at > 1800_000) {
      const d = await this.client.historicalCandles(s.u.equityKey, "days", 1, today, shiftDays(today, -45));
      s.daily = { at: Date.now(), data: d };
    }
    if (s.u.futuresKey && (!s.futDaily || Date.now() - s.futDaily.at > 1800_000)) {
      const fd = await this.client.historicalCandles(s.u.futuresKey, "days", 1, today, shiftDays(today, -45)).catch(() => [] as Candle[]);
      s.futDaily = { at: Date.now(), data: fd };
    }
    // fresh intraday candles for the candidate
    const c1 = await this.client.intradayCandles(s.u.equityKey, "minutes", "1").catch(() => null);
    if (c1 && c1.length) s.candles1m = { at: Date.now(), data: c1 };
    const candles1m = s.candles1m?.data ?? [];
    const candles5m = aggregate(candles1m, 5);

    const completedDaily = s.daily.data.filter((c) => istDateString(new Date(c.t)) < today);
    const prevCandle = completedDaily[completedDaily.length - 1] ?? null;
    const atr14v = atr(completedDaily.slice(-20), 14) ?? s.baseline?.atr14 ?? null;
    const prevDay = {
      high: prevCandle?.h ?? s.baseline?.pdh ?? null,
      low: prevCandle?.l ?? s.baseline?.pdl ?? null,
      close: prevCandle?.c ?? s.baseline?.pdc ?? null,
    };
    // keep baseline warm with fresh values
    if (prevCandle && s.baseline) {
      s.baseline.pdh = prevCandle.h;
      s.baseline.pdl = prevCandle.l;
      s.baseline.pdc = prevCandle.c;
    }

    // option expiry resolution (daily cache)
    if (!s.optionExpiry || s.optionExpiry.at < Date.now() - 3600_000) {
      try {
        const contracts = await this.client.optionContracts(s.u.equityKey);
        const expiries = [...new Set(contracts.map((c) => c.expiry).filter((x): x is string => !!x))].sort();
        const exp = expiries.find((e) => e >= today) ?? null;
        s.optionExpiry = { date: exp, at: Date.now() };
      } catch {
        s.optionExpiry = { date: null, at: Date.now() };
      }
    }
    // option chain for the chosen expiry
    let optionStrikes: OptionChainStrike[] | null = null;
    if (s.optionExpiry?.date) {
      if (!s.optionChain || s.optionChain.expiry !== s.optionExpiry.date || Date.now() - s.optionChain.at > 300_000) {
        try {
          const strikes = await this.client.optionChain(s.u.equityKey, s.optionExpiry.date);
          s.optionChain = {
            at: Date.now(),
            expiry: s.optionExpiry.date,
            spot: strikes[0]?.underlying_spot_price ?? null,
            strikes,
          };
        } catch {
          // keep previous chain if any
        }
      }
      optionStrikes = s.optionChain?.strikes ?? null;
    }

    const levels = analyzeLevels({
      ltp: s.stage1.ltp,
      vwap: s.stage1.vwap,
      candles1m,
      candles5m,
      prevDay,
      atr14: atr14v,
      openingRangeMinutes: this.config.openingRangeMinutes,
      optionChain: optionStrikes,
      optionContext: s.optionExpiry?.date ?? null,
      tickSize: s.u.tickSize,
    });

    const setup = buildSetup({
      metrics: s.stage1,
      levels,
      candles5m,
      config: this.config,
      tickSize: s.u.tickSize,
    });

    const result: Stage2Result = {
      symbol: s.u.symbol,
      analyzedAt: new Date().toISOString(),
      direction: s.stage1.direction,
      finalScore: setup.finalScore,
      setupState: setup.plan.setupState,
      support: levels.supports[0] ?? null,
      resistance: levels.resistances[0] ?? null,
      supportNext: levels.supports[1] ?? null,
      resistanceNext: levels.resistances[1] ?? null,
      optionSupport: levels.optionSupport,
      optionResistance: levels.optionResistance,
      allSupports: levels.supports.slice(0, 4),
      allResistances: levels.resistances.slice(0, 4),
      tradePlan: setup.plan,
      explanation: setup.explanation,
      structureNotes: levels.structureNotes,
      scoreBreakdown: setup.scoreBreakdown,
      dataGaps: levels.dataGaps,
    };

    if (s.prevSetupState !== result.setupState) {
      this.logEvent(s.u.symbol, s.prevSetupState, result.setupState, result.direction, result.finalScore, null);
      s.prevSetupState = result.setupState;
    }
    s.stage2 = result;
    return result;
  }

  private logEvent(symbol: string, from: string | null, to: string, direction: string | null, score: number | null, meta: unknown) {
    void db
      .insert(signalEvents)
      .values({ symbol, fromState: from, toState: to, direction, score, meta: meta as Record<string, unknown> | null })
      .catch(() => void 0);
  }

  /* ------------------------------- payloads -------------------------------- */

  getDashboard(): DashboardPayload {
    const phase = marketPhase();
    const stage1s = [...this.symbols.values()].map((s) => s.stage1).filter((x): x is Stage1Metrics => !!x);
    withQuotes(stage1s);
    // Stage-1 surfaces (tape + leaderboards) only show stocks whose REAL
    // traded value clears the configured ₹ crore liquidity minimum.
    const liquidStage1 = stage1s.filter((m) => m.liquidityPass === true);
    const illiquidFiltered = stage1s.length - liquidStage1.length;
    const cand = liquidStage1
      .filter(
        (m) =>
          m.direction != null &&
          (this.symbols.get(m.symbol)?.candidate || m.momentumState !== "IDLE" || m.momentumScore >= this.config.exitScore),
      )
      .sort((a, b) => b.momentumScore - a.momentumScore)
      .slice(0, 40);

    const nq = this.niftyQuote;
    const niftyLtp = nq?.last_price ?? null;
    // NIFTY day return% — single source of truth is the ring (same series
    // that RS is computed against), falling back to instantaneous net_change.
    const nRetLatest = this.niftyRing.length ? this.niftyRing[this.niftyRing.length - 1].ltp : null;
    const niftyPrev = niftyLtp != null && nq?.net_change != null ? niftyLtp - nq.net_change : null;
    const niftyChg =
      nRetLatest ?? (niftyLtp != null && niftyPrev != null && niftyPrev > 0
        ? ((niftyLtp - niftyPrev) / niftyPrev) * 100
        : null);

    let advances: number | null = null;
    let declines: number | null = null;
    let unchanged: number | null = null;
    const dirs = stage1s.filter((m) => m.returnDayPct != null);
    if (dirs.length > 20) {
      advances = dirs.filter((m) => (m.returnDayPct ?? 0) > 0.05).length;
      declines = dirs.filter((m) => (m.returnDayPct ?? 0) < -0.05).length;
      unchanged = dirs.length - advances - declines;
    }

    const regime = (() => {
      if (niftyChg == null) return null;
      const nv = nq?.average_price ?? null;
      const aboveV = nv != null && niftyLtp != null ? niftyLtp >= nv : null;
      if (niftyChg > 0.3 && aboveV) return "RISK-ON";
      if (niftyChg < -0.3 && aboveV === false) return "RISK-OFF";
      return "MIXED";
    })();

    // top setups: candidates with deep analysis, valid states only
    const setups: SetupCardData[] = [];
    for (const s of this.symbols.values()) {
      if (!s.candidate || !s.stage1 || !s.stage2) continue;
      if (["NO_TRADE", "INSUFFICIENT_DATA"].includes(s.stage2.setupState)) continue;
      setups.push({ stage1: s.stage1, stage2: s.stage2 });
    }
    const stateRank = (x: SetupCardData) =>
      x.stage2.setupState === "TRADE_SETUP" ? 0 : x.stage2.setupState === "WAIT_RETEST" ? 1 : 2;
    setups.sort((a, b) => stateRank(a) - stateRank(b) || b.stage2.finalScore - a.stage2.finalScore);

    const early = liquidStage1.filter((m) => m.momentumState === "EARLY_MOMENTUM").sort((a, b) => b.momentumScore - a.momentumScore);
    const confirmed = liquidStage1
      .filter((m) => m.momentumState === "CONFIRMED_MOMENTUM")
      .sort((a, b) => b.momentumScore - a.momentumScore);

    const breakoutWatch = stage1s
      .filter((m) => {
        const st = this.symbols.get(m.symbol);
        if (!st?.stage2) return false;
        return st.stage2.setupState === "WAIT_BREAKOUT" || st.stage2.setupState === "WAIT_RETEST" && st.stage2.direction === "LONG";
      })
      .sort((a, b) => b.momentumScore - a.momentumScore);
    const breakdownWatch = stage1s
      .filter((m) => {
        const st = this.symbols.get(m.symbol);
        if (!st?.stage2) return false;
        return st.stage2.setupState === "WAIT_BREAKDOWN";
      })
      .sort((a, b) => b.momentumScore - a.momentumScore);

    const byRs = liquidStage1.filter((m) => m.rsNiftyPct != null);
    const strongestRs = [...byRs].sort((a, b) => (b.rsNiftyPct ?? 0) - (a.rsNiftyPct ?? 0)).slice(0, 10);
    const strongestRw = [...byRs].sort((a, b) => (a.rsNiftyPct ?? 0) - (b.rsNiftyPct ?? 0)).slice(0, 10);
    const highestRvol = liquidStage1.filter((m) => m.rvol != null).sort((a, b) => (b.rvol ?? 0) - (a.rvol ?? 0)).slice(0, 10);

    const phaseToday = istParts().dayOfWeek >= 1 && istParts().dayOfWeek <= 5;
    const dataStatusMkt = freshnessStatus(
      parseUpstoxTs(nq?.last_trade_time) ?? parseUpstoxTs(nq?.timestamp) ?? this.lastQuoteAt,
    );

    return {
      generatedAt: new Date().toISOString(),
      engine: {
        running: this.running,
        connected: this.connected,
        userName: this.userName,
        lastScanAt: this.lastScanAt ? new Date(this.lastScanAt).toISOString() : null,
        lastStage2At: this.lastStage2At ? new Date(this.lastStage2At).toISOString() : null,
        lastQuoteAt: this.lastQuoteAt ? new Date(this.lastQuoteAt).toISOString() : null,
        cycleMs: this.config.quotePollIntervalSec * 1000,
        marketPhase: phase,
        exchangeStatus: this.exchangeStatus,
        message: this.message ?? (phase === "OPEN" && phaseToday ? null : null),
        tokenInvalid: this.tokenInvalid,
      },
      market: {
        niftyLtp,
        niftyChangePct: niftyChg,
        niftyOpen: nq?.ohlc?.open ?? null,
        niftyVwap: nq?.average_price ?? null,
        regime,
        advances,
        declines,
        unchanged,
        dataStatus: dataStatusMkt,
      },
      universe: {
        total: this.universe.length,
        withQuotes: dirs.length,
        universeUpdatedAt: this.universeUpdatedAt ? new Date(this.universeUpdatedAt).toISOString() : null,
        baselinesReady: this.baselinesReady,
        baselineProgress: this.baselineTarget > 0 ? this.baselinesReady / this.baselineTarget : 0,
        illiquidFiltered,
        liquidCount: liquidStage1.length,
      },
      pipeline: {
        stage1Scanned: stage1s.length,
        earlyMomentum: early.length,
        confirmedMomentum: confirmed.length,
        candidatesLong: this.candidateList().filter((s) => s.stage1?.direction === "LONG").length,
        candidatesShort: this.candidateList().filter((s) => s.stage1?.direction === "SHORT").length,
        stage2Analyzed: [...this.symbols.values()].filter((s) => s.stage2 != null).length,
        setups: setups.length,
      },
      config: this.config,
      topSetups: setups.slice(0, this.config.topNSetups),
      earlyMomentum: early.slice(0, 15),
      confirmedMomentum: confirmed.slice(0, 15),
      breakoutWatch: breakoutWatch.slice(0, 10),
      breakdownWatch: breakdownWatch.slice(0, 10),
      strongestRs,
      strongestRw,
      highestRvol,
      candidates: cand,
    };
  }

  /**
   * ADDITIVE: ORDER FLOW DOMINANCE payload — independent module.
   * Top 5 buyer- and seller-dominating F&O stocks from real quote/depth/OI
   * data. Below-threshold, stale or conflicting names never get ranked.
   */
  getOrderFlow(): {
    computedAt: string;
    marketPhase: string;
    engineRunning: boolean;
    universeScanned: number;
    minRankScore: number;
    buyers: OrderFlowResult[];
    sellers: OrderFlowResult[];
    stats: { freshRankable: number; excludedStale: number; conflicting: number; coverageAvg: number };
    qualityStats: { premium: number; good: number; speculative: number; bookSustained: number; absorbed: number };
  } {
    const flows = [...this.symbols.values()]
      .map((s) => s.orderFlow)
      .filter((f): f is OrderFlowResult => !!f);
    const min = ORDERFLOW_MIN_RANK_SCORE;
    // QUALITY-FIRST selection: premium names outrank good ones at the same
    // score, so the lists lead with genuinely high-quality flow stocks.
    const eligible = flows.filter((f) => f.rankable && !f.conflictingFlow);
    const byQuality = (a: (typeof eligible)[number], b: (typeof eligible)[number]) => {
      const q = { PREMIUM: 3, GOOD: 2, ACCEPTABLE: 1, SPECULATIVE: 0, INSUFFICIENT: 0 } as const;
      return q[b.quality] - q[a.quality];
    };
    const rankBuy = [...eligible].sort((a, b) => byQuality(a, b) || b.buyerScore - a.buyerScore);
    const rankSell = [...eligible].sort((a, b) => byQuality(a, b) || b.sellerScore - a.sellerScore);
    const buyers = rankBuy.filter((f) => f.buyerScore >= min).slice(0, 5);
    const sellers = rankSell.filter((f) => f.sellerScore >= min).slice(0, 5);
    const staleCount = flows.filter((f) => !f.dataFresh).length;
    const conflictingCount = flows.filter((f) => f.conflictingFlow).length;
    const coverageAvg = flows.length
      ? Math.round(flows.reduce((a, f) => a + f.coveragePct, 0) / flows.length)
      : 0;
    return {
      computedAt: new Date().toISOString(),
      marketPhase: marketPhase(),
      engineRunning: this.running,
      universeScanned: flows.length,
      minRankScore: min,
      buyers,
      sellers,
      stats: {
        freshRankable: eligible.length,
        excludedStale: staleCount,
        conflicting: conflictingCount,
        coverageAvg,
      },
      qualityStats: {
        premium: flows.filter((f) => f.quality === "PREMIUM").length,
        good: flows.filter((f) => f.quality === "GOOD").length,
        speculative: flows.filter((f) => f.quality === "SPECULATIVE").length,
        bookSustained: flows.filter((f) => f.bookSustained === true).length,
        absorbed: flows.filter((f) => f.buyerAbsorption || f.sellerAbsorption).length,
      },
    };
  }

  /**
   * ADDITIVE: Reversal Radar payload — stretched stocks ranked by the
   * evidence for REVERSAL versus CONTINUATION. Independent module; reads the
   * existing S/R, order-flow and option-chain outputs without modifying them.
   */
  getReversalRadar(): {
    computedAt: string;
    marketPhase: string;
    engineRunning: boolean;
    evaluated: number;
    stretched: number;
    overboughtReversal: ReversalResult[];
    oversoldReversal: ReversalResult[];
    overboughtContinuation: ReversalResult[];
    oversoldContinuation: ReversalResult[];
    stats: { reversalWatch: number; continuationRisk: number; insufficient: number; highConfidence: number };
  } {
    const all = [...this.symbols.values()].map((s) => s.reversal).filter((r): r is ReversalResult => !!r);
    const usable = all.filter((r) => r.rankable);
    // Ranked by reversal EDGE first (reversal vs continuation), then by score,
    // then by proximity to the opposing S/R barrier — never by RSI alone.
    const rank = (a: ReversalResult, b: ReversalResult) =>
      b.reversalEdge - a.reversalEdge ||
      b.reversalScore - a.reversalScore ||
      Math.abs(a.srDistancePct ?? 99) - Math.abs(b.srDistancePct ?? 99);
    const pick = (cat: string) => usable.filter((r) => r.category === cat).sort(rank);
    return {
      computedAt: new Date().toISOString(),
      marketPhase: marketPhase(),
      engineRunning: this.running,
      evaluated: all.length,
      stretched: all.filter((r) => r.side != null).length,
      overboughtReversal: pick("OVERBOUGHT_REVERSAL_WATCH").slice(0, 10),
      oversoldReversal: pick("OVERSOLD_REVERSAL_WATCH").slice(0, 10),
      overboughtContinuation: pick("OVERBOUGHT_CONTINUATION_RISK").slice(0, 10),
      oversoldContinuation: pick("OVERSOLD_CONTINUATION_RISK").slice(0, 10),
      stats: {
        reversalWatch: all.filter((r) => r.category.includes("REVERSAL_WATCH")).length,
        continuationRisk: all.filter((r) => r.category.includes("CONTINUATION_RISK")).length,
        insufficient: all.filter((r) => r.dataQuality === "INSUFFICIENT").length,
        highConfidence: all.filter((r) => r.confidence === "HIGH").length,
      },
    };
  }

  /**
   * ADDITIVE: Momentum Radar payload — top BUY and SELL momentum bursts with
   * phase context (acceleration / continuation / exhaustion ...).
   */
  getMomentumRadar(): {
    computedAt: string;
    marketPhase: string;
    engineRunning: boolean;
    evaluated: number;
    minScore: number;
    buys: MomentumRadarResult[];
    sells: MomentumRadarResult[];
    watchlist: MomentumRadarResult[];
    stats: { rankable: number; explosive: number; exhaustion: number; stale: number };
  } {
    const all = [...this.symbols.values()].map((s) => s.radar).filter((r): r is MomentumRadarResult => !!r);
    const eligible = all.filter((r) => r.rankable);
    const buys = eligible.filter((r) => r.side === "BUY").sort((a, b) => b.score - a.score).slice(0, 7);
    const sells = eligible.filter((r) => r.side === "SELL").sort((a, b) => b.score - a.score).slice(0, 7);
    // pre-burst watchlist: coiling/building names not already bursting above
    const listed = new Set([...buys, ...sells].map((r) => r.symbol));
    const watchlist = all
      .filter((r) => r.watchable && !listed.has(r.symbol))
      .sort((a, b) => b.readiness - a.readiness)
      .slice(0, 7);
    return {
      computedAt: new Date().toISOString(),
      marketPhase: marketPhase(),
      engineRunning: this.running,
      evaluated: all.length,
      minScore: RADAR_MIN_SCORE,
      buys,
      sells,
      watchlist,
      stats: {
        rankable: eligible.length,
        explosive: all.filter((r) => r.grade === "EXPLOSIVE").length,
        exhaustion: all.filter((r) => r.phase === "EXHAUSTION" || r.phase === "REVERSAL").length,
        stale: all.filter((r) => r.dataStatus !== "LIVE" && r.dataStatus !== "RECENT").length,
      },
    };
  }

  /**
   * ADDITIVE: Momentum Conviction payload — top LONG (buying) and top SHORT
   * (selling) intraday candidates fused from price action, order positioning,
   * option chain, volume, futures, RS and S/R location.
   */
  getConviction(): {
    computedAt: string;
    marketPhase: string;
    engineRunning: boolean;
    evaluated: number;
    minScore: number;
    longs: ConvictionResult[];
    shorts: ConvictionResult[];
    stats: { rankable: number; conflicted: number; stale: number; coverageAvg: number };
  } {
    const all = [...this.symbols.values()]
      .map((s) => s.conviction)
      .filter((c): c is ConvictionResult => !!c);
    const eligible = all.filter((c) => c.rankable);
    const longs = eligible
      .filter((c) => c.side === "LONG")
      .sort((a, b) => b.longScore - a.longScore)
      .slice(0, 5);
    const shorts = eligible
      .filter((c) => c.side === "SHORT")
      .sort((a, b) => b.shortScore - a.shortScore)
      .slice(0, 5);
    return {
      computedAt: new Date().toISOString(),
      marketPhase: marketPhase(),
      engineRunning: this.running,
      evaluated: all.length,
      minScore: CONVICTION_MIN_SCORE,
      longs,
      shorts,
      stats: {
        rankable: eligible.length,
        conflicted: all.filter((c) => c.conviction === "CONFLICTED").length,
        stale: all.filter((c) => c.dataStatus !== "LIVE" && c.dataStatus !== "RECENT").length,
        coverageAvg: all.length ? Math.round(all.reduce((a, c) => a + c.coveragePct, 0) / all.length) : 0,
      },
    };
  }

  /** ADDITIVE: Dynamic S/R payload for all Stage-1 filtered stocks. */
  getDynamicSR(): {
    computedAt: string;
    marketPhase: string;
    engineRunning: boolean;
    candidates: number;
    rows: { symbol: string; direction: string | null; dataStatus: string; sr: DynamicSRResult }[];
  } {
    const rows: { symbol: string; direction: string | null; dataStatus: string; sr: DynamicSRResult }[] = [];
    for (const s of this.symbols.values()) {
      if (!s.candidate || !s.dynamicSR || !s.stage1) continue;
      rows.push({
        symbol: s.u.symbol,
        direction: s.stage1.direction,
        dataStatus: s.stage1.dataStatus,
        sr: s.dynamicSR,
      });
    }
    // nearest meaningful zones first: strongest immediate context on top
    rows.sort((a, b) => {
      const an = Math.min(a.sr.distanceToSupportPct ?? 99, a.sr.distanceToResistancePct ?? 99);
      const bn = Math.min(b.sr.distanceToSupportPct ?? 99, b.sr.distanceToResistancePct ?? 99);
      return an - bn;
    });
    return {
      computedAt: new Date().toISOString(),
      marketPhase: marketPhase(),
      engineRunning: this.running,
      candidates: rows.length,
      rows,
    };
  }

  /** ADDITIVE: on-demand dynamic S/R for a single symbol (detail page). */
  getDynamicSRFor(symbol: string): DynamicSRResult | null {
    const s = this.symbols.get(symbol);
    if (!s || !s.stage1) return null;
    try {
      s.dynamicSR = computeDynamicSR(this.srInputFor(s, s.candles1m?.data ?? null, Date.now()));
    } catch {
      /* keep previous value */
    }
    return s.dynamicSR;
  }

  async getStockDetail(symbol: string): Promise<StockDetailPayload | null> {
    const s = this.symbols.get(symbol);
    if (!s) return null;
    // ensure deep analysis freshness for viewing (respect rate limits)
    if (this.running && this.connected && s.stage1?.ltp != null) {
      const stale = !s.stage2 || Date.now() - new Date(s.stage2.analyzedAt).getTime() > 90_000;
      if (stale) await this.analyzeDeep(s).catch(() => void 0);
    }
    const candles1m = s.candles1m?.data ?? [];
    const candles5m = aggregate(candles1m, 5);

    let optionRows: OptionChainRow[] = [];
    let optionPcr: number | null = null;
    if (s.optionChain?.strikes?.length) {
      const spot = s.optionChain.spot ?? s.stage1?.ltp ?? 0;
      const strikes = s.optionChain.strikes
        .filter((r) => r.strike_price != null && spot > 0 && Math.abs(r.strike_price! - spot) / spot <= 0.08)
        .sort((a, b) => (a.strike_price ?? 0) - (b.strike_price ?? 0));
      let totCe = 0;
      let totPe = 0;
      for (const r of s.optionChain.strikes) {
        totCe += r.call_options?.market_data?.oi ?? 0;
        totPe += r.put_options?.market_data?.oi ?? 0;
      }
      optionPcr = totCe > 0 ? totPe / totCe : null;
      optionRows = strikes.map((r) => {
        const ce = r.call_options?.market_data;
        const pe = r.put_options?.market_data;
        let highlight: OptionChainRow["highlight"] = null;
        if (s.stage2?.optionSupport?.strike === r.strike_price) highlight = "SUPPORT";
        if (s.stage2?.optionResistance?.strike === r.strike_price)
          highlight = highlight === "SUPPORT" ? "BOTH" : "RESISTANCE";
        return {
          strike: r.strike_price ?? 0,
          ceOi: ce?.oi ?? null,
          ceOiChange: ce?.oi != null && ce?.prev_oi != null ? ce.oi - ce.prev_oi : null,
          ceVolume: ce?.volume ?? null,
          ceLtp: ce?.ltp ?? null,
          peOi: pe?.oi ?? null,
          peOiChange: pe?.oi != null && pe?.prev_oi != null ? pe.oi - pe.prev_oi : null,
          peVolume: pe?.volume ?? null,
          peLtp: pe?.ltp ?? null,
          highlight,
          pcrNote: r.pcr != null ? `PCR ${r.pcr.toFixed(2)}` : null,
        };
      });
    }

    const fm = this.futuresMetricsFor(s);
    const prevFutClose = s.baseline?.futPrevClose ?? null;
    const basis = fm.ltp != null && s.stage1?.ltp != null ? fm.ltp - s.stage1.ltp : null;
    const dataStatus = (s.stage1?.dataStatus ?? "UNAVAILABLE") as StockDetailPayload["dataStatus"];

    return {
      symbol: s.u.symbol,
      name: s.u.name,
      equityKey: s.u.equityKey,
      futuresKey: s.u.futuresKey,
      futuresExpiry: fm.expiry,
      stage1: s.stage1,
      stage2: s.stage2,
      candles1m: candles1m.slice(-375),
      candles5m: candles5m.slice(-200),
      optionChain: optionRows,
      optionExpiry: s.optionChain?.expiry ?? s.optionExpiry?.date ?? null,
      optionPcr,
      spotPrice: s.stage1?.ltp ?? s.optionChain?.spot ?? null,
      futures: {
        ltp: fm.ltp,
        prevClose: prevFutClose,
        volume: fm.volume,
        oi: fm.oi,
        oiChange: fm.oiChange,
        basis,
        basisPct: basis != null && s.stage1?.ltp ? (basis / s.stage1.ltp) * 100 : null,
        signal: fm.signal,
        dataStatus: fm.dataStatus,
      },
      baseline: {
        avgDailyVolume: s.baseline?.avgDailyVolume ?? null,
        pdh: s.baseline?.pdh ?? null,
        pdl: s.baseline?.pdl ?? null,
        pdc: s.baseline?.pdc ?? null,
        atr14: s.baseline?.atr14 ?? null,
      },
      marketPhase: marketPhase(),
      dataStatus,
      generatedAt: new Date().toISOString(),
      dynamicSR: this.getDynamicSRFor(symbol) ?? null,
    };
  }
}

/* --------------------------------- helpers -------------------------------- */

function shiftDays(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + delta * 86400_000);
  return dt.toISOString().slice(0, 10);
}

function withQuotes(_a: Stage1Metrics[]) {
  return _a.length;
}
