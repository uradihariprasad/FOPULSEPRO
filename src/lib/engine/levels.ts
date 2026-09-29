/**
 * Combined dynamic support/resistance zone engine (Stage 2).
 *
 * Merges INDEPENDENT real evidence into overlapping zones:
 *   previous-day structure, opening range, swing structure, consolidation,
 *   volume-profile concentrations, VWAP and option-chain OI positioning.
 * Each zone receives a 0-100 confluence score. No synthetic levels — every
 * zone is derived from actual Upstox OHLCV or option-chain data.
 */

import type {
  Candle,
  LevelSource,
  OptionStrikeInfo,
  SRZone,
  ZoneMember,
} from "./types";
import type { OptionChainStrike } from "@/lib/upstox/types";
import { atr, clamp, swings, swingStructure } from "./indicators";

export interface LevelEngineInput {
  ltp: number;
  vwap: number | null;
  candles1m: Candle[];
  candles5m: Candle[];
  prevDay: { high: number | null; low: number | null; close: number | null };
  atr14: number | null;
  openingRangeMinutes: number;
  optionChain: OptionChainStrike[] | null;
  optionContext: string | null; // descriptive (e.g. "expiry 2025-01-30")
  tickSize: number | null;
}

export interface LevelEngineOutput {
  supports: SRZone[];
  resistances: SRZone[];
  optionSupport: OptionStrikeInfo | null;
  optionResistance: OptionStrikeInfo | null;
  topStrikes: OptionStrikeInfo[];
  structureNotes: string[];
  dataGaps: string[];
  pocPrice: number | null;
  swingPattern: string;
}

interface LevelPoint {
  source: LevelSource;
  price: number;
  weight: number;
  detail?: string;
  time?: number;
}

