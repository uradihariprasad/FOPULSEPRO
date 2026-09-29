/**
 * Server-side Upstox API client.
 *
 * - Token is injected per instance and NEVER logged or returned to callers.
 * - Per-bucket rate limiting (quotes / candles / options / other).
 * - Transparent retries with exponential backoff on 429/5xx.
 * - 401 raises TokenInvalidError so the service can pause and surface it.
 */

import type {
  FullQuoteResponse,
  FullMarketQuote,
  OptionChainResponse,
  OptionContractsResponse,
  OptionChainStrike,
  OptionContract,
  UserProfileResponse,
  V3CandleResponse,
  MarketStatusResponse,
} from "./types";
import type { Candle } from "@/lib/engine/types";

const BASE = "https://api.upstox.com";

export class UpstoxError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = "UpstoxError";
  }
}

export class TokenInvalidError extends Error {
  constructor() {
    super("Upstox access token invalid or expired (401)");
    this.name = "TokenInvalidError";
  }
}

export class RateLimitedError extends Error {
  constructor() {
    super("Upstox rate limit hit (429) after retries");
    this.name = "RateLimitedError";
  }
}

type Bucket = "quote" | "candle" | "option" | "other";

const BUCKET_RPS: Record<Bucket, number> = {
  quote: 10, // batch quote calls are cheap and light
  candle: 4, // be conservative with historical/intraday candle API
  option: 5,
  other: 3,
};

class RateGate {
  private nextAt = 0;
  constructor(private rps: number) {}
  async wait(): Promise<void> {
    const now = Date.now();
    const minGap = 1000 / this.rps;
    const at = Math.max(now, this.nextAt) + minGap;
    this.nextAt = at;
    const delay = at - Date.now();
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }
}

export class UpstoxClient {
  private token: string | null = null;
  private gates: Record<Bucket, RateGate> = {
    quote: new RateGate(BUCKET_RPS.quote),
    candle: new RateGate(BUCKET_RPS.candle),
    option: new RateGate(BUCKET_RPS.option),
    other: new RateGate(BUCKET_RPS.other),
  };
  public callsToday = 0;
  public lastError: string | null = null;

  setToken(token: string | null) {
    this.token = token;
  }
  hasToken(): boolean {
    return !!this.token;
  }

