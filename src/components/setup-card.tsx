"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowDownRight, ArrowUpRight, ChevronDown, Crosshair, Flame, Info, ShieldAlert, Target, Zap,
} from "lucide-react";
import type { SetupCardData } from "@/lib/engine/types";
import {
  DataStatusDot, DirBadge, FuturesBadge, Meter, ScoreRing, SetupStateBadge, TrendBadge, ZoneLabel, fnum, fpct, fx,
} from "./ui";

export function SetupCard({ data, rank }: { data: SetupCardData; rank: number }) {
  const [open, setOpen] = useState(false);
  const { stage1: m, stage2: s2 } = data;
  const p = s2.tradePlan;
  const dirLong = p.direction === "LONG";
  const isTrade = s2.setupState === "TRADE_SETUP";

  return (
    <div className={`panel panel-hover rise-in overflow-hidden ${isTrade ? "border-profit/25" : ""}`}>
      <div className="p-3 sm:p-4">
        {/* header */}
        <div className="flex items-start gap-3">
          <span className="num text-ink-faint text-xs pt-1 w-5">#{rank}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Link href={`/stock/${m.symbol}`} className="num text-lg font-bold tracking-wide hover:text-info transition">
                {m.symbol}
              </Link>
              <DirBadge dir={p.direction} />
              <SetupStateBadge state={s2.setupState} />
              {isTrade && <Flame className="h-3.5 w-3.5 text-profit" />}
            </div>
            <div className="flex items-center gap-3 mt-1.5 text-xs">
              <span className="num text-ink text-base font-semibold">₹{fnum(m.ltp)}</span>
              <span className={`num ${m.returnDayPct != null && m.returnDayPct >= 0 ? "text-profit" : "text-loss"}`}>
                {fpct(m.returnDayPct)}
              </span>
              <DataStatusDot status={m.dataStatus} />
            </div>
          </div>
          <div className="flex flex-col items-center">
            <ScoreRing score={s2.finalScore} />
            <span className="text-[9px] text-ink-faint mt-0.5 tracking-widest">FINAL</span>
          </div>
        </div>

        {/* zones */}
        <div className="mt-3.5 grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-profit/20 bg-profit/5 px-3 py-2">
            <div className="flex items-center justify-between text-[9px] tracking-widest text-profit/80 font-bold">
              <span>SUPPORT</span><span className="num">{s2.support ? `${s2.support.strength}/100` : "N/A"}</span>
            </div>
            <div className="mt-1 text-xs text-profit">
              {s2.support ? <ZoneLabel low={s2.support.low} high={s2.support.high} /> : <span className="num text-ink-faint">N/A</span>}
            </div>
            {s2.support && <div className="mt-1.5"><Meter value={s2.support.strength} tone="green" /></div>}
          </div>
          <div className="rounded-lg border border-loss/20 bg-loss/5 px-3 py-2">
            <div className="flex items-center justify-between text-[9px] tracking-widest text-loss/80 font-bold">
              <span>RESISTANCE</span><span className="num">{s2.resistance ? `${s2.resistance.strength}/100` : "N/A"}</span>
            </div>
            <div className="mt-1 text-xs text-loss">
              {s2.resistance ? <ZoneLabel low={s2.resistance.low} high={s2.resistance.high} /> : <span className="num text-ink-faint">N/A</span>}
            </div>
            {s2.resistance && <div className="mt-1.5"><Meter value={s2.resistance.strength} tone="red" /></div>}
          </div>
        </div>

        {/* trade plan */}
        <div className="mt-2.5 rounded-lg border border-line bg-black/30 px-3 py-2.5 grid grid-cols-3 gap-x-3 gap-y-2 text-[11px]">
          <div className="col-span-3 flex items-center justify-between">
            <span className="text-[9px] tracking-widest text-ink-faint font-bold flex items-center gap-1">
              <Crosshair className="h-3 w-3" /> TRADE PLAN · {p.direction}
            </span>
            <span className={`num font-bold ${p.rr1 != null && p.rr1 >= 2 ? "text-profit" : "text-warn"}`}>
              R:R {p.rr1 != null ? `1:${p.rr1.toFixed(2)}` : "N/A"}
            </span>
          </div>
          <div>
            <div className="text-[9px] text-ink-faint tracking-wider">ENTRY</div>
            <div className="num text-info font-semibold">
              {p.entryLow != null && p.entryHigh != null
                ? `${fnum(p.entryLow)}–${fnum(p.entryHigh)}`
                : p.entryRef != null
                  ? `≥ ${fnum(p.entryRef)}`
                  : "N/A"}
            </div>
          </div>
          <div>
            <div className="text-[9px] text-ink-faint tracking-wider">STOP</div>
            <div className="num text-loss font-semibold">{p.stop != null ? fnum(p.stop) : "N/A"}</div>
          </div>
          <div>
            <div className="text-[9px] text-ink-faint tracking-wider">T1 / T2</div>
            <div className="num font-semibold">
              <span className="text-profit">{p.target1 != null ? fnum(p.target1) : "N/A"}</span>
              <span className="text-ink-faint"> · </span>
              <span className="text-profit/70">{p.target2 != null ? fnum(p.target2) : "N/A"}</span>
            </div>
          </div>
        </div>

        {/* factors */}
        <div className="mt-2.5 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
          <Factor label="RVOL" value={fx(m.rvol)} good={m.rvol != null && m.rvol >= 1.5} />
          <Factor label="RS vs NIFTY" value={fpct(m.rsNiftyPct)} good={m.rsNiftyPct != null && (dirLong ? m.rsNiftyPct > 0 : m.rsNiftyPct < 0)} />
          <Factor label="RS ACCEL" value={fpct(m.rsAccelPct)} good={m.rsAccelPct != null && (dirLong ? m.rsAccelPct > 0 : m.rsAccelPct < 0)} />
          <div className="rounded-lg border border-line bg-panel-2 px-2 py-1.5">
            <div className="text-[9px] text-ink-faint tracking-wider">5M TREND</div>
            <TrendBadge trend={m.trend5m} />
          </div>
        </div>

        {/* option + futures confirmations */}
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-[10px] text-ink-dim">
          <span className="inline-flex items-center gap-1">
            <Target className="h-3 w-3 text-violet-glow" />
            OPT: {s2.optionSupport ? `PE ${s2.optionSupport.strike}` : "S N/A "} / {s2.optionResistance ? `CE ${s2.optionResistance.strike}` : "R N/A"}
          </span>
          <span className="inline-flex items-center gap-1">
            <Zap className="h-3 w-3 text-warn" />
            FUT: <FuturesBadge signal={m.futures.signal} />
          </span>
          <span className="inline-flex items-center gap-1 text-ink-faint">
            {m.futures.oi != null && m.futures.oiChange != null && (
              <>ΔOI {m.futures.oiChange >= 0 ? "+" : ""}{(m.futures.oiChange / 1000).toFixed(1)}K</>
            )}
          </span>
        </div>

        {/* explanation toggle */}
        <button
          onClick={() => setOpen((v) => !v)}
          className="mt-3 w-full flex items-center justify-between text-[10px] font-semibold tracking-wider text-info/90 hover:text-info transition border-t border-line pt-2.5"
        >
          <span className="flex items-center gap-1.5"><Info className="h-3.5 w-3.5" /> WHY THIS SETUP</span>
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>

        {open && (
          <div className="mt-2.5 space-y-2.5 text-[11px] leading-5 rise-in">
            <p className="text-ink">{s2.explanation.summary}</p>
            {s2.explanation.whyNow.length > 0 && (
              <div>
                <div className="text-[9px] tracking-widest text-info font-bold mb-1">WHY NOW</div>
                <ul className="space-y-1 text-ink-dim">
                  {s2.explanation.whyNow.map((t, i) => <li key={i} className="flex gap-1.5"><span className="text-info">▸</span>{t}</li>)}
                </ul>
              </div>
            )}
            {s2.explanation.confirmations.length > 0 && (
              <div>
                <div className="text-[9px] tracking-widest text-profit font-bold mb-1">WHAT CONFIRMS IT</div>
                <ul className="space-y-1 text-ink-dim">
                  {s2.explanation.confirmations.map((t, i) => <li key={i} className="flex gap-1.5"><span className="text-profit">▸</span>{t}</li>)}
                </ul>
              </div>
            )}
            {s2.explanation.invalidation && (
              <div className="flex gap-1.5 items-start rounded-lg border border-loss/25 bg-loss/5 px-2.5 py-2">
                <ShieldAlert className="h-3.5 w-3.5 text-loss shrink-0 mt-0.5" />
                <div>
                  <span className="text-[9px] tracking-widest text-loss font-bold">INVALIDATION — </span>
                  <span className="text-loss/90">{s2.explanation.invalidation}</span>
                </div>
              </div>
            )}
            {s2.explanation.cautions.length > 0 && (
              <div className="text-warn/90">{s2.explanation.cautions.map((c, i) => <div key={i}>• {c}</div>)}</div>
            )}
            {s2.dataGaps.length > 0 && (
              <div className="text-ink-faint">Data gaps: {s2.dataGaps.join("; ")}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Factor({ label, value, good }: { label: string; value: string; good: boolean | null }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-2 py-1.5">
      <div className="text-[9px] text-ink-faint tracking-wider">{label}</div>
      <div className={`num text-xs font-bold ${good === null ? "text-ink-dim" : good ? "text-profit" : "text-loss"}`}>{value}</div>
    </div>
  );
}

export function DirectionArrow({ pct }: { pct: number | null }) {
  if (pct == null) return null;
  return pct >= 0 ? (
    <ArrowUpRight className="h-3.5 w-3.5 text-profit" />
  ) : (
    <ArrowDownRight className="h-3.5 w-3.5 text-loss" />
  );
}
