"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import {
  ArrowLeft, ArrowUpRight, ArrowDownRight, BarChart3, CandlestickChart, Crosshair, Info, Layers,
  LineChart as LineChartIcon, ShieldAlert, Sigma, Timer, Zap, Binary,
} from "lucide-react";
import type { StockDetailPayload } from "@/lib/engine/types";
import type { DynamicSRResult, DynamicZone } from "@/lib/engine/dynamic-sr";
import type { ChartLineSpec, DynamicZoneBand } from "@/components/stock-chart";
import { StatusChip } from "@/components/dynamic-sr-tab";
import {
  DataStatusDot, DirBadge, FuturesBadge, ScoreRing, SectionTitle, SetupStateBadge, TrendBadge,
  ZoneLabel, fnum, fpct, fx, fvol, ftime, pcol, Meter,
} from "@/components/ui";
import { fetchJson, describeFetchError } from "@/lib/fetch-json";
import { DataTable, dtTableClass } from "@/components/data-table";

const StockChart = dynamic(() => import("@/components/stock-chart").then((m) => m.StockChart), { ssr: false });

export default function StockPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = use(params);
  const [data, setData] = useState<StockDetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchJson<StockDetailPayload>(`/api/stocks/${encodeURIComponent(symbol)}`));
      setError(null);
    } catch (e) {
      const status = (e as Error & { status?: number })?.status;
      setError(status === 404 ? "not-in-universe" : describeFetchError(e));
    }
  }, [symbol]);

  useEffect(() => {
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [load]);

  const optionLines = useMemo<ChartLineSpec[]>(() => {
    if (!data?.stage2) return [];
    const out: ChartLineSpec[] = [];
    if (data.stage2.optionSupport) {
      out.push({ price: data.stage2.optionSupport.strike, color: "#a78bfa", title: `PE ${data.stage2.optionSupport.strike}` });
    }
    if (data.stage2.optionResistance) {
      out.push({ price: data.stage2.optionResistance.strike, color: "#fb923c", title: `CE ${data.stage2.optionResistance.strike}` });
    }
    return out;
  }, [data]);

  const allZones = useMemo(
    () => [...(data?.stage2?.allSupports ?? []), ...(data?.stage2?.allResistances ?? [])],
    [data],
  );

  // ADDITIVE: dynamic S/R zones for chart bands + hover tooltips
  const dsr = (data?.dynamicSR as DynamicSRResult | null | undefined) ?? null;
  const dynamicBands = useMemo<DynamicZoneBand[]>(() => {
    if (!dsr) return [];
    return [...dsr.supports, ...dsr.resistances].map((z) => ({
      id: z.id,
      side: z.side,
      level: z.level,
      low: z.low,
      high: z.high,
      confidence: z.confidence,
      statusLabel: z.statusLabel,
      tests: z.tests,
      volume: z.confirmations.volume,
      futures: z.confirmations.futures,
      options: z.confirmations.options,
    }));
  }, [dsr]);

  if (error === "not-in-universe") {
    return (
      <Shell>
        <div className="panel p-10 text-center text-sm text-ink-dim">
          {symbol} is not part of the current NSE F&O universe.{" "}
          <Link href="/" className="text-info hover:underline">Back to scanner</Link>
        </div>
      </Shell>
    );
  }

  const m = data?.stage1;
  const s2 = data?.stage2;
  const p = s2?.tradePlan;
  const chg = m?.returnDayPct ?? null;

  return (
    <Shell>
      {/* header */}
      <div className="panel px-4 py-3.5 flex items-center gap-4 flex-wrap">
        <Link href="/" className="rounded-lg border border-line bg-panel-2 p-2 text-ink-dim hover:text-info transition">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="num text-xl font-black tracking-wide">{data?.symbol ?? symbol}</h1>
            {p && <DirBadge dir={p.direction} />}
            {s2 && <SetupStateBadge state={s2.setupState} />}
            {m && <TrendBadge trend={m.trend5m} />}
            {m && <DataStatusDot status={m.dataStatus} />}
          </div>
          <div className="text-[10px] text-ink-faint mt-0.5">
            {data?.name} {data?.futuresExpiry ? `· FUT expiry ${data.futuresExpiry}` : ""} {data?.optionExpiry ? `· OPT expiry ${data.optionExpiry}` : ""}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-4 sm:gap-6 flex-wrap">
          <div className="text-right">
            <div className="num text-2xl font-black">₹{fnum(m?.ltp ?? null)}</div>
            <div className={`num text-sm font-semibold flex items-center justify-end gap-1 ${pcol(chg)}`}>
              {chg != null && (chg >= 0 ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />)}
              {fpct(chg)}
            </div>
          </div>
          {s2 && (
            <div className="flex flex-col items-center">
              <ScoreRing score={s2.finalScore} size={64} />
              <span className="text-[9px] text-ink-faint mt-0.5 tracking-widest">FINAL SCORE</span>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5 items-start">
        {/* chart */}
        <div className="xl:col-span-2 panel p-4">
          <SectionTitle
            icon={<CandlestickChart className="h-4 w-4" />}
            title="INTRADAY STRUCTURE"
            hint={data?.marketPhase === "OPEN" ? `1-minute · updated ${ftime(data.generatedAt)}` : "market closed — session candles"}
          />
          <div className="mt-2">
            <StockChart candles={data?.candles1m ?? []} zones={allZones} optionLines={optionLines} plan={p ?? null} dynamicZones={dynamicBands} />
          </div>
        </div>

        <div className="space-y-4">
          {/* trade plan */}
          <div className="panel p-4">
            <SectionTitle icon={<Crosshair className="h-4 w-4" />} title="TRADE PLAN" />
            {s2 && p ? (
              <div className="mt-3 space-y-2 text-[12px]">
                <PlanRow label="Direction" value={<DirBadge dir={p.direction} />} />
                <PlanRow label="Setup state" value={<SetupStateBadge state={s2.setupState} />} />
                <PlanRow
                  label="Entry zone"
                  value={<span className="num text-info font-bold">{p.entryLow != null && p.entryHigh != null ? `${fnum(p.entryLow)}–${fnum(p.entryHigh)}` : p.entryRef != null ? `≥ ${fnum(p.entryRef)}` : "N/A"}</span>}
                />
                <PlanRow label="Stop (invalidation)" value={<span className="num text-loss font-bold">{p.stop != null ? fnum(p.stop) : "N/A"}</span>} />
                <PlanRow label="Target 1" value={<span className="num text-profit font-bold">{p.target1 != null ? fnum(p.target1) : "N/A"}</span>} />
                <PlanRow label="Target 2" value={<span className="num text-profit">{p.target2 != null ? fnum(p.target2) : "N/A"}</span>} />
                <PlanRow label="Target 3" value={<span className="num text-profit/70">{p.target3 != null ? fnum(p.target3) : "N/A"}</span>} />
                <PlanRow label="Risk per unit" value={<span className="num">{p.risk != null ? fnum(p.risk) : "N/A"}</span>} />
                <PlanRow label="R:R (to T1)" value={<span className={`num font-black ${p.rr1 != null && p.rr1 >= 2 ? "text-profit" : "text-warn"}`}>{p.rr1 != null ? `1:${p.rr1.toFixed(2)}` : "N/A"}</span>} />
                {p.stopNote && <div className="text-[10px] text-ink-faint">Stop logic: {p.stopNote}</div>}
                {p.reasonsNoTrade.length > 0 && (
                  <div className="rounded-lg border border-loss/30 bg-loss/5 px-2.5 py-2 text-[10px] text-loss">
                    {p.reasonsNoTrade.map((r, i) => <div key={i}>• {r}</div>)}
                  </div>
                )}
              </div>
            ) : (
              <p className="mt-3 text-xs text-ink-faint">No deep analysis yet — symbol enters Stage 2 only after passing fast filters.</p>
            )}
          </div>

          {/* explanation */}
          {s2 && (
            <div className="panel p-4 text-[11px] space-y-2.5 leading-5">
              <SectionTitle icon={<Info className="h-4 w-4" />} title="ENGINE EXPLANATION" />
              <p className="text-ink">{s2.explanation.summary}</p>
              {s2.explanation.whyNow.length > 0 && (
                <div>
                  <div className="text-[9px] tracking-widest text-info font-bold">WHY NOW</div>
                  {s2.explanation.whyNow.map((t, i) => <div key={i} className="text-ink-dim">▸ {t}</div>)}
                </div>
              )}
              {s2.explanation.confirmations.length > 0 && (
                <div>
                  <div className="text-[9px] tracking-widest text-profit font-bold">CONFIRMATIONS</div>
                  {s2.explanation.confirmations.map((t, i) => <div key={i} className="text-ink-dim">▸ {t}</div>)}
                </div>
              )}
              {s2.explanation.invalidation && (
                <div className="flex gap-1.5 items-start rounded-lg border border-loss/25 bg-loss/5 px-2.5 py-2">
                  <ShieldAlert className="h-3.5 w-3.5 text-loss shrink-0 mt-0.5" />
                  <span className="text-loss/90">{s2.explanation.invalidation}</span>
                </div>
              )}
              {s2.explanation.cautions.map((c, i) => <div key={i} className="text-warn/90">• {c}</div>)}
              {s2.dataGaps.length > 0 && <div className="text-ink-faint">Data gaps: {s2.dataGaps.join("; ")}</div>}
            </div>
          )}

          {/* momentum */}
          <div className="panel p-4">
            <SectionTitle icon={<Zap className="h-4 w-4" />} title="MOMENTUM" />
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2 text-center text-[11px]">
              <MiniStat label="RVOL" value={fx(m?.rvol ?? null)} tone={m?.rvol != null && m.rvol >= 1.5 ? "text-profit" : "text-ink"} />
              <MiniStat label="RS vs NIFTY" value={fpct(m?.rsNiftyPct ?? null)} tone={pcol(m?.rsNiftyPct ?? null)} />
              <MiniStat label="RS ACCEL" value={fpct(m?.rsAccelPct ?? null)} tone={pcol(m?.rsAccelPct ?? null)} />
              <MiniStat label="5M RET" value={fpct(m?.return5mPct ?? null)} tone={pcol(m?.return5mPct ?? null)} />
              <MiniStat label="15M RET" value={fpct(m?.return15mPct ?? null)} tone={pcol(m?.return15mPct ?? null)} />
              <MiniStat label="SCORE" value={m ? `${m.momentumScore}` : "N/A"} tone="text-info" />
            </div>
            <div className="mt-2.5 space-y-1 text-[10px] text-ink-faint">
              <div className="flex justify-between"><span>VWAP</span><span className="num text-ink">{fnum(m?.vwap ?? null)}</span></div>
              <div className="flex justify-between"><span>Day volume / avg</span><span className="num text-ink">{fvol(m?.dayVolume ?? null)} / {fvol(m?.avgDailyVolume ?? null)}</span></div>
              <div className="flex justify-between"><span>Sector RS</span><span className="num">N/A</span></div>
            </div>
          </div>
        </div>
      </div>

      {/* ADDITIVE: intraday dynamic S/R ladder */}
      <DynamicSRPanel sr={dsr} />

      {/* levels + score breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <ZonesPanel data={data} />
        <ScoreBreakdown data={data} />
      </div>

      {/* futures + option chain */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        <FuturesPanel data={data} />
        <BaselinePanel data={data} />
      </div>
      <OptionChainTable data={data} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-line bg-terminal/85 backdrop-blur-md">
        <div className="mx-auto max-w-[1500px] px-4 py-2.5 flex items-center gap-3">
          <span className="text-sm font-black tracking-[0.18em]">F&O PULSE</span>
          <span className="text-[9px] text-ink-faint tracking-[0.22em]">STOCK DEEP-DIVE</span>
          <Link href="/" className="ml-auto text-xs text-info hover:underline">← Scanner</Link>
        </div>
      </header>
      <main className="mx-auto max-w-[1500px] px-3 sm:px-4 py-4 sm:py-5 space-y-4 sm:space-y-5">{children}</main>
    </div>
  );
}

function PlanRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-line/40 pb-1.5 last:border-0">
      <span className="text-[10px] text-ink-faint tracking-wider">{label.toUpperCase()}</span>
      {value}
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-2 py-2">
      <div className="text-[9px] text-ink-faint tracking-wider">{label}</div>
      <div className={`num text-sm font-bold ${tone}`}>{value}</div>
    </div>
  );
}

/** ADDITIVE: Intraday Dynamic S/R ladder (S1..S3 / R1..R3). */
function DynamicSRPanel({ sr }: { sr: DynamicSRResult | null }) {
  return (
    <section className="panel p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <SectionTitle icon={<Layers className="h-4 w-4" />} title="INTRADAY DYNAMIC S/R" />
        {sr && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] num text-ink-dim">
            <span className="chip text-info border-info/40 bg-info/10">{sr.locationLabel}</span>
            <span>S {sr.distanceToSupportPct != null ? `${sr.distanceToSupportPct.toFixed(2)}%` : "N/A"} away</span>
            <span>R {sr.distanceToResistancePct != null ? `${sr.distanceToResistancePct.toFixed(2)}%` : "N/A"} away</span>
            <span className={sr.vwapRelation === "ABOVE" ? "text-profit" : sr.vwapRelation === "BELOW" ? "text-loss" : "text-ink-faint"}>VWAP {sr.vwapRelation}</span>
            <span>Breakout risk <b>{sr.breakoutRisk}</b> · Breakdown risk <b>{sr.breakdownRisk}</b></span>
          </div>
        )}
      </div>
      {!sr || (sr.supports.length === 0 && sr.resistances.length === 0) ? (
        <p className="mt-3 text-xs text-ink-faint">
          {sr?.dataGaps.length ? `INSUFFICIENT DATA — ${sr.dataGaps.join("; ")}` : "Zones appear once this symbol is part of the Stage-1 filtered set with enough 1-minute candles."}
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-3">
          <DynZoneCol title="RESISTANCE (R1→R3)" zones={sr.resistances} />
          <DynZoneCol title="SUPPORT (S1→S3)" zones={sr.supports} />
        </div>
      )}
    </section>
  );
}