  private async request<T>(
    path: string,
    params: Record<string, string> | null,
    bucket: Bucket,
    attempt = 0,
  ): Promise<T> {
    if (!this.token) throw new UpstoxError(0, "No Upstox token configured");
    await this.gates[bucket].wait();
    const qs = params ? `?${new URLSearchParams(params).toString()}` : "";
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), 20000);
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}${qs}`, {
        method: "GET",
        signal: ctrl.signal,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
        },
      });
    } catch (e) {
      clearTimeout(kill);
      if (attempt < 2) {
        await this.backoff(attempt);
        return this.request(path, params, bucket, attempt + 1);
      }
      this.lastError = e instanceof Error ? e.message : "network error";
      throw new UpstoxError(0, `Network failure: ${this.lastError}`);
    } finally {
      clearTimeout(kill);
    }
    this.callsToday += 1;
    if (res.status === 401) throw new TokenInvalidError();
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 3) {
        await this.backoff(attempt);
        return this.request(path, params, bucket, attempt + 1);
      }
      if (res.status === 429) throw new RateLimitedError();
      throw new UpstoxError(res.status, `Upstox HTTP ${res.status}`);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      throw new UpstoxError(res.status, "Invalid JSON from Upstox");
    }
    if (!res.ok) {
      const msg =
        (json as { errors?: { message?: string }[] })?.errors?.[0]?.message ??
        `Upstox HTTP ${res.status}`;
      throw new UpstoxError(res.status, msg, json);
    }
    return json as T;
  }

  private async backoff(attempt: number) {
    await new Promise((r) => setTimeout(r, Math.min(8000, 500 * Math.pow(2, attempt) + Math.random() * 250)));
  }

  /* ------------------------------ endpoints ------------------------------ */

  async profile(): Promise<UserProfileResponse["data"]> {
    const res = await this.request<UserProfileResponse>("/v2/user/profile", null, "other");
    return res.data ?? {};
  }

  async exchangeStatus(): Promise<string | null> {
    try {
      const res = await this.request<MarketStatusResponse>("/v2/market/status/NSE", null, "other");
      const d = res.data as { status?: string } | undefined;
      return d?.status ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Batch market quotes via the v2 Market Quote endpoint — includes
   * last_price, average_price (session VWAP), volume, OI (F&O), depth,
   * day OHLC, net_change and timestamps. Returns a map keyed by
   * instrument_token (= instrument key). Chunks are fault-isolated so one
   * stale instrument cannot poison the whole batch.
   */
  async fullQuotes(instrumentKeys: string[], chunkSize = 480): Promise<Map<string, FullMarketQuote>> {
    const out = new Map<string, FullMarketQuote>();
    if (instrumentKeys.length === 0) return out;
    const step = Math.max(20, Math.min(480, chunkSize));
    let firstError: Error | null = null;
    for (let i = 0; i < instrumentKeys.length; i += step) {
      const slice = instrumentKeys.slice(i, i + step);
      try {
        const res = await this.request<FullQuoteResponse>(
          "/v2/market-quote/quotes",
          { instrument_key: slice.join(",") },
          "quote",
        );
        if (res.data) {
          for (const [respKey, q] of Object.entries(res.data)) {
            const token = q.instrument_token || respKey;
            out.set(token, q);
          }
        }
      } catch (e) {
        if (e instanceof TokenInvalidError) throw e; // fatal — surface up
        if (!firstError) firstError = e instanceof Error ? e : new Error(String(e));
        // continue with remaining chunks
      }
    }
    if (out.size === 0 && firstError) throw firstError;
    return out;
  }

  /** Intraday candles for today — v3. unit: minutes (1..300) / hours. */
  async intradayCandles(
    instrumentKey: string,
    unit: "minutes" | "hours" = "minutes",
    interval = "1",
  ): Promise<Candle[]> {
    const res = await this.request<V3CandleResponse>(
      `/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/${unit}/${interval}`,
      null,
      "candle",
    );
    return parseV3Candles(res);
  }

  /** Historical candles — v3. unit minutes/hours/days/weeks/months. */
  async historicalCandles(
    instrumentKey: string,
    unit: "minutes" | "hours" | "days" | "weeks" | "months",
    interval: string | number,
    toDate: string,
    fromDate?: string,
  ): Promise<Candle[]> {
    const res = await this.request<V3CandleResponse>(
      `/v3/historical-candle/${encodeURIComponent(instrumentKey)}/${unit}/${interval}/${toDate}${fromDate ? `/${fromDate}` : ""}`,
      null,
      "candle",
    );
    return parseV3Candles(res);
  }

  /** Option contracts for an underlying (to resolve current expiries). */
  async optionContracts(instrumentKey: string, expiryDate?: string): Promise<OptionContract[]> {
    const params: Record<string, string> = { instrument_key: instrumentKey };
    if (expiryDate) params.expiry_date = expiryDate;
    const res = await this.request<OptionContractsResponse>("/v2/option/contract", params, "option");
    return res.data ?? [];
  }

  /** Option chain for an underlying & expiry (YYYY-MM-DD or keyword). */
  async optionChain(instrumentKey: string, expiry: string): Promise<OptionChainStrike[]> {
    const res = await this.request<OptionChainResponse>(
      "/v2/option/chain",
      { instrument_key: instrumentKey, expiry_date: expiry },
      "option",
    );
    return res.data ?? [];
  }
}

function parseV3Candles(res: V3CandleResponse): Candle[] {
  const raw = res.data?.candles;
  if (!Array.isArray(raw)) return [];
  const out: Candle[] = [];
  for (const c of raw) {
    if (!Array.isArray(c) || c.length < 6) continue;
    const t = new Date(c[0]).getTime();
    if (!Number.isFinite(t)) continue;
    out.push({
      t,
      o: num(c[1]),
      h: num(c[2]),
      l: num(c[3]),
      c: num(c[4]),
      v: num(c[5]),
      oi: c.length > 6 && Number.isFinite(c[6]) ? c[6] : null,
    });
  }
  // v3 returns newest-first; normalize ascending
  out.sort((a, b) => a.t - b.t);
  return out;
}

function num(v: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Upstox timestamps are inconsistent: `timestamp` is an ISO-8601 string with
 * IST offset; `last_trade_time` is epoch-milliseconds serialised as string.
 * Parse ANY of them into epoch ms, or null when unusable.
 */
export function parseUpstoxTs(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const asNum = Number(v);
  if (Number.isFinite(asNum) && v.trim() !== "") {
    // epoch millis (guard: plausible range)
    if (asNum > 1_000_000_000_000 && asNum < 2_000_000_000_000) return asNum;
    return null;
  }
  const parsed = Date.parse(v);
  return Number.isNaN(parsed) ? null : parsed;
}
