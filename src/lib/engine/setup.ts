/**
 * Stage 2 trade-setup engine.
 * Classifies candidates into LONG / SHORT / WAIT states using the combined
 * dynamic S/R zones, volume-confirmed breakout/retest structure and the
 * minimum risk:reward gate. Builds data-grounded explanations. Never forces
 * a trade: invalid or low-quality structures return NO_TRADE with reasons.
 */

import type {
  Candle,
  Direction,
  Explanation,
  ScannerConfig,
  SetupState,
  SRZone,
  Stage1Metrics,
  TradePlan,
} from "./types";
import type { LevelEngineOutput } from "./levels";
import { clamp } from "./indicators";

export interface SetupInput {
  metrics: Stage1Metrics;
  levels: LevelEngineOutput;
  candles5m: Candle[];
  config: ScannerConfig;
  tickSize: number | null;
}

export interface SetupOutput {
  plan: TradePlan;
  finalScore: number;
  scoreBreakdown: Record<string, { weight: number; value: number | null; contribution: number; note: string }>;
  explanation: Explanation;
}

function zoneLabel(z: SRZone): string {
  return `${z.low.toFixed(2)}-${z.high.toFixed(2)}`;
}

/** Volume confirmation: last completed 5-min candle vs average of prior 8. */
export function breakoutVolumeBoost(candles5m: Candle[]): boolean | null {
  if (candles5m.length < 10) return null;
  const last = candles5m[candles5m.length - 1].v;
  const prior = candles5m.slice(-9, -1).map((c) => c.v);
  const avg = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : 0;
  if (avg <= 0) return null;
  return last >= avg * 1.2;
}