function DynZoneCol({ title, zones }: { title: string; zones: DynamicZone[] }) {
  const isSup = title.startsWith("SUPPORT");
  return (
    <div className="rounded-lg border border-line bg-panel-2 p-3">
      <div className={`text-[9px] font-bold tracking-widest ${isSup ? "text-profit" : "text-loss"}`}>{title}</div>
      {zones.length === 0 && <div className="py-3 text-[10px] text-ink-faint text-center">No active zone</div>}
      <div className="mt-2 space-y-3">
        {zones.map((z) => (
          <div key={z.id} className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="num text-xs font-black w-6">{z.id}</span>
              <span className="num text-xs font-bold">{fnum(z.level)}</span>
              {z.marketConfirmed && <span className="chip text-profit border-profit/30 bg-profit/10">EXACT</span>}
              <span className={`num text-xs font-black ml-auto ${z.confidence >= 75 ? "text-profit" : z.confidence >= 55 ? "text-info" : "text-warn"}`}>{z.confidence}%</span>
            </div>
            <Meter value={z.confidence} tone={isSup ? "green" : "red"} />
            <div className="flex items-center gap-2 flex-wrap">
              <StatusChip status={z.status} label={z.statusLabel} />
              <span className="num text-[9px] text-ink-faint">
                {z.distancePct.toFixed(2)}% away · {z.tests} tests · {z.rejections} rejections{z.lastTouchAgoMin != null ? ` · ${z.lastTouchAgoMin}m ago` : ""}
              </span>
            </div>
            <div className="flex flex-wrap gap-x-3 text-[9px] text-ink-faint">
              <span>Vol {z.confirmations.volume}</span>
              <span>VWAP {z.confirmations.vwap}</span>
              <span>Fut {z.confirmations.futures}</span>
              <span>Opt {z.confirmations.options}</span>
            </div>
            {z.note && <div className="text-[9px] text-violet-glow">{z.note}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function ZonesPanel({ data }: { data: StockDetailPayload | null }) {
  const s2 = data?.stage2;
  return (
    <section className="panel p-4">
      <SectionTitle icon={<LineChartIcon className="h-4 w-4" />} title="DYNAMIC S/R ZONES" hint={s2 ? `analyzed ${ftime(s2.analyzedAt)}` : undefined} />
      {!s2 ? (
        <p className="mt-3 text-xs text-ink-faint">Zones appear after Stage-2 analysis.</p>
      ) : (
        <div className="mt-3 space-y-3 text-[11px]">
          {s2.structureNotes.map((n, i) => <div key={i} className="text-ink-dim">▸ {n}</div>)}
          {[
            { name: "Resistance (next)", z: s2.resistanceNext, cls: "text-loss/70 border-loss/15 bg-loss/5" },
            { name: "Resistance (nearest)", z: s2.resistance, cls: "text-loss border-loss/25 bg-loss/8 bg-loss/5" },
            { name: "Support (nearest)", z: s2.support, cls: "text-profit border-profit/25 bg-profit/5" },
            { name: "Support (next)", z: s2.supportNext, cls: "text-profit/70 border-profit/15 bg-profit/5" },
          ].filter((r) => r.z).map((r) => (
            <div key={r.name} className={`rounded-lg border px-3 py-2 ${r.cls}`}>
              <div className="flex items-center justify-between">
                <span className="text-[9px] tracking-widest font-bold opacity-80">{r.name.toUpperCase()}</span>
                <span className="num font-bold">{r.z!.strength}/100</span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <ZoneLabel low={r.z!.low} high={r.z!.high} />
                <span className="text-[9px] opacity-60">{r.z!.touches} touches · {r.z!.sources.slice(0, 2).join(" + ").toLowerCase().replaceAll("_", " ")}</span>
              </div>
              <div className="mt-1.5"><Meter value={r.z!.strength} tone={r.name.startsWith("Support") ? "green" : "red"} /></div>
              {r.z!.note && <div className="mt-1 text-[9px] opacity-70">{r.z!.note}</div>}
            </div>
          ))}
          <div className="grid grid-cols-2 gap-2 pt-1">
            <div className="rounded-lg border border-violet-glow/25 bg-violet-glow/5 px-3 py-2">
              <div className="text-[9px] tracking-widest text-violet-glow font-bold">OPTION SUPPORT (PE OI)</div>
              <div className="num text-sm font-bold text-violet-glow mt-0.5">
                {s2.optionSupport ? `${s2.optionSupport.strike}` : "N/A"}
              </div>
              {s2.optionSupport && (
                <div className="text-[9px] text-ink-dim mt-0.5">score {s2.optionSupport.score}/100{s2.optionSupport.unwinding ? " · unwinding" : ""}{s2.optionSupport.buildup ? " · buildup" : ""}</div>
              )}
            </div>
            <div className="rounded-lg border border-warn/25 bg-warn/5 px-3 py-2">
              <div className="text-[9px] tracking-widest text-warn font-bold">OPTION RESISTANCE (CE OI)</div>
              <div className="num text-sm font-bold text-warn mt-0.5">
                {s2.optionResistance ? `${s2.optionResistance.strike}` : "N/A"}
              </div>
              {s2.optionResistance && (
                <div className="text-[9px] text-ink-dim mt-0.5">score {s2.optionResistance.score}/100{s2.optionResistance.unwinding ? " · unwinding" : ""}{s2.optionResistance.buildup ? " · buildup" : ""}</div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function ScoreBreakdown({ data }: { data: StockDetailPayload | null }) {
  const bd = data?.stage2?.scoreBreakdown;
  return (
    <section className="panel p-4">
      <SectionTitle icon={<Sigma className="h-4 w-4" />} title="FINAL SCORE BREAKDOWN" hint={bd ? "weight × value / 100" : undefined} />
      {!bd ? (
        <p className="mt-3 text-xs text-ink-faint">Breakdown appears after Stage-2 analysis runs for this symbol.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {Object.entries(bd).map(([k, v]) => (
            <div key={k} className="text-[11px]">
              <div className="flex items-center justify-between">
                <span className="text-ink-dim capitalize">{k.replace(/([A-Z])/g, " $1").replace("sr ", "S/R ").replace("rr", "R:R")}</span>
                <span className="num text-ink-faint">
                  {v.weight}% × {v.value == null ? "N/A" : v.value} = <span className="text-info font-bold">{v.contribution}</span>
                </span>
              </div>
              <div className="mt-1"><Meter value={v.value ?? 0} tone={v.value == null ? "cyan" : v.value >= 70 ? "green" : v.value >= 45 ? "amber" : "red"} /></div>
              <div className="text-[9px] text-ink-faint">{v.note}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function FuturesPanel({ data }: { data: StockDetailPayload | null }) {
  const f = data?.futures;
  return (
    <section className="panel p-4">
      <SectionTitle icon={<Timer className="h-4 w-4" />} title="FUTURES CONFIRMATION" hint={data?.futuresExpiry ? `expiry ${data.futuresExpiry}` : "no current-month future"} />
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2 text-center text-[11px]">
        <MiniStat label="FUT LTP" value={fnum(f?.ltp ?? null)} tone="text-info" />
        <MiniStat label="OI" value={fvol(f?.oi ?? null)} tone="text-ink" />
        <MiniStat label="Δ OI" value={f?.oiChange != null ? `${f.oiChange >= 0 ? "+" : ""}${fvol(f.oiChange)}` : "N/A"} tone={pcol(f?.oiChange ?? null)} />
        <MiniStat label="VOLUME" value={fvol(f?.volume ?? null)} tone="text-ink-dim" />
        <MiniStat label="BASIS" value={f?.basis != null ? fnum(f.basis) : "N/A"} tone={pcol(f?.basis ?? null)} />
        <MiniStat label="BASIS %" value={fpct(f?.basisPct ?? null)} tone={pcol(f?.basisPct ?? null)} />
      </div>
      <div className="mt-3 flex items-center justify-between text-[11px]">
        <span className="text-ink-faint">Interpretation</span>
        <FuturesBadge signal={f?.signal ?? "UNAVAILABLE"} />
      </div>
    </section>
  );
}

function BaselinePanel({ data }: { data: StockDetailPayload | null }) {
  const b = data?.baseline;
  return (
    <section className="panel p-4">
      <SectionTitle icon={<BarChart3 className="h-4 w-4" />} title="HISTORICAL BASELINE" hint="from Upstox historical candles" />
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2 text-center text-[11px]">
        <MiniStat label="PREV HIGH" value={fnum(b?.pdh ?? null)} tone="text-loss" />
        <MiniStat label="PREV LOW" value={fnum(b?.pdl ?? null)} tone="text-profit" />
        <MiniStat label="PREV CLOSE" value={fnum(b?.pdc ?? null)} tone="text-ink-dim" />
        <MiniStat label="ATR 14" value={fnum(b?.atr14 ?? null)} tone="text-warn" />
        <MiniStat label="AVG DAY VOL" value={fvol(b?.avgDailyVolume ?? null)} tone="text-ink" />
        <MiniStat label="LTF VOL VS AVG" value={b?.avgDailyVolume && data?.stage1?.dayVolume ? `${((data.stage1.dayVolume / b.avgDailyVolume) * 100).toFixed(0)}%` : "N/A"} tone="text-info" />
      </div>
    </section>
  );
}

function OptionChainTable({ data }: { data: StockDetailPayload | null }) {
  const rows = data?.optionChain ?? [];
  return (
    <section className="panel p-3 sm:p-4">
      <SectionTitle
        icon={<Binary className="h-4 w-4" />}
        title="OPTION CHAIN"
        hint={data?.optionExpiry ? `expiry ${data.optionExpiry}${data.optionPcr != null ? ` · PCR ${data.optionPcr.toFixed(2)}` : ""}` : "unavailable"}
      />
      {rows.length === 0 ? (
        <p className="mt-3 text-xs text-ink-faint">OPTION CHAIN DATA UNAVAILABLE — chain loads once this symbol is deep-analyzed in Stage 2.</p>
      ) : (
        <DataTable minWidthClass="min-w-[820px]">
        <table className={dtTableClass("min-w-[820px]")}>
          <thead>
            <tr className="text-[9px] tracking-widest text-ink-faint border-b border-line">
              <th className="py-1.5 text-right font-semibold text-loss/70">CE OI</th>
              <th className="text-right font-semibold text-loss/70">CE ΔOI</th>
              <th className="text-right font-semibold text-loss/70">CE VOL</th>
              <th className="text-right font-semibold text-loss/70">CE LTP</th>
              <th className="text-center font-semibold">STRIKE</th>
              <th className="text-left font-semibold text-profit/70">PE LTP</th>
              <th className="text-left font-semibold text-profit/70">PE VOL</th>
              <th className="text-left font-semibold text-profit/70">PE ΔOI</th>
              <th className="text-left font-semibold text-profit/70">PE OI</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const hl = r.highlight;
              const rowCls =
                hl === "SUPPORT" ? "bg-profit/10" : hl === "RESISTANCE" ? "bg-warn/10" : hl === "BOTH" ? "bg-violet-glow/10" : "";
              const maxOi = Math.max(...rows.map((x) => Math.max(x.ceOi ?? 0, x.peOi ?? 0)), 1);
              return (
                <tr key={r.strike} className={`border-b border-line/40 table-row-hover ${rowCls}`}>
                  <td className="py-1.5 text-right num relative">
                    <OiBar value={r.ceOi} max={maxOi} side="left" />
                    {fvol(r.ceOi)}
                  </td>
                  <td className={`text-right num ${pcol(r.ceOiChange)}`}>{r.ceOiChange != null ? `${r.ceOiChange > 0 ? "+" : ""}${fvol(r.ceOiChange)}` : "N/A"}</td>
                  <td className="text-right num text-ink-dim">{fvol(r.ceVolume)}</td>
                  <td className="text-right num text-ink-dim">{fnum(r.ceLtp)}</td>
                  <td className="text-center num font-black">
                    {r.strike}
                    {hl && <span className={`ml-1.5 chip ${hl === "SUPPORT" ? "text-profit border-profit/30" : hl === "RESISTANCE" ? "text-warn border-warn/30" : "text-violet-glow border-violet-glow/30"}`}>{hl}</span>}
                  </td>
                  <td className="text-left num text-ink-dim">{fnum(r.peLtp)}</td>
                  <td className="text-left num text-ink-dim">{fvol(r.peVolume)}</td>
                  <td className={`text-left num ${pcol(r.peOiChange)}`}>{r.peOiChange != null ? `${r.peOiChange > 0 ? "+" : ""}${fvol(r.peOiChange)}` : "N/A"}</td>
                  <td className="text-left num relative">
                    {fvol(r.peOi)}
                    <OiBar value={r.peOi} max={maxOi} side="right" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </DataTable>
      )}
    </section>
  );
}

function OiBar({ value, max, side }: { value: number | null; max: number; side: "left" | "right" }) {
  if (value == null || max <= 0) return null;
  const w = Math.min(100, (value / max) * 100);
  return (
    <span
      className={`absolute top-1/2 -translate-y-1/2 h-3 rounded-sm ${side === "left" ? "right-0 bg-loss/10" : "left-0 bg-profit/10"}`}
      style={{ width: `${w}%` }}
    />
  );
}
