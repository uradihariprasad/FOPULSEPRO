"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ChevronDown, Crosshair, Layers, MoveHorizontal, ShieldCheck, Target, TrendingDown, TrendingUp,
} from "lucide-react";
import type { Confirmation, DynamicSRResult, DynamicZone, ZoneStatus } from "@/lib/engine/dynamic-sr";
import { fetchJson, describeFetchError } from "@/lib/fetch-json";
import { DataStatusDot, Meter, SectionTitle, fnum, fpct } from "./ui";

interface Row {
  symbol: string;
  direction: string | null;
  dataStatus: string;
  sr: DynamicSRResult;
}
interface Payload {
  computedAt: string;
  marketPhase: string;
  engineRunning: boolean;
  candidates: number;
  rows: Row[];
}

/* ------------------------------- status chip ------------------------------ */

export function StatusChip({ status, label }: { status: ZoneStatus; label: string }) {
  const s = status as string;
  const cls = s.startsWith("BROKEN")
    ? "text-ink-faint border-line bg-panel line-through"
    : s.includes("STRONG")
      ? s.includes("SUPPORT") ? "text-profit border-profit/50 bg-profit/15" : "text-loss border-loss/50 bg-loss/15"
      : s.includes("STRENGTHENING")
        ? "text-info border-info/45 bg-info/10"
        : s.includes("WEAKENING") || s.includes("WEAK")
          ? "text-warn border-warn/40 bg-warn/10"
          : s.includes("RISK")
            ? "text-violet-glow border-violet-glow/45 bg-violet-glow/10"
            : s.includes("SUPPORT")
              ? "text-profit/85 border-profit/30 bg-profit/8 bg-profit/5"
              : "text-loss/85 border-loss/30 bg-loss/5";
  return <span className={`chip ${cls}`}>{label}</span>;
}