export function buildSetup(input: SetupInput): SetupOutput {
  const { metrics, levels, config } = input;
  const direction = metrics.direction ?? "LONG";
  const ltp = metrics.ltp;
  const buf = Math.max((input.tickSize ?? 0) * 2, (ltp ?? 0) * 0.0008);
  const isLong = direction === "LONG";
  const reasons: string[] = [];
  const cautions: string[] = [];

  const plan: TradePlan = {
    direction,
    setupState: "NO_TRADE",
    entryLow: null,
    entryHigh: null,
    entryRef: null,
    stop: null,
    stopNote: null,
    target1: null,
    target2: null,
    target3: null,
    risk: null,
    rr1: null,
    invalidationText: null,
    reasonsNoTrade: reasons,
  };

  const explain: Explanation = {
    summary: "",
    whyNow: [],
    confirmations: [],
    invalidation: null,
    cautions,
  };

  /* ---------------- hard gates: data integrity & staleness ---------------- */
  if (ltp == null) {
    plan.setupState = "INSUFFICIENT_DATA";
    reasons.push("LTP unavailable");
    explain.summary = "INSUFFICIENT DATA — no live price from Upstox.";
    return scoreIt(input, plan, explain);
  }
  if (metrics.dataStatus === "STALE" || metrics.dataStatus === "UNAVAILABLE") {
    plan.setupState = "INSUFFICIENT_DATA";
    reasons.push("market data stale — suggestions paused");
    explain.summary = "Suggestions paused: market data is stale.";
    return scoreIt(input, plan, explain);
  }

  const sups = levels.supports;
  const ress = levels.resistances;
  const sup1 = sups[0] ?? null;
  const res1 = ress[0] ?? null;
  const deeper = isLong ? sups : ress; // targets for shorts / stops reference
  const targetsAhead = isLong ? ress : sups;

  // Structure gate: the direction-relevant "behind" zone must exist. The
  // opposing side may legitimately be absent (e.g. a long trading above every
  // resistance after a breakout) — in that case the additive target
  // enrichment below supplies real references instead of aborting.
  const behindZone = isLong ? sup1 : res1;
  if (!behindZone) {
    plan.setupState = "INSUFFICIENT_DATA";
    reasons.push("dynamic S/R could not be established from real data");
    explain.summary = "INSUFFICIENT DATA — not enough structure to define levels.";
    return scoreIt(input, plan, explain);
  }

  /* --------------------- contradiction & quality filters ------------------ */
  if (metrics.trend5m === "BEARISH" && isLong) reasons.push("5-min trend is bearish — contradicts long");
  if (metrics.trend5m === "BULLISH" && !isLong) reasons.push("5-min trend is bullish — contradicts short");
  if (metrics.rsAccelPct != null && ((isLong && metrics.rsAccelPct < -0.2) || (!isLong && metrics.rsAccelPct > 0.2))) {
    cautions.push("relative strength acceleration deteriorating");
  }
  if (
    (isLong && (metrics.futures.signal === "SHORT_BUILDUP" || metrics.futures.signal === "LONG_UNWINDING")) ||
    (!isLong && (metrics.futures.signal === "LONG_BUILDUP" || metrics.futures.signal === "SHORT_COVERING"))
  ) {
    cautions.push(`futures positioning contradicts (${metrics.futures.signal})`);
  }
  if (metrics.vwap != null && Math.abs(ltp - metrics.vwap) / metrics.vwap > 0.025) {
    cautions.push("price extended far from VWAP — pullback risk elevated");
  }

  /* ---------------------------- classification --------------------------- */
  const zoneAhead = targetsAhead[0] ?? null; // nearest opposing zone
  const zoneBehind = (isLong ? sup1 : res1) ?? null;

  let state: SetupState = "NO_TRADE";
  const extensionPct = zoneBehind ? ((isLong ? 1 : -1) * (ltp - zoneBehind.high)) / ltp * 100 : 0;

  const brokenZone = isLong
    ? sup1 && sup1.members.some((m) => m.source === "BROKEN_RESISTANCE")
      ? sup1
      : null
    : res1 && res1.members.some((m) => m.source === "BROKEN_SUPPORT")
      ? res1
      : null;

  const pastBehind = zoneBehind
    ? isLong
      ? ltp > zoneBehind.high + buf
      : ltp < zoneBehind.low - buf
    : false;

  if (zoneBehind && !pastBehind) {
    // Anti-direction break: price beyond "behind" zone against the trade
    const against = isLong ? ltp < zoneBehind.low - buf : ltp > zoneBehind.high + buf;
    if (against && !brokenZone) {
      state = "NO_TRADE";
      reasons.push(
        isLong
          ? `price below nearest support ${zoneLabel(zoneBehind)} — long structure invalid`
          : `price above nearest resistance ${zoneLabel(zoneBehind)} — short structure invalid`,
      );
    }
  }

  if (reasons.length === 0 && zoneAhead) {
    const distAheadPct = Math.abs(
      (isLong ? zoneAhead.center - ltp : ltp - zoneAhead.center) / ltp,
    ) * 100;
    if (distAheadPct < 0.15 && zoneAhead.strength >= 70) {
      state = "NO_TRADE";
      reasons.push(
        `strong ${isLong ? "resistance" : "support"} ${zoneLabel(zoneAhead)} too close (${distAheadPct.toFixed(2)}%)`,
      );
    }
  }

  const volBoost = breakoutVolumeBoost(input.candles5m);

  if (reasons.length === 0) {
    if (brokenZone && pastBehind) {
      // ---- post-breakout / post-breakdown retest region ----
      const triggerLabel = isLong ? "breakout" : "breakdown";
      plan.entryLow = brokenZone.center;
      plan.entryHigh = Math.min(ltp, brokenZone.high * (1 + 0.001));

      if (extensionPct > config.maxBreakoutExtensionPct) {
        state = "WAIT_RETEST";
        plan.entryLow = brokenZone.center;
        plan.entryHigh = brokenZone.high;
        plan.entryRef = brokenZone.high;
        plan.stopNote = `below retest zone ${zoneLabel(brokenZone)}`;
      } else {
        state = "TRADE_SETUP";
      }
      plan.entryRef = plan.entryHigh ?? brokenZone.high;
      plan.stop = isLong ? brokenZone.low - buf : brokenZone.high + buf;
      plan.stopNote = `${isLong ? "below" : "above"} ${triggerLabel} zone ${zoneLabel(brokenZone)}`;
      plan.invalidationText = isLong
        ? `close below ${plan.stop.toFixed(2)} invalidates the ${triggerLabel} (broken resistance lost)`
        : `close above ${plan.stop.toFixed(2)} invalidates the ${triggerLabel} (broken support lost)`;
      if (volBoost === false) {
        if (state === "TRADE_SETUP") state = "WAIT_RETEST";
        cautions.push("breakout volume below recent average — confirmation weak");
      } else if (volBoost === true) {
        explain.confirmations.push("breakout candle volume above 8-bar average");
      }
      const t = targetsAhead;
      plan.target1 = t[0]?.center ?? null;
      plan.target2 = t[1]?.center ?? null;
      plan.target3 = t[2]?.center ?? null;
    } else if (zoneAhead) {
      // ---- approaching the level — wait for break ----
      state = isLong ? "WAIT_BREAKOUT" : "WAIT_BREAKDOWN";
      const trigger = isLong ? zoneAhead.high + buf : zoneAhead.low - buf;
      plan.entryLow = null;
      plan.entryHigh = null;
      plan.entryRef = trigger;
      plan.stop = isLong
        ? Math.min(zoneAhead.low, zoneBehind?.low ?? zoneAhead.low) - buf
        : Math.max(zoneAhead.high, zoneBehind?.high ?? zoneAhead.high) + buf;
      plan.stopNote = isLong ? "below the breakout structure" : "above the breakdown structure";
      const t = isLong ? ress.slice(1) : sups.slice(1);
      plan.target1 = t[0]?.center ?? null;
      plan.target2 = t[1]?.center ?? null;
      plan.target3 = t[2]?.center ?? null;
      plan.invalidationText = isLong
        ? `failure to hold ${zoneAhead.low.toFixed(2)} after breakout`
        : `failure to hold below ${zoneAhead.high.toFixed(2)} after breakdown`;
    }
  }

  /* ---------- ADDITIVE target enrichment (no change to any existing ------
   * calculation above). When the zone ladder has no further level beyond the
   * entry (common right after a breakout at the day's extreme), fall back to
   * REAL Upstox-derived references so T1/T2 and R:R remain available:
   *   1. the real option-chain OI wall on the trade side (CE for longs, PE
   *      for shorts) when it sits beyond the entry
   *   2. the nearest real level member (swing / PDH / PDL / OR / volume node)
   *      that lies beyond the entry
   * If neither exists, targets honestly stay N/A.
   * ---------------------------------------------------------------------- */
  const allZoneMembers = [...levels.resistances, ...levels.supports].flatMap((z) =>
    z.members.map((m) => m.price),
  );
  const nextRealBeyond = (from: number | null): number | null => {
    if (from == null) return null;
    const beyond = allZoneMembers.filter((p) =>
      isLong ? p > from * 1.001 : p < from * 0.999,
    );
    if (!beyond.length) return null;
    return isLong ? Math.min(...beyond) : Math.max(...beyond);
  };
  if (plan.entryRef != null) {
    const optWall = isLong
      ? levels.optionResistance?.strike ?? null
      : levels.optionSupport?.strike ?? null;
    const optBeyondEntry =
      optWall != null && (isLong ? optWall > plan.entryRef * 1.001 : optWall < plan.entryRef * 0.999)
        ? optWall
        : null;
    if (plan.target1 == null) {
      plan.target1 = optBeyondEntry ?? nextRealBeyond(plan.entryRef);
    }
    if (plan.target2 == null && plan.target1 != null) {
      const beyondT1 = nextRealBeyond(plan.target1);
      const cands = [optBeyondEntry, beyondT1].filter(
        (x): x is number => x != null && (isLong ? x > plan.target1! * 1.001 : x < plan.target1! * 0.999),
      );
      if (cands.length) plan.target2 = isLong ? Math.min(...cands) : Math.max(...cands);
    }
  }

  /* ------------------------------ R:R gate ------------------------------- */
  if (plan.entryRef != null && plan.stop != null && plan.target1 != null) {
    const risk = Math.abs(plan.entryRef - plan.stop);
    const reward = Math.abs(plan.target1 - plan.entryRef);
    plan.risk = risk > 0 ? risk : null;
    plan.rr1 = risk > 0 ? reward / risk : null;
    if (plan.rr1 != null && plan.rr1 < 0.5) {
      reasons.push(`distance to T1 far too small (R:R ${plan.rr1.toFixed(2)})`);
      state = "NO_TRADE";
    } else if (state === "TRADE_SETUP" && plan.rr1 != null && plan.rr1 < config.minRR) {
      state = "NO_TRADE";
      reasons.push(`R:R ${plan.rr1.toFixed(2)} below minimum 1:${config.minRR}`);
    } else if ((state === "WAIT_BREAKOUT" || state === "WAIT_BREAKDOWN") && plan.rr1 != null && plan.rr1 < config.minRR * 0.6) {
      cautions.push(`projected R:R only ${plan.rr1.toFixed(2)} — wait for better structure`);
    }
  } else if (state === "TRADE_SETUP") {
    state = "NO_TRADE";
    reasons.push("could not compute entry/stop/target from real structure");
  }

  plan.setupState = reasons.length ? "NO_TRADE" : state;

  /* ----------------------------- explanation ----------------------------- */
  const parts: string[] = [];
  if (metrics.rvol != null) parts.push(`RVOL ${metrics.rvol.toFixed(2)}x`);
  if (metrics.rsNiftyPct != null) parts.push(`RS vs NIFTY ${metrics.rsNiftyPct >= 0 ? "+" : ""}${metrics.rsNiftyPct.toFixed(2)}%`);
  if (metrics.rsAccelPct != null) parts.push(`RS acceleration ${metrics.rsAccelPct >= 0 ? "+" : ""}${metrics.rsAccelPct.toFixed(2)}%`);
  parts.push(`5-min trend ${metrics.trend5m}`);
  if (metrics.aboveVwap != null) parts.push(metrics.aboveVwap ? "price above VWAP" : "price below VWAP");
  explain.summary = `${direction} ${stateLabel(plan.setupState)} — ${parts.join(", ")}.`;

  if (brokenZone && pastBehind) {
    explain.whyNow.push(
      isLong
        ? `Price accepted above former resistance-turned-support ${zoneLabel(brokenZone)}`
        : `Price accepted below former support-turned-resistance ${zoneLabel(brokenZone)}`,
    );
  } else if (zoneAhead) {
    explain.whyNow.push(
      isLong
        ? `Price approaching dynamic resistance ${zoneLabel(zoneAhead)} (strength ${zoneAhead.strength}/100)`
        : `Price approaching dynamic support ${zoneLabel(zoneAhead)} (strength ${zoneAhead.strength}/100)`,
    );
  }
  if (metrics.rvol != null && metrics.rvol >= config.rvolThreshold) explain.confirmations.push(`abnormal participation: RVOL ${metrics.rvol.toFixed(2)}x`);
  if (metrics.rsNiftyPct != null && Math.sign(metrics.rsNiftyPct) === (isLong ? 1 : -1))
    explain.confirmations.push(`outperforming NIFTY by ${metrics.rsNiftyPct.toFixed(2)}% in trade direction`);
  if (metrics.rsAccelPct != null && Math.sign(metrics.rsAccelPct) === (isLong ? 1 : -1))
    explain.confirmations.push("relative-strength acceleration aligned");
  if (metrics.trend5m !== "INSUFFICIENT_DATA" && metrics.trend5m !== "NEUTRAL")
    explain.confirmations.push(`5-min structure ${metrics.trend5m}`);
  if (sup1 && sup1.strength >= 70) explain.confirmations.push(`strong support zone ${zoneLabel(sup1)} (${sup1.strength}/100)`);
  if (levels.optionSupport || levels.optionResistance) {
    const oTxt = [
      levels.optionSupport ? `PE OI at ${levels.optionSupport.strike}` : null,
      levels.optionResistance ? `CE OI at ${levels.optionResistance.strike}` : null,
    ].filter(Boolean).join("; ");
    explain.confirmations.push(`option-chain positioning: ${oTxt}`);
  }
  if (metrics.futures.signal !== "NEUTRAL" && metrics.futures.signal !== "UNAVAILABLE")
    explain.confirmations.push(`futures: ${metrics.futures.signal.replaceAll("_", " ").toLowerCase()}`);
  explain.invalidation = plan.invalidationText;

  return scoreIt(input, plan, explain);
}

