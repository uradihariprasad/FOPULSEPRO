/**
 * MOMENTUM RADAR  (additive module)
 *
 * Detects stocks that are moving RIGHT NOW and classifies the momentum phase.
 * It is a burst/velocity detector — distinct from Stage-1 (ranking), Order
 * Flow Dominance (pressure) and Momentum Conviction (multi-factor fusion).
 *
 * Detection inputs (all real, all already cached by the pipeline):
 *   sudden price change  — 1m/3m/5m/15m velocity + acceleration vs the day's
 *                          own typical 1-minute range (self-normalised shock)
 *   volume surge         — last-bar volume vs the session's recent average,
 *                          plus time-of-day adjusted RVOL and its change
 *   OI surge             — futures ΔOI% and its interpretation with price
 *   participation        — real traded turnover
 *   range expansion      — current bar range vs typical bar range
 *   follow-through       — how much of the burst has been retained
 *
 * Phase classification:
 *   IGNITION · ACCELERATION · CONTINUATION · PULLBACK · STALLING ·
 *   EXHAUSTION · REVERSAL · FADING
 *
 * Integrity: no synthetic values; missing inputs stay null (N/A) and are
 * excluded by coverage dampening; stale symbols are never ranked.
 */

import type { Candle, Stage1Metrics } from "./types";
import type { PriceSnap } from "./stage1";
import { aggregate, clamp } from "./indicators";

export type MomentumSide = "BUY" | "SELL";

export type MomentumPhase =
  | "IGNITION"
  | "ACCELERATION"
  | "CONTINUATION"
  | "PULLBACK"
  | "STALLING"
  | "EXHAUSTION"
  | "REVERSAL"
  | "FADING";

export const PHASE_LABEL: Record<MomentumPhase, string> = {
  IGNITION: "Ignition",
  ACCELERATION: "Accelerating",
  CONTINUATION: "Continuation",
  PULLBACK: "Healthy Pullback",
  STALLING: "Stalling",
  EXHAUSTION: "Exhaustion",
  REVERSAL: "Reversal Risk",
  FADING: "Fading",
};

export const PHASE_NOTE: Record<MomentumPhase, string> = {
  IGNITION: "move just started — burst detected on fresh volume",
  ACCELERATION: "velocity increasing with expanding participation",
  CONTINUATION: "trend persisting at a steady pace, gains retained",
  PULLBACK: "counter-move against an intact trend on lighter volume",
  STALLING: "velocity collapsing while extended — momentum drying up",
  EXHAUSTION: "climax participation with the move no longer progressing",
  REVERSAL: "prior move giving back with opposing pressure building",
  FADING: "burst faded, participation normalising",
};

export interface RadarSignal {
  key: string;
  label: string;
  value: number | null; // 0-100 in favour of the detected side
  evidence: string;
  weight: number;
}

export interface MomentumRadarResult {
  symbol: string;
  computedAt: string;
  side: MomentumSide | null;
  score: number; // 0-100 momentum burst score
  phase: MomentumPhase;
  phaseLabel: string;
  phaseNote: string;
  grade: "EXPLOSIVE" | "STRONG" | "ACTIVE" | "BELOW THRESHOLD";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  ltp: number | null;
  changePct: number | null;
  /* burst metrics */
  velocity1mPct: number | null;
  velocity3mPct: number | null;
  velocity5mPct: number | null;
  velocity15mPct: number | null;
  accelerationPct: number | null;
  priceShock: number | null; // move in units of the day's typical 1m range
  volumeSurge: number | null; // last bar vs recent average
  rvol: number | null;
  rvolChange: number | null;
  oiChangePct: number | null;
  oiInterpretation: string;
  turnoverCr: number | null;
  rangeExpansion: number | null;
  followThrough: number | null; // 0-1 retained portion of the burst
  signals: RadarSignal[];
  coveragePct: number;
  dataStatus: string;
  rankable: boolean;
  headline: string;
  drivers: string[];
  warnings: string[];
  /* ---- pre-burst readiness (watchlist) ---- */
  readiness: number;                 // 0-100 "ready to move" score
  readinessSide: MomentumSide | null; // expected breakout direction
  readinessFactors: RadarSignal[];
  triggerNote: string;               // what would confirm the move
  coilRatio: number | null;          // <1 = range compressing
  rangePosition: number | null;      // 0..1 position within the day range
  watchable: boolean;                // qualifies for the watchlist
  compressed: boolean;               // range genuinely tightening
  quietNow: boolean;                 // price is not already moving
  velocity5mPctQuiet: number | null;
}