function fmtOi(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${Math.round(n)}`;
}

function ConfChip({ c }: { c: Confirmation }) {
  const cls =
    c === "CONFIRMED" ? "text-profit" : c === "CONTRADICTS" ? "text-loss" : c === "NEUTRAL" ? "text-ink-dim" : "text-ink-faint";
  return <span className={`num text-[10px] font-bold ${cls}`}>{c === "UNAVAILABLE" ? "N/A" : c}</span>;
}

function LocChip({ loc, label }: { loc: string; label: string }) {
  const cls =
    loc === "BREAKOUT_WATCH" ? "text-profit border-profit/45 bg-profit/10" :
    loc === "BREAKDOWN_WATCH" ? "text-loss border-loss/45 bg-loss/10" :
    loc.includes("STRONG_SUPPORT") ? "text-profit border-profit/40 bg-profit/10" :
    loc.includes("STRONG_RESISTANCE") ? "text-loss border-loss/40 bg-loss/10" :
    loc.includes("SUPPORT") ? "text-profit/80 border-profit/25" :
    loc.includes("RESISTANCE") ? "text-loss/80 border-loss/25" :
    "text-ink-dim border-line";
  return <span className={`chip ${cls}`}>{label}</span>;
}

/* --------------------------------- the tab -------------------------------- */

export function DynamicSRTab() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchJson<Payload>("/api/dynamic-sr"));
      setError(null);
    } catch (e) {
      setError(describeFetchError(e));
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [load]);

  const t = (iso?: string) => {
    if (!iso) return "—";
    try {
      return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(iso));
    } catch { return "—"; }
  };

  return (
    <div className="space-y-4 sm:space-y-5 rise-in">
      <section className="panel p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <SectionTitle icon={<Layers className="h-4 w-4" />} title="INTRADAY DYNAMIC S/R" count={data?.candidates ?? 0} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-ink-dim num">
            <span>Stage-1 filtered stocks · zones rebuilt every scan</span>
            {error && <span className="text-warn/80">reconnecting…</span>}
            <span className="text-ink-faint">updated {t(data?.computedAt)}</span>
          </div>
        </div>
        <p className="mt-2 text-[10px] leading-4 text-ink-faint">
          Levels are derived from <span className="text-ink font-semibold">live option-chain OI positioning</span> — Put-OI walls
          below spot form support, Call-OI walls above form resistance. Each strike is scored on total OI, change in OI,
          concentration, stability and fresh writing; the exact price is the <span className="text-ink font-semibold">dynamic
          center</span> (premium-adjusted, neighbour-weighted) which snaps to the <span className="text-ink font-semibold">actual
          market reaction price</span> once price has tested it repeatedly. Levels marked EXACT are market-confirmed.
        </p>
      </section>

      {(!data || data.rows.length === 0) && (
        <section className="panel px-6 py-10 text-center">
          <Layers className="h-6 w-6 text-ink-faint mx-auto" />
          <div className="mt-2 text-sm font-bold text-ink-dim">No zones yet</div>
          <p className="mx-auto mt-1.5 max-w-md text-[11px] leading-5 text-ink-faint">
            {!data?.engineRunning
              ? "Engine is not running — connect Upstox to start scanning."
              : "Waiting for Stage-1 filtered stocks with at least 20 one-minute candles. Zones appear automatically."}
          </p>
        </section>
      )}

      <div className="space-y-2">
        {data?.rows.map((r) => <SymbolRow key={r.symbol} row={r} />)}
      </div>

      {data && data.rows.length > 0 && (
        <section className="panel p-3 sm:p-4 text-[10px] text-ink-dim">
          <div className="flex items-start gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-profit shrink-0 mt-px" />
            <p>
              Location context is informational only — it does <span className="text-ink font-semibold">not</span> generate trades.
              Entry decisions remain with the existing momentum, participation, structure and option-chain modules.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}

/* ------------------------------- symbol row ------------------------------- */

function SymbolRow({ row }: { row: Row }) {
  const [open, setOpen] = useState(false);
  const sr = row.sr;
  const ltp = sr.ltp;

  return (
    <section className="panel overflow-hidden">
      <button onClick={() => setOpen((v) => !v)} className="w-full px-3 py-2.5 flex items-center gap-2 sm:gap-3 text-left table-row-hover">
        <Link
          href={`/stock/${row.symbol}`}
          onClick={(e) => e.stopPropagation()}
          className="num font-bold text-sm w-24 sm:w-28 shrink-0 truncate hover:text-info transition"
        >
          {row.symbol}
        </Link>

        {/* S → price → R ladder */}
        <div className="flex items-center gap-1.5 sm:gap-2.5 flex-1 min-w-0 overflow-x-auto scrollable-x">
          <ZoneTag z={sr.nearestSupport} side="S" />
          <div className="flex items-center gap-1 shrink-0">
            <MoveHorizontal className="h-3 w-3 text-ink-faint" />
            <span className="num text-sm font-bold">{fnum(ltp)}</span>
          </div>
          <ZoneTag z={sr.nearestResistance} side="R" />
          <span className="shrink-0"><LocChip loc={sr.location} label={sr.locationLabel} /></span>
        </div>

        <div className="hidden lg:flex items-center gap-3 shrink-0 text-[10px] num text-ink-dim">
          <span title="Distance to support">S {sr.distanceToSupportPct != null ? `${sr.distanceToSupportPct.toFixed(2)}%` : "N/A"}</span>
          <span title="Distance to resistance">R {sr.distanceToResistancePct != null ? `${sr.distanceToResistancePct.toFixed(2)}%` : "N/A"}</span>
          <span className={sr.vwapRelation === "ABOVE" ? "text-profit" : sr.vwapRelation === "BELOW" ? "text-loss" : "text-ink-faint"}>
            VWAP {sr.vwapRelation}
          </span>
        </div>
        <DataStatusDot status={row.dataStatus} />
        <ChevronDown className={`h-3.5 w-3.5 text-ink-faint transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="border-t border-line px-3 py-3 space-y-3 rise-in">
          {sr.insufficient && (
            <div className="text-[11px] text-ink-faint">INSUFFICIENT DATA — {sr.dataGaps.join("; ") || "no zones formed"}</div>
          )}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <ZoneList title="RESISTANCE" icon={<TrendingDown className="h-3.5 w-3.5 text-loss" />} zones={sr.resistances} ltp={ltp} />
            <ZoneList title="SUPPORT" icon={<TrendingUp className="h-3.5 w-3.5 text-profit" />} zones={sr.supports} ltp={ltp} />
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-[10px] text-ink-dim border-t border-line/50 pt-2">
            {sr.dayLow != null && sr.dayHigh != null && (
              <span>Day range: <span className="num text-ink">{fnum(sr.dayLow)} – {fnum(sr.dayHigh)}</span> <span className="text-ink-faint">(zones constrained to this)</span></span>
            )}
            {sr.activeZone && (
              <span className="text-violet-glow">Price inside zone <span className="num">{fnum(sr.activeZone.low)}–{fnum(sr.activeZone.high)}</span></span>
            )}
            <span>Futures: <ConfChip c={sr.futuresConfirmation} /> <span className="text-ink-faint">{sr.futuresNote}</span></span>
            <span>Options: <ConfChip c={sr.optionsConfirmation} /> <span className="text-ink-faint">{sr.optionsNote}</span></span>
            {sr.equilibrium.pivot != null && (
              <span>OI pivot: <span className="num text-ink">{fnum(sr.equilibrium.pivot)}</span> <span className="text-ink-faint">(PE wavg {fnum(sr.equilibrium.putWeightedAvg)} / CE wavg {fnum(sr.equilibrium.callWeightedAvg)})</span></span>
            )}
            <span>Liquidity: <span className="text-ink-faint">{sr.liquidity.note}</span></span>
            {sr.expiry && <span className="text-ink-faint">expiry {sr.expiry}</span>}
            {!sr.dataAvailable && sr.reason && <span className="text-warn">{sr.reason}</span>}
            <span>Breakout risk: <b className={sr.breakoutRisk === "HIGH" ? "text-profit" : "text-ink-dim"}>{sr.breakoutRisk}</b></span>
            <span>Breakdown risk: <b className={sr.breakdownRisk === "HIGH" ? "text-loss" : "text-ink-dim"}>{sr.breakdownRisk}</b></span>
            <span>ATR: <span className="num">{sr.atr != null ? fnum(sr.atr) : "N/A"}</span></span>
            {sr.dataGaps.length > 0 && <span className="text-ink-faint">Gaps: {sr.dataGaps.join("; ")}</span>}
          </div>
        </div>
      )}
    </section>
  );
}