function stateLabel(s: SetupState): string {
  switch (s) {
    case "TRADE_SETUP": return "TRADE SETUP";
    case "WAIT_BREAKOUT": return "WAIT FOR BREAKOUT";
    case "WAIT_BREAKDOWN": return "WAIT FOR BREAKDOWN";
    case "WAIT_RETEST": return "WAIT FOR RETEST";
    case "NO_TRADE": return "NO TRADE";
    default: return "INSUFFICIENT DATA";
  }
}

/* --------------------------- final scoring (0-100) ----------------------- */

function scoreIt(input: SetupInput, plan: TradePlan, explain: Explanation): SetupOutput {
  const { metrics, levels, config } = input;
  const isLong = plan.direction === "LONG";
  const w = config.finalWeights;

  const signAdj = (v: number | null, perUnit: number): number | null =>
    v == null ? null : clamp(50 + (isLong ? 1 : -1) * v * perUnit, 0, 100);

  const structureValue = (() => {
    const pat = levels.swingPattern;
    if (pat === "INSUFFICIENT") return 40;
    if (pat === "MIXED") return 55;
    const aligned = (pat === "HH_HL" && isLong) || (pat === "LH_LL" && !isLong);
    return aligned ? 88 : 20;
  })();

  const srQuality = (() => {
    const vals = [levels.supports[0]?.strength ?? null, levels.resistances[0]?.strength ?? null].filter(
      (x): x is number => x != null,
    );
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  })();

  const optionValue = (() => {
    const scores = [levels.optionSupport?.score ?? null, levels.optionResistance?.score ?? null].filter(
      (x): x is number => x != null,
    );
    if (!scores.length) return null;
    let v = scores.reduce((a, b) => a + b, 0) / scores.length;
    const alignedZone =
      (isLong ? levels.supports[0] : levels.resistances[0])?.sources.some((s) => s.startsWith("OPTION")) ?? false;
    if (alignedZone) v += 12;
    return clamp(v, 0, 100);
  })();

  const futuresValue = (() => {
    const s = metrics.futures.signal;
    if (s === "UNAVAILABLE") return null;
    if (s === "NEUTRAL") return 50;
    const strong = (s === "LONG_BUILDUP" && isLong) || (s === "SHORT_BUILDUP" && !isLong);
    const mild = (s === "SHORT_COVERING" && isLong) || (s === "LONG_UNWINDING" && !isLong);
    if (strong) return 95;
    if (mild) return 70;
    return 15;
  })();

  const trendValue = (() => {
    const t = metrics.trend5m;
    if (t === "INSUFFICIENT_DATA") return null;
    if (t === "NEUTRAL") return 45;
    return (t === "BULLISH" && isLong) || (t === "BEARISH" && !isLong) ? 95 : 20;
  })();

  const rrValue =
    plan.rr1 != null ? clamp((plan.rr1 / (config.minRR * 2)) * 100, 0, 100) : null;

  const patternNote = levels.swingPattern === "HH_HL" ? "HH/HL structure" : levels.swingPattern === "LH_LL" ? "LH/LL structure" : "mixed/nascent structure";

  const parts: Record<string, { weight: number; value: number | null; note: string }> = {
    priceStructure: { weight: w.priceStructure, value: structureValue, note: patternNote },
    rvol: { weight: w.rvol, value: metrics.rvol != null ? clamp((metrics.rvol / (2 * config.rvolThreshold)) * 100, 0, 100) : null, note: metrics.rvol != null ? `RVOL ${metrics.rvol.toFixed(2)}x` : "RVOL n/a" },
    rs: { weight: w.rs, value: signAdj(metrics.rsNiftyPct, 40), note: metrics.rsNiftyPct != null ? `RS ${metrics.rsNiftyPct.toFixed(2)}%` : "RS n/a" },
    rsAccel: { weight: w.rsAccel, value: signAdj(metrics.rsAccelPct, 60), note: metrics.rsAccelPct != null ? `RS accel ${metrics.rsAccelPct.toFixed(2)}%` : "n/a" },
    srQuality: { weight: w.srQuality, value: srQuality, note: srQuality != null ? `zone confluence ${Math.round(srQuality)}/100` : "no zones" },
    optionConfluence: { weight: w.optionConfluence, value: optionValue, note: optionValue != null ? "option strike scores" : "option chain n/a" },
    futures: { weight: w.futures, value: futuresValue, note: metrics.futures.signal },
    trend5m: { weight: w.trend5m, value: trendValue, note: metrics.trend5m },
    rr: { weight: w.rr, value: rrValue, note: plan.rr1 != null ? `R:R ${plan.rr1.toFixed(2)}` : "no computed plan" },
  };

  let wSum = 0;
  let acc = 0;
  const breakdown: SetupOutput["scoreBreakdown"] = {};
  for (const [key, p] of Object.entries(parts)) {
    const contribution = p.value != null ? p.weight * p.value : 0;
    breakdown[key] = { weight: p.weight, value: p.value != null ? Math.round(p.value) : null, contribution: Math.round(contribution) / 100, note: p.note };
    if (p.value != null && p.weight > 0) {
      wSum += p.weight;
      acc += p.weight * p.value;
    }
  }
  let finalScore = wSum > 0 ? Math.round(acc / wSum) : 0;
  if (plan.setupState === "NO_TRADE") finalScore = Math.min(finalScore, 55);
  if (plan.setupState === "INSUFFICIENT_DATA") finalScore = Math.min(finalScore, 40);

  return { plan, finalScore, scoreBreakdown: breakdown, explanation: explain };
}