export const RADAR_MIN_SCORE = 55;
/** Minimum readiness for a stock to enter the pre-burst watchlist. */
export const READINESS_MIN = 50;
/** Max ratio of recent to prior bar-range for a genuine coil. */
export const COIL_MAX = 0.85;
/** Max |5m| / |15m| velocity for a stock that has not already moved. */
export const QUIET_5M_PCT = 0.45;
export const QUIET_15M_PCT = 0.9;

export interface MomentumRadarInput {
  symbol: string;
  metrics: Stage1Metrics;
  candles1m: Candle[] | null;
  ring: PriceSnap[];
  rvolHistory: { ts: number; rvol: number }[];
  now: number;
}

function pct(a: number, b: number): number | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return ((a - b) / b) * 100;
}

export function computeMomentumRadar(input: MomentumRadarInput): MomentumRadarResult {
  const m = input.metrics;
  const ltp = m.ltp;
  const c1 = input.candles1m ?? [];
  const signals: RadarSignal[] = [];
  const drivers: string[] = [];
  const warnings: string[] = [];

  /* --------------------------- velocity series --------------------------- */
  const closeAgo = (bars: number): number | null => {
    if (c1.length <= bars) return null;
    return c1[c1.length - 1 - bars].c;
  };
  const last = c1.length ? c1[c1.length - 1].c : ltp;
  const v1 = last != null && closeAgo(1) != null ? pct(last, closeAgo(1) as number) : null;
  const v3 = last != null && closeAgo(3) != null ? pct(last, closeAgo(3) as number) : null;
  const v5 = last != null && closeAgo(5) != null ? pct(last, closeAgo(5) as number) : m.return5mPct;
  const v15 = last != null && closeAgo(15) != null ? pct(last, closeAgo(15) as number) : m.return15mPct;
  // acceleration: recent 5m velocity vs the prior 5m velocity
  const prior5 =
    c1.length > 10 && closeAgo(5) != null && closeAgo(10) != null
      ? pct(closeAgo(5) as number, closeAgo(10) as number)
      : null;
  const accel = v5 != null && prior5 != null ? v5 - prior5 : m.priceAccel;

  /* -------- typical 1-minute range (self-normalised shock baseline) ------ */
  const typicalRange = (() => {
    if (c1.length < 20) return null;
    const rs = c1.slice(-60).map((c) => c.h - c.l).filter((x) => x > 0).sort((a, b) => a - b);
    if (!rs.length) return null;
    return rs[Math.floor(rs.length / 2)]; // median
  })();
  const lastMove = c1.length ? Math.abs(c1[c1.length - 1].c - c1[c1.length - 1].o) : null;
  const shock3 =
    typicalRange && typicalRange > 0 && v3 != null && ltp != null
      ? Math.abs((v3 / 100) * ltp) / typicalRange
      : null;

  /* ------------------------------ direction ------------------------------
   * The ESTABLISHED move (30-bar / day) defines the side, so a pullback or a
   * fade is still classified against the move it belongs to, instead of
   * flipping side every time price ticks the other way.
   * --------------------------------------------------------------------- */
  const v30 = last != null && closeAgo(30) != null ? pct(last, closeAgo(30) as number) : null;
  const established = (v30 ?? 0) * 2 + (m.returnDayPct ?? 0) + (m.rsNiftyPct ?? 0) * 0.5;
  const shortTerm = (v3 ?? 0) * 3 + (v5 ?? 0) * 2;
  const dirScore = Math.abs(established) >= 0.15 ? established : shortTerm;
  const side: MomentumSide | null = dirScore > 0.05 ? "BUY" : dirScore < -0.05 ? "SELL" : null;
  const sign = side === "SELL" ? -1 : 1;

  /* --------------------------- volume surge ------------------------------ */
  const volumeSurge = (() => {
    if (c1.length < 12) return null;
    const lastV = c1[c1.length - 1].v;
    const prior = c1.slice(-11, -1).map((c) => c.v);
    const avg = prior.reduce((a, b) => a + b, 0) / (prior.length || 1);
    return avg > 0 ? lastV / avg : null;
  })();

  /* ------------------------- RVOL change (surge) ------------------------- */
  const rvolChange = (() => {
    const h = input.rvolHistory;
    if (!h.length || m.rvol == null) return null;
    const old = h.find((x) => input.now - x.ts >= 5 * 60_000) ?? h[0];
    return old ? m.rvol - old.rvol : null;
  })();

  /* ---------------------------- range expansion -------------------------- */
  const rangeExpansion = (() => {
    if (!typicalRange || typicalRange <= 0 || !c1.length) return null;
    const lastRange = c1[c1.length - 1].h - c1[c1.length - 1].l;
    return lastRange / typicalRange;
  })();

  /* ---------------------------- follow-through --------------------------- */
  // how much of the last 15-minute move has been retained at the current price
  const followThrough = (() => {
    if (c1.length < 16 || ltp == null) return null;
    const seg = c1.slice(-15);
    const startP = seg[0].o;
    const extreme = sign > 0 ? Math.max(...seg.map((c) => c.h)) : Math.min(...seg.map((c) => c.l));
    const span = Math.abs(extreme - startP);
    if (span <= 0) return null;
    const retained = sign > 0 ? ltp - startP : startP - ltp;
    return clamp(retained / span, -1, 1);
  })();

  /* ------------------------------- signals -------------------------------- */
  signals.push({
    key: "velocity", label: "Price velocity", weight: 26,
    value: v3 == null && v5 == null ? null : clamp(50 + sign * ((v3 ?? 0) * 55 + (v5 ?? 0) * 25), 0, 100),
    evidence: [
      v1 != null ? `1m ${v1 >= 0 ? "+" : ""}${v1.toFixed(2)}%` : null,
      v3 != null ? `3m ${v3 >= 0 ? "+" : ""}${v3.toFixed(2)}%` : null,
      v5 != null ? `5m ${v5 >= 0 ? "+" : ""}${v5.toFixed(2)}%` : null,
      v15 != null ? `15m ${v15 >= 0 ? "+" : ""}${v15.toFixed(2)}%` : null,
    ].filter(Boolean).join(" · ") || "N/A",
  });

  signals.push({
    key: "acceleration", label: "Acceleration", weight: 20,
    value: accel == null ? null : clamp(50 + sign * accel * 70, 0, 100),
    evidence: accel == null ? "N/A" : `5m velocity ${accel >= 0 ? "+" : ""}${accel.toFixed(2)}% vs prior 5m`,
  });

  signals.push({
    key: "shock", label: "Price shock", weight: 14,
    value: shock3 == null ? null : clamp((shock3 / 6) * 100, 0, 100),
    evidence: shock3 == null ? "N/A" : `3m move = ${shock3.toFixed(1)}× the day's typical 1m range`,
  });

  signals.push({
    key: "volumeSurge", label: "Volume surge", weight: 16,
    value: volumeSurge == null ? null : clamp(((volumeSurge - 1) / 2.5) * 100, 0, 100),
    evidence: volumeSurge == null ? "N/A" : `last bar ${volumeSurge.toFixed(2)}× the 10-bar average`,
  });

  signals.push({
    key: "rvol", label: "RVOL & change", weight: 12,
    value: m.rvol == null ? null : clamp((m.rvol / 3) * 100 + (rvolChange != null ? rvolChange * 12 : 0), 0, 100),
    evidence: m.rvol == null ? "RVOL N/A"
      : `RVOL ${m.rvol.toFixed(2)}x${rvolChange != null ? ` (${rvolChange >= 0 ? "+" : ""}${rvolChange.toFixed(2)} in 5m)` : ""}`,
  });

  const oiPct = m.futures.oiChangePct;
  const oiInterpretation = m.futures.signal === "UNAVAILABLE" ? "futures OI unavailable"
    : m.futures.signal === "NEUTRAL" ? "OI change insignificant"
    : `${m.futures.signal.replaceAll("_", " ").toLowerCase()} characteristics`;
  signals.push({
    key: "oi", label: "Futures OI surge", weight: 12,
    value: (() => {
      if (m.futures.signal === "UNAVAILABLE") return null;
      if (m.futures.signal === "NEUTRAL") return 45;
      const aligned =
        (side === "BUY" && (m.futures.signal === "LONG_BUILDUP" || m.futures.signal === "SHORT_COVERING")) ||
        (side === "SELL" && (m.futures.signal === "SHORT_BUILDUP" || m.futures.signal === "LONG_UNWINDING"));
      const magnitude = oiPct != null ? clamp(Math.abs(oiPct) * 6, 0, 30) : 10;
      return clamp((aligned ? 62 : 22) + (aligned ? magnitude : -magnitude / 2), 0, 100);
    })(),
    evidence: `${oiInterpretation}${oiPct != null ? ` · ΔOI ${oiPct >= 0 ? "+" : ""}${oiPct.toFixed(2)}%` : ""}`,
  });

  /* ------------------------------- scoring -------------------------------- */
  let used = 0, acc = 0, total = 0;
  for (const s of signals) {
    total += s.weight;
    if (s.value == null) continue;
    used += s.weight;
    acc += s.weight * s.value;
  }
  const coverage = total > 0 ? used / total : 0;
  let score = used > 0 ? Math.round((acc / used) * Math.sqrt(coverage)) : 0;
  if (side == null) score = Math.min(score, 45);
  score = Math.round(clamp(score, 0, 100));

  /* -------------------------- phase classification ------------------------ */
  const extended = Math.abs(m.returnDayPct ?? 0) >= 3.5;
  const volFading = volumeSurge != null && volumeSurge < 0.85;
  const volClimax = volumeSurge != null && volumeSurge >= 2.2;
  const accelPos = accel != null && sign * accel > 0.03;
  const accelNeg = accel != null && sign * accel < -0.03;
  const movingNow = v3 != null && sign * v3 > 0.04;
  const againstNow = v3 != null && sign * v3 < -0.04;
  // trend is judged on the ESTABLISHED window, not the last few minutes
  const trendIntact = (v30 != null && sign * v30 > 0.2) || sign * (m.returnDayPct ?? 0) > 0.8;
  const ft = followThrough;

  const phase: MomentumPhase = (() => {
    // deterioration first — these override any apparent strength.
    // Volume separates a HEALTHY PULLBACK (counter-move on fading volume)
    // from EXHAUSTION (climax participation with no further progress).
    if (trendIntact && ft != null && ft < -0.15) return "REVERSAL";
    if (trendIntact && volClimax && (ft == null || ft < 0.45)) return "EXHAUSTION";
    if (trendIntact && againstNow && volFading) return "PULLBACK";
    if (trendIntact && extended && ft != null && ft < 0.3 && !volFading) return "EXHAUSTION";
    if (trendIntact && againstNow) return "PULLBACK";
    if (trendIntact && extended && accelNeg) return "STALLING";
    if (trendIntact && !movingNow && volFading) return "FADING";
    // fresh strength
    if (movingNow && accelPos) return trendIntact ? "ACCELERATION" : "IGNITION";
    if (movingNow && !trendIntact) return "IGNITION";
    if (movingNow && trendIntact) return "CONTINUATION";
    if (accelNeg || volFading) return "FADING";
    return "CONTINUATION";
  })();

  // phases that indicate the move is deteriorating cap the burst score
  if (phase === "EXHAUSTION" || phase === "REVERSAL") score = Math.min(score, 62);
  if (phase === "STALLING" || phase === "FADING") score = Math.min(score, 58);

  const grade: MomentumRadarResult["grade"] =
    score >= 80 ? "EXPLOSIVE" : score >= 68 ? "STRONG" : score >= RADAR_MIN_SCORE ? "ACTIVE" : "BELOW THRESHOLD";

  const fresh = m.dataStatus === "LIVE" || m.dataStatus === "RECENT";
  const confidence: MomentumRadarResult["confidence"] =
    !fresh ? "LOW"
      : coverage >= 0.8 && (volumeSurge != null || m.rvol != null) ? "HIGH"
      : coverage >= 0.55 ? "MEDIUM" : "LOW";

  const rankable = fresh && side != null && coverage >= 0.5 && score >= RADAR_MIN_SCORE;

  /* ------------------- READINESS: pre-burst watchlist ---------------------
   * Identifies stocks COILING toward a move rather than already moving:
   * range compression + building participation + pressing an extreme +
   * fresh OI + improving RS, while still having room to run.
   * --------------------------------------------------------------------- */
  const coilRatio = (() => {
    if (c1.length < 40) return null;
    const rec = c1.slice(-10).map((c) => c.h - c.l).filter((x) => x > 0);
    const pri = c1.slice(-40, -10).map((c) => c.h - c.l).filter((x) => x > 0);
    if (rec.length < 5 || pri.length < 10) return null;
    const ra = rec.reduce((a, b) => a + b, 0) / rec.length;
    const pa = pri.reduce((a, b) => a + b, 0) / pri.length;
    return pa > 0 ? ra / pa : null;
  })();

  const rangePosition = (() => {
    if (m.dayHigh == null || m.dayLow == null || ltp == null || m.dayHigh <= m.dayLow) return null;
    return clamp((ltp - m.dayLow) / (m.dayHigh - m.dayLow), 0, 1);
  })();

  /*
   * Direction of the EXPECTED break comes from where the coil is sitting
   * relative to the day's range — NOT from trend or RS, which would merely
   * re-describe momentum that has already happened.
   *   high-of-day coil  -> BREAKOUT candidate
   *   low-of-day coil   -> BREAKDOWN candidate
   */
  const readinessSide: MomentumSide | null = (() => {
    if (rangePosition == null) return null;
    if (rangePosition >= 0.62) return "BUY";
    if (rangePosition <= 0.38) return "SELL";
    return null;
  })();
  const rSign = readinessSide === "SELL" ? -1 : 1;

  const readinessFactors: RadarSignal[] = [
    {
      key: "coil", label: "Range compression", weight: 30,
      value: coilRatio == null ? null : clamp((1.02 - coilRatio) * 160, 0, 100),
      evidence: coilRatio == null ? "N/A" : `last 10 bars ${Math.round(coilRatio * 100)}% of prior range`,
    },
    {
      key: "participation", label: "Participation building", weight: 20,
      value: m.rvol == null ? null : clamp((m.rvol / 2) * 55 + (rvolChange != null ? rvolChange * 30 : 0), 0, 100),
      evidence: m.rvol == null ? "RVOL N/A"
        : `RVOL ${m.rvol.toFixed(2)}x${rvolChange != null ? ` (${rvolChange >= 0 ? "+" : ""}${rvolChange.toFixed(2)} in 5m)` : ""}`,
    },
    {
      key: "position", label: "Coil location", weight: 18,
      value: rangePosition == null ? null : clamp((rSign > 0 ? rangePosition : 1 - rangePosition) * 100, 0, 100),
      evidence: rangePosition == null ? "N/A"
        : `coiled at ${Math.round(rangePosition * 100)}% of the day range${m.aboveVwap != null ? ` · ${m.aboveVwap ? "above" : "below"} VWAP` : ""}`,
    },
    {
      key: "oiBuild", label: "OI building", weight: 15,
      value: oiPct == null ? null : clamp(50 + oiPct * 5, 0, 100),
      evidence: oiPct == null ? "futures OI N/A" : `dOI ${oiPct >= 0 ? "+" : ""}${oiPct.toFixed(2)}% · ${oiInterpretation}`,
    },
    {
      key: "rsBuild", label: "RS improving", weight: 10,
      value: m.rsAccelPct == null ? null : clamp(50 + rSign * m.rsAccelPct * 60, 0, 100),
      evidence: m.rsAccelPct == null ? "N/A" : `RS accel ${m.rsAccelPct >= 0 ? "+" : ""}${m.rsAccelPct.toFixed(2)}%`,
    },
    {
      key: "room", label: "Room to move", weight: 10,
      value: m.returnDayPct == null ? null : clamp(100 - Math.abs(m.returnDayPct) * 18, 0, 100),
      evidence: m.returnDayPct == null ? "N/A" : `${m.returnDayPct >= 0 ? "+" : ""}${m.returnDayPct.toFixed(2)}% on the day`,
    },
  ];

  let rUsed = 0, rAcc = 0, rTot = 0;
  for (const f of readinessFactors) { rTot += f.weight; if (f.value == null) continue; rUsed += f.weight; rAcc += f.weight * f.value; }
  const rCov = rTot > 0 ? rUsed / rTot : 0;
  let readiness = rUsed > 0 ? Math.round((rAcc / rUsed) * Math.sqrt(rCov)) : 0;
  if (readinessSide == null) readiness = Math.min(readiness, 40);
  readiness = Math.round(clamp(readiness, 0, 100));

  const triggerNote = readinessSide == null
    ? "no clear direction yet — watch for a decisive move off the range"
    : readinessSide === "BUY"
      ? m.dayHigh != null ? `break above day high ${m.dayHigh.toFixed(2)} with volume expansion` : "break above the intraday high with volume"
      : m.dayLow != null ? `breakdown below day low ${m.dayLow.toFixed(2)} with volume expansion` : "breakdown below the intraday low with volume";

  // watchlist = coiled and building, but NOT already bursting
  /*
   * HARD GATES for a genuine pre-breakout / pre-breakdown candidate.
   * A stock that has already moved is NOT a breakout candidate, so:
   *   - the range must actually be COMPRESSED (coil < 0.85), not merely
   *     weighted as one of several factors
   *   - price must be QUIET right now (small 5m/15m velocity) — the setup is
   *     before the move, not during or after it
   *   - it must not already be bursting
   * These are gates rather than weights precisely so a strongly trending stock
   * can never appear as "ready to break out".
   */
  const compressed = coilRatio != null && coilRatio <= COIL_MAX;
  const quietNow =
    (v5 == null || Math.abs(v5) <= QUIET_5M_PCT) &&
    (v15 == null || Math.abs(v15) <= QUIET_15M_PCT);
  const watchable =
    fresh &&
    readinessSide != null &&
    rCov >= 0.5 &&
    readiness >= READINESS_MIN &&
    compressed &&
    quietNow &&
    score < RADAR_MIN_SCORE;

  /* ------------------------------ narrative ------------------------------- */
  for (const s of signals) {
    if (s.value != null && s.value >= 65) drivers.push(`${s.label}: ${s.evidence}`);
  }
  if (volClimax) warnings.push(`climax volume — last bar ${volumeSurge!.toFixed(2)}× average`);
  if (extended) warnings.push(`already extended ${(m.returnDayPct ?? 0).toFixed(2)}% on the day`);
  if (ft != null && ft < 0.4) warnings.push(`weak follow-through — only ${Math.round(Math.max(ft, 0) * 100)}% of the move retained`);
  if (m.futures.signal === "UNAVAILABLE") warnings.push("futures OI unavailable");
  if (accelNeg) warnings.push("velocity decelerating");

  const headline = side
    ? `${side} momentum · ${PHASE_LABEL[phase]} — ${PHASE_NOTE[phase]}`
    : "No clear directional burst";

  return {
    symbol: input.symbol,
    computedAt: new Date(input.now).toISOString(),
    side, score, phase, phaseLabel: PHASE_LABEL[phase], phaseNote: PHASE_NOTE[phase],
    grade, confidence,
    ltp, changePct: m.returnDayPct,
    velocity1mPct: v1, velocity3mPct: v3, velocity5mPct: v5, velocity15mPct: v15,
    accelerationPct: accel,
    priceShock: shock3,
    volumeSurge, rvol: m.rvol, rvolChange,
    oiChangePct: oiPct, oiInterpretation,
    turnoverCr: m.turnoverCr,
    rangeExpansion, followThrough: ft,
    signals, coveragePct: Math.round(coverage * 100),
    dataStatus: m.dataStatus, rankable,
    headline, drivers, warnings,
    readiness, readinessSide, readinessFactors, triggerNote,
    coilRatio, rangePosition, watchable,
    compressed, quietNow, velocity5mPctQuiet: v5,
  };
}