function ZoneTag({ z, side }: { z: DynamicZone | null; side: "S" | "R" }) {
  if (!z) return <span className="num text-[11px] text-ink-faint shrink-0">{side}: N/A</span>;
  const tone = side === "S" ? "text-profit border-profit/30 bg-profit/5" : "text-loss border-loss/30 bg-loss/5";
  return (
    <span className={`shrink-0 rounded-md border px-2 py-1 num text-[11px] ${tone}`}>
      <b>{z.id}</b> {fnum(z.level)} <span className="opacity-70">{z.confidence}%</span>
    </span>
  );
}

function ZoneList({ title, icon, zones, ltp }: { title: string; icon: React.ReactNode; zones: DynamicZone[]; ltp: number | null }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 p-2.5">
      <div className="flex items-center gap-1.5 text-[9px] font-bold tracking-widest text-ink-dim">{icon}{title}</div>
      {zones.length === 0 && <div className="py-3 text-center text-[10px] text-ink-faint">No active {title.toLowerCase()} zone</div>}
      <div className="mt-2 space-y-2.5">
        {zones.map((z) => (
          <div key={z.id} className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="num text-[11px] font-black w-6">{z.id}</span>
              <span className="num text-[11px] font-bold">{fnum(z.level)}</span>
              {z.marketConfirmed && <span className="chip text-profit border-profit/30 bg-profit/10">EXACT</span>}
              <span className={`num text-[11px] font-black ml-auto ${z.confidence >= 75 ? "text-profit" : z.confidence >= 55 ? "text-info" : "text-warn"}`}>{z.confidence}%</span>
            </div>
            <Meter value={z.confidence} tone={z.side === "SUPPORT" ? "green" : "red"} />
            <div className="flex items-center gap-2 flex-wrap">
              <StatusChip status={z.status} label={z.statusLabel} />
              <span className="num text-[9px] text-ink-faint">
                {z.distancePct.toFixed(2)}% away · {z.tests} tests · {z.rejections} rej
                {z.lastTouchAgoMin != null ? ` · ${z.lastTouchAgoMin}m ago` : ""}
              </span>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] text-ink-dim num">
              <span>strike <b className="text-ink">{z.strike}</b></span>
              <span>OI {z.oi != null ? fmtOi(z.oi) : "N/A"}</span>
              <span className={z.changeOi != null && z.changeOi < 0 ? "text-loss" : "text-profit"}>
                ΔOI {z.changeOi != null ? `${z.changeOi >= 0 ? "+" : ""}${fmtOi(z.changeOi)}` : "N/A"}
              </span>
              <span>conc {z.oiConcentration != null ? `${Math.round(z.oiConcentration * 100)}%` : "N/A"}</span>
              <span>fresh {z.freshWriting != null ? `${Math.round(z.freshWriting * 100)}%` : "N/A"}</span>
              <span>stab {z.oiStability != null ? `${Math.round(z.oiStability * 100)}%` : "—"}</span>
              <span>strength <b className="text-info">{z.strength}</b></span>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] text-ink-faint">
              <span>Price <ConfChip c={z.priceConfirmation} /></span>
              <span>Vol <ConfChip c={z.confirmations.volume} /></span>
              <span>Liq <ConfChip c={z.liquidityConfirmation} /></span>
              <span>Fut <ConfChip c={z.confirmations.futures} /></span>
              <span>OI <ConfChip c={z.confirmations.options} /></span>
              {z.marketConfirmed && <span className="text-profit">level {fnum(z.level)} market-confirmed</span>}
            </div>
            {z.migration.moved && <div className="text-[9px] text-violet-glow">{z.migration.note}</div>}
            {z.note && <div className="text-[9px] text-violet-glow">{z.note}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