export function analyzeLevels(input: LevelEngineInput): LevelEngineOutput {
  const gaps: string[] = [];
  const notes: string[] = [];
  const points: LevelPoint[] = [];
  const { ltp } = input;
  const tolerance = Math.max(
    input.atr14 ? input.atr14 / 4 : 0,
    ltp * 0.0015,
    input.tickSize ?? 0,
  );

  /* -------------------- price-structure level points -------------------- */

  if (input.prevDay.high != null)
    points.push({ source: "PREV_DAY_HIGH", price: input.prevDay.high, weight: 0.8, detail: "Previous day high" });
  if (input.prevDay.low != null)
    points.push({ source: "PREV_DAY_LOW", price: input.prevDay.low, weight: 0.8, detail: "Previous day low" });
  if (input.prevDay.close != null)
    points.push({ source: "PREV_DAY_CLOSE", price: input.prevDay.close, weight: 0.7, detail: "Previous day close" });
  if (input.prevDay.high == null) gaps.push("Previous-day OHLC unavailable");

  const c1 = input.candles1m;
  if (c1.length > 0) {
    points.push({ source: "OPEN", price: c1[0].o, weight: 0.5, detail: "Day open" });
    const orb = c1.slice(0, Math.max(1, input.openingRangeMinutes));
    const orh = Math.max(...orb.map((c) => c.h));
    const orl = Math.min(...orb.map((c) => c.l));
    points.push({ source: "OPENING_RANGE_HIGH", price: orh, weight: 0.7, detail: `Opening range high (${input.openingRangeMinutes}m)` });
    points.push({ source: "OPENING_RANGE_LOW", price: orl, weight: 0.7, detail: `Opening range low (${input.openingRangeMinutes}m)` });
  } else {
    gaps.push("Intraday 1-minute candles unavailable");
  }

  // Swings on 5m (structure) and 1m (granular)
  const sw5 = input.candles5m.length >= 12 ? swings(input.candles5m, 2) : [];
  const sw1 = c1.length >= 15 ? swings(c1, 4) : [];
  const lastIdx5 = input.candles5m.length - 1;
  const lastIdx1 = c1.length - 1;
  for (const s of sw5.slice(-14)) {
    const recency = clamp(1 - (lastIdx5 - s.index) / Math.max(10, lastIdx5 + 1), 0.25, 1);
    points.push({
      source: s.kind === "HIGH" ? "SWING_HIGH" : "SWING_LOW",
      price: s.price,
      weight: 0.45 + 0.45 * recency,
      detail: s.kind === "HIGH" ? "5-min swing high" : "5-min swing low",
      time: s.time,
    });
  }
  for (const s of sw1.slice(-10)) {
    const recency = clamp(1 - (lastIdx1 - s.index) / Math.max(10, lastIdx1 + 1), 0.2, 1);
    points.push({
      source: s.kind === "HIGH" ? "SWING_HIGH" : "SWING_LOW",
      price: s.price,
      weight: 0.35 + 0.35 * recency,
      detail: s.kind === "HIGH" ? "1-min swing high" : "1-min swing low",
      time: s.time,
    });
  }

  const structure = swingStructure(sw5);
  const patternLabel =
    structure.pattern === "HH_HL"
      ? "Higher highs & higher lows (5-min)"
      : structure.pattern === "LH_LL"
        ? "Lower highs & lower lows (5-min)"
        : structure.pattern === "MIXED"
          ? "Mixed swing structure (5-min)"
          : "Insufficient swings for structure";

  // Consolidation zones on 5-min closes
  if (input.candles5m.length >= 10) {
    const closes = input.candles5m.map((c) => c.c);
    const widths = Math.max(input.atr14 ? input.atr14 / 6 : 0, ltp * 0.0025);
    const used = new Array(closes.length).fill(false);
    const zonesFound: { center: number; touches: number; lo: number; hi: number }[] = [];
    for (let i = 0; i < closes.length; i++) {
      if (used[i]) continue;
      const idxs: number[] = [];
      for (let j = 0; j < closes.length; j++) {
        if (Math.abs(closes[j] - closes[i]) <= widths) {
          idxs.push(j);
        }
      }
      if (idxs.length >= 6) {
        const members = idxs.map((j) => closes[j]);
        zonesFound.push({
          center: members.reduce((a, b) => a + b, 0) / members.length,
          touches: idxs.length,
          lo: Math.min(...members),
          hi: Math.max(...members),
        });
        idxs.forEach((j) => (used[j] = true));
      }
    }
    zonesFound.sort((a, b) => b.touches - a.touches);
    for (const z of zonesFound.slice(0, 2)) {
      points.push({
        source: "CONSOLIDATION",
        price: z.center,
        weight: clamp(0.4 + z.touches / 20, 0.4, 1),
        detail: `Consolidation (${z.touches} closes in ${z.lo.toFixed(2)}-${z.hi.toFixed(2)})`,
      });
    }
  }

  // Volume profile on 1-minute bars: bin actual traded volume by typical price
  let pocPrice: number | null = null;
  if (c1.length >= 20) {
    const binW = Math.max(input.atr14 ? input.atr14 / 8 : 0, ltp * 0.001, input.tickSize ?? 0);
    const bins = new Map<number, number>();
    let dayVol = 0;
    for (const c of c1) {
      if (c.v <= 0) continue;
      const tp = (c.h + c.l + c.c) / 3;
      const key = Math.round(tp / binW) * binW;
      bins.set(key, (bins.get(key) ?? 0) + c.v);
      dayVol += c.v;
    }
    if (bins.size > 0 && dayVol > 0) {
      const avg = dayVol / bins.size;
      const ranked = [...bins.entries()].sort((a, b) => b[1] - a[1]);
      pocPrice = ranked[0][0];
      let added = 0;
      for (const [price, vol] of ranked.slice(0, 4)) {
        if (vol < avg * 1.8 || added >= 2) continue;
        points.push({
          source: "VOLUME_PROFILE",
          price,
          weight: clamp(vol / ranked[0][1], 0.4, 1) * 0.75,
          detail: price === pocPrice ? "Volume POC (1-min typical price)" : "Volume concentration",
        });
        added++;
      }
    }
  }

  // VWAP as a dynamic level
  if (input.vwap != null && input.vwap > 0) {
    points.push({
      source: "VWAP",
      price: input.vwap,
      weight: 0.6,
      detail: ltp >= input.vwap ? "VWAP (price above)" : "VWAP (price below)",
    });
  }

  /* ---------------------- option-chain level points --------------------- */

  const { supportStrike, resistanceStrike, topStrikes } = analyzeOptionStrikes(
    input.optionChain ?? [],
    ltp,
    c1,
  );
  if (!input.optionChain || input.optionChain.length === 0) {
    gaps.push("Option chain unavailable");
  }
  for (const s of topStrikes) {
    if (s.score < 45) continue;
    points.push({
      source: s.side === "CE" ? "OPTION_CE_OI" : "OPTION_PE_OI",
      price: s.strike,
      weight: clamp(s.score / 100, 0.35, 1),
      detail: `${s.side} strike ${s.strike} — OI ${s.oi ?? "N/A"}`,
    });
  }

  /* --------------------------- zone building ---------------------------- */

  if (points.length === 0) {
    return {
      supports: [],
      resistances: [],
      optionSupport: supportStrike,
      optionResistance: resistanceStrike,
      topStrikes,
      structureNotes: notes,
      dataGaps: gaps.length ? gaps : ["INSUFFICIENT DATA for level engine"],
      pocPrice,
      swingPattern: structure.pattern,
    };
  }

  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters: LevelPoint[][] = [];
  let cur: LevelPoint[] = [];
  for (const p of sorted) {
    if (!cur.length || p.price - cur[cur.length - 1].price <= tolerance) {
      cur.push(p);
    } else {
      clusters.push(cur);
      cur = [p];
    }
  }
  if (cur.length) clusters.push(cur);

  const zones: SRZone[] = [];
  const engBuf = Math.max(tolerance * 0.6, ltp * 0.0008);
  for (const cluster of clusters) {
    const prices = cluster.map((p) => p.price);
    const low = Math.min(...prices);
    const high = Math.max(...prices);
    const center = cluster.reduce((a, p) => a + p.price * p.weight, 0) /
      cluster.reduce((a, p) => a + p.weight, 0);

    // touches: 1m candle lows/highs overlapping zone (real reactions)
    let touches = 0;
    for (const c of c1) {
      if ((c.l <= high + engBuf && c.l >= low - engBuf) || (c.h <= high + engBuf && c.h >= low - engBuf)) touches++;
    }

    const engulfing = ltp >= low - engBuf && ltp <= high + engBuf;
    const kind: SRZone["kind"] = engulfing
      ? (center <= ltp ? "SUPPORT" : "RESISTANCE")
      : center < ltp
        ? "SUPPORT"
        : "RESISTANCE";

    // Retest promotion notes
    const members: ZoneMember[] = cluster.map((p) => ({ source: p.source, price: p.price, detail: p.detail, weight: p.weight }));
    const fromAboveSources = new Set<LevelSource>(["SWING_HIGH", "OPENING_RANGE_HIGH", "PREV_DAY_HIGH"]);
    const fromBelowSources = new Set<LevelSource>(["SWING_LOW", "OPENING_RANGE_LOW", "PREV_DAY_LOW"]);
    let brokeNote = "";
    if (kind === "SUPPORT" && cluster.some((p) => fromAboveSources.has(p.source)) && center < ltp * 0.9985) {
      members.push({ source: "BROKEN_RESISTANCE", price: center, detail: "Broken overhead level now acting as support", weight: 0.5 });
      brokeNote = "old resistance resurfacing as support (retest candidate)";
    }
    if (kind === "RESISTANCE" && cluster.some((p) => fromBelowSources.has(p.source)) && center > ltp * 1.0015) {
      members.push({ source: "BROKEN_SUPPORT", price: center, detail: "Broken support now acting as resistance", weight: 0.5 });
      brokeNote = "old support resurfacing as resistance (retest candidate)";
    }

    zones.push({
      id: "",
      kind,
      low,
      high,
      center,
      strength: 0, // scored below
      sources: [...new Set(members.map((m) => m.source))],
      members,
      touches,
      distancePct: Math.abs(center - ltp) / ltp * 100,
      status: engulfing ? "ENGULFING" : "ACTIVE",
      note: brokeNote,
    });
  }

  // -------- zone strength scoring (0-100 confluence) --------
  const SOURCE_POINTS: Partial<Record<LevelSource, number>> = {
    PREV_DAY_HIGH: 14,
    PREV_DAY_LOW: 14,
    PREV_DAY_CLOSE: 12,
    OPEN: 6,
    OPENING_RANGE_HIGH: 12,
    OPENING_RANGE_LOW: 12,
    SWING_HIGH: 18,
    SWING_LOW: 18,
    CONSOLIDATION: 14,
    VOLUME_PROFILE: 12,
    VWAP: 9,
    OPTION_CE_OI: 22,
    OPTION_PE_OI: 22,
    BROKEN_RESISTANCE: 8,
    BROKEN_SUPPORT: 8,
  };
  for (const z of zones) {
    let score = 0;
    const bySource = new Map<LevelSource, number>();
    for (const m of z.members) {
      bySource.set(m.source, Math.max(bySource.get(m.source) ?? 0, m.weight));
    }
    for (const [src, w] of bySource) {
      score += (SOURCE_POINTS[src] ?? 6) * w;
    }
    score += Math.min(z.touches, 8) * 2; // repeated reactions at the zone
    if (z.sources.includes("VWAP") && z.sources.some((s) => s.startsWith("OPTION"))) score += 4;
    const optionMember = z.members.find((m) => m.source.startsWith("OPTION"));
    const priceStructCount = z.sources.filter((s) =>
      ["PREV_DAY_HIGH", "PREV_DAY_LOW", "PREV_DAY_CLOSE", "OPENING_RANGE_HIGH", "OPENING_RANGE_LOW", "SWING_HIGH", "SWING_LOW", "CONSOLIDATION", "VOLUME_PROFILE", "VWAP"].includes(s),
    ).length;
    if (optionMember && priceStructCount >= 1) score += 10; // independent evidence overlap
    if (priceStructCount >= 3) score += 6;
    // distance penalty — far levels matter less right now
    score -= Math.min(18, z.distancePct * 2.5);
    z.strength = Math.round(clamp(score, 5, 100));
  }

  const supports = zones
    .filter((z) => z.kind === "SUPPORT")
    .sort((a, b) => b.center - a.center);
  const resistances = zones
    .filter((z) => z.kind === "RESISTANCE")
    .sort((a, b) => a.center - b.center);
  supports.forEach((z, i) => (z.id = `S${i + 1}`));
  resistances.forEach((z, i) => (z.id = `R${i + 1}`));

  if (patternLabel !== "Insufficient swings for structure") notes.push(patternLabel);
  if (pocPrice != null) notes.push(`Volume POC near ${pocPrice.toFixed(2)}`);

  return {
    supports,
    resistances,
    optionSupport: supportStrike,
    optionResistance: resistanceStrike,
    topStrikes,
    structureNotes: notes,
    dataGaps: gaps,
    pocPrice,
    swingPattern: structure.pattern,
  };
}

