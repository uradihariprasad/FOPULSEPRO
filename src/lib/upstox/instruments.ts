/**
 * Universe builder — derives the CURRENT active NSE F&O universe from the
 * official Upstox instrument master (NSE.json.gz). Runs daily and on demand,
 * so newly listed F&O stocks appear and expired contracts roll automatically.
 * No hard-coded symbol lists anywhere.
 */

import zlib from "node:zlib";
import type { UpstoxInstrument } from "./types";
import type { UniverseSymbol } from "@/lib/engine/types";
import { istNow } from "@/lib/market/time";

const NSE_MASTER_URL =
  "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";

let cachedJson: { at: number; instruments: UpstoxInstrument[] } | null = null;

export async function downloadInstrumentMaster(force = false): Promise<UpstoxInstrument[]> {
  const ageMs = cachedJson ? Date.now() - cachedJson.at : Infinity;
  if (!force && cachedJson && ageMs < 8 * 3600 * 1000) return cachedJson.instruments;
  const res = await fetch(NSE_MASTER_URL);
  if (!res.ok) throw new Error(`Instrument master download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  let text: string;
  try {
    text = zlib.gunzipSync(buf).toString("utf8");
  } catch {
    text = buf.toString("utf8"); // fallback if not gzipped
  }
  const instruments = JSON.parse(text) as UpstoxInstrument[];
  cachedJson = { at: Date.now(), instruments };
  return instruments;
}

const FUT_TYPES = new Set(["FUT", "FUTSTK"]);

export function buildUniverse(instruments: UpstoxInstrument[]): UniverseSymbol[] {
  const now = istNow().getTime();
  const equityByKey = new Map<string, UpstoxInstrument>();
  for (const i of instruments) {
    if (i.segment === "NSE_EQ" && i.instrument_type === "EQ" && i.instrument_key) {
      equityByKey.set(i.instrument_key, i);
    }
  }

  // Group current & near-month equity futures by underlying.
  const byUnderlying = new Map<string, UpstoxInstrument[]>();
  for (const i of instruments) {
    if (
      i.segment === "NSE_FO" &&
      i.underlying_type === "EQUITY" &&
      i.instrument_type &&
      FUT_TYPES.has(i.instrument_type) &&
      i.instrument_key &&
      i.underlying_symbol
    ) {
      const expiry = typeof i.expiry === "number" ? i.expiry : i.expiry ? new Date(i.expiry).getTime() : 0;
      // keep contracts expiring today or later (expiry day is tradeable)
      if (expiry && expiry < now - 24 * 3600 * 1000) continue;
      const list = byUnderlying.get(i.underlying_symbol) ?? [];
      list.push({ ...i, expiry });
      byUnderlying.set(i.underlying_symbol, list);
    }
  }

  const out: UniverseSymbol[] = [];
  for (const [symbol, futs] of byUnderlying) {
    futs.sort((a, b) => (Number(a.expiry) || 0) - (Number(b.expiry) || 0));
    const front = futs[0];
    const eqKey = front.underlying_key ?? null;
    const eq = eqKey ? equityByKey.get(eqKey) : undefined;
    if (!eq || !eq.instrument_key) continue; // cannot scan spot without equity key
    out.push({
      symbol,
      name: eq.name || front.name || symbol,
      isin: eq.isin ?? null,
      equityKey: eq.instrument_key,
      futuresKey: front.instrument_key ?? null,
      futuresTradingSymbol: front.trading_symbol ?? null,
      futuresExpiry: front.expiry ? Number(front.expiry) : null,
      lotSize: front.lot_size != null ? Number(front.lot_size) : null,
      tickSize: front.tick_size != null ? Number(front.tick_size) : null,
    });
  }
  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return out;
}

/** Find NIFTY 50 index instrument key from the master (fallback constant). */
export function findNiftyKey(instruments: UpstoxInstrument[]): string {
  for (const i of instruments) {
    if (
      i.segment === "NSE_INDEX" &&
      i.instrument_key &&
      (i.name === "Nifty 50" ||
        (i.trading_symbol ?? "").replace(/\s+/g, " ").toUpperCase() === "NIFTY 50")
    ) {
      return i.instrument_key;
    }
  }
  return "NSE_INDEX|Nifty 50";
}