/* ---------------------- option strike analytics ----------------------- */

function analyzeOptionStrikes(
  chain: OptionChainStrike[],
  spot: number,
  candles1m: Candle[],
): { supportStrike: OptionStrikeInfo | null; resistanceStrike: OptionStrikeInfo | null; topStrikes: OptionStrikeInfo[] } {
  if (!chain.length || !Number.isFinite(spot) || spot <= 0) {
    return { supportStrike: null, resistanceStrike: null, topStrikes: [] };
  }
  interface Row { strike: number; ceOi: number; cePrevOi: number; ceVol: number; ceLtp: number | null; peOi: number; pePrevOi: number; peVol: number; peLtp: number | null }
  const rows: Row[] = [];
  for (const s of chain) {
    const strike = s.strike_price;
    if (strike == null || spot === 0) continue;
    if (Math.abs(strike - spot) / spot > 0.1) continue; // reasonable window around price
    rows.push({
      strike,
      ceOi: s.call_options?.market_data?.oi ?? 0,
      cePrevOi: s.call_options?.market_data?.prev_oi ?? 0,
      ceVol: s.call_options?.market_data?.volume ?? 0,
      ceLtp: s.call_options?.market_data?.ltp ?? null,
      peOi: s.put_options?.market_data?.oi ?? 0,
      pePrevOi: s.put_options?.market_data?.prev_oi ?? 0,
      peVol: s.put_options?.market_data?.volume ?? 0,
      peLtp: s.put_options?.market_data?.ltp ?? null,
    });
  }
  if (!rows.length) return { supportStrike: null, resistanceStrike: null, topStrikes: [] };

  const maxCeOi = Math.max(...rows.map((r) => r.ceOi), 1);
  const maxPeOi = Math.max(...rows.map((r) => r.peOi), 1);
  const maxVol = Math.max(...rows.map((r) => Math.max(r.ceVol, r.peVol)), 1);

  const touchNear = (strike: number): boolean => {
    const tol = spot * 0.0018;
    for (const c of candles1m) {
      if (c.h >= strike - tol && c.l <= strike + tol) return true;
    }
    return false;
  };

  const out: OptionStrikeInfo[] = [];
  for (const r of rows) {
    const make = (side: "CE" | "PE"): OptionStrikeInfo => {
      const oi = side === "CE" ? r.ceOi : r.peOi;
      const prevOi = side === "CE" ? r.cePrevOi : r.pePrevOi;
      const vol = side === "CE" ? r.ceVol : r.peVol;
      const ltpOpt = side === "CE" ? r.ceLtp : r.peLtp;
      const lact = side === "CE" ? maxCeOi : maxPeOi;
      const oiChange = prevOi > 0 ? oi - prevOi : null;

      // OI magnitude (real, normalized to chain max)
      const oiMag = oi / lact;
      // concentration vs neighbours
      const i = rows.indexOf(r);
      const neigh: number[] = [];
      if (rows[i - 1]) neigh.push(side === "CE" ? rows[i - 1].ceOi : rows[i - 1].peOi);
      if (rows[i + 1]) neigh.push(side === "CE" ? rows[i + 1].ceOi : rows[i + 1].peOi);
      const neighAvg = neigh.length ? neigh.reduce((a, b) => a + b, 0) / neigh.length : oi;
      const concentration = neighAvg > 0 ? clamp(oi / neighAvg / 2, 0, 1) : 0.5;
      // OI change
      const oiChgScore =
        oiChange === null ? 0.4 : clamp(oiChange / Math.max(lact * 0.05, 1), -1, 1) * 0.5 + 0.5;
      // volume
      const volScore = clamp(vol / maxVol, 0, 1);
      // proximity to spot
      const distPct = Math.abs(r.strike - spot) / spot * 100;
      const proxScore = clamp(1 - distPct / 0.1, 0, 1);
      // price reaction near the strike
      const reacted = touchNear(r.strike);

      let score =
        oiMag * 32 +
        concentration * 18 +
        oiChgScore * 16 +
        volScore * 12 +
        proxScore * 14 +
        (reacted ? 8 : 0);

      const unwinding = oiChange !== null ? oiChange < -lact * 0.01 : null;
      if (unwinding) score -= 12; // unwinding reduces confidence in the level
      const buildup = oiChange !== null ? oiChange > lact * 0.01 : null;
      if (buildup) score += 4;

      const role: OptionStrikeInfo["role"] =
        side === "CE" ? (r.strike >= spot * 0.995 ? "RESISTANCE" : "OMNI") : r.strike <= spot * 1.005 ? "SUPPORT" : "OMNI";

      return {
        strike: r.strike,
        side,
        oi,
        oiChange,
        volume: vol,
        ltp: ltpOpt,
        score: Math.round(clamp(score, 0, 100)),
        role,
        unwinding,
        buildup,
      };
    };
    out.push(make("CE"), make("PE"));
  }

  const topStrikes = out.sort((a, b) => b.score - a.score).slice(0, 8);
  const ceTop = out
    .filter((s) => s.side === "CE" && s.strike >= spot * 0.995)
    .sort((a, b) => b.score - a.score)[0] ?? null;
  const peTop = out
    .filter((s) => s.side === "PE" && s.strike <= spot * 1.005)
    .sort((a, b) => b.score - a.score)[0] ?? null;

  return { supportStrike: peTop, resistanceStrike: ceTop, topStrikes };
}
