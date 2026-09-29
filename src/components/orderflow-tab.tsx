"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowDownRight, ArrowUpRight, ChevronDown, CircleDot, Flame, Layers3, ListOrdered,
  MoveHorizontal, Radar, RefreshCcw, ScanLine, ShieldCheck, TrendingDown, TrendingUp, Zap,
} from "lucide-react";
// Layers3 is used by the DYNAMIC S/R tab button below.
import type { OrderFlowResult, DominanceTrend, DominanceBand } from "@/lib/engine/orderflow";
import { fetchJson, describeFetchError } from "@/lib/fetch-json";
import { DataStatusDot, Meter, SectionTitle } from "./ui";

/* ------------------------------ payload types ----------------------------- */

interface OrderFlowPayload {
  computedAt: string;
  marketPhase: string;
  engineRunning: boolean;
  universeScanned: number;
  minRankScore: number;
  buyers: OrderFlowResult[];
  sellers: OrderFlowResult[];
  stats: { freshRankable: number; excludedStale: number; conflicting: number; coverageAvg: number };
  qualityStats?: { premium: number; good: number; speculative: number; bookSustained: number; absorbed: number };
}

/* -------------------------------- tab bar -------------------------------- */

export type AppTab = "scanner" | "radar" | "conviction" | "orderflow" | "reversal";

export function TabsHeader({ tab, setTab }: { tab: AppTab; setTab: (t: AppTab) => void }) {
  return (
    <div className="relative w-full sm:w-fit">
      {/* mobile affordance: tabs scroll horizontally on phones */}
      <div className="dt-hint !pb-1 !pt-0.5">
        <MoveHorizontal className="h-3 w-3" />
        <span>swipe for more tabs</span>
      </div>
      <div
        className="flex items-center gap-1.5 rounded-xl border border-line bg-panel p-1 w-full sm:w-fit overflow-x-auto scrollable-x
                   [&>*]:shrink-0"
      >
      <TabBtn active={tab === "scanner"} onClick={() => setTab("scanner")} icon={<ScanLine className="h-3.5 w-3.5" />} label="SCANNER" short="SCAN" />
      <TabBtn active={tab === "radar"} onClick={() => setTab("radar")} icon={<Radar className="h-3.5 w-3.5" />} label="MOMENTUM RADAR" short="RADAR" />
      <TabBtn active={tab === "conviction"} onClick={() => setTab("conviction")} icon={<Flame className="h-3.5 w-3.5" />} label="MOMENTUM CONVICTION" short="CONVICTION" />
      <TabBtn active={tab === "orderflow"} onClick={() => setTab("orderflow")} icon={<ListOrdered className="h-3.5 w-3.5" />} label="ORDER FLOW DOMINANCE" short="ORDER FLOW" />

      <TabBtn active={tab === "reversal"} onClick={() => setTab("reversal")} icon={<RefreshCcw className="h-3.5 w-3.5" />} label="REVERSAL RADAR" short="REVERSAL" />
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, icon, label, short }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; short?: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 rounded-lg px-3 sm:px-3.5 py-2 text-[10px] font-bold tracking-[0.12em] whitespace-nowrap transition ${
        active ? "bg-info/15 text-info border border-info/40" : "text-ink-dim border border-transparent hover:text-ink"
      }`}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
      <span className="sm:hidden">{short ?? label}</span>
    </button>
  );
}

/* ------------------------------ orderflow tab ----------------------------- */

export function OrderFlowTab() {
  const [data, setData] = useState<OrderFlowPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchJson<OrderFlowPayload>("/api/orderflow"));
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

  const fmtTime = (iso?: string) => {
    if (!iso) return "—";
    try {
      return new Intl.DateTimeFormat("en-IN", {
        timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      }).format(new Date(iso));
    } catch { return "—"; }
  };

  return (
    <div className="space-y-4 sm:space-y-5 rise-in">
      {/* header strip */}
      <section className="panel p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <SectionTitle icon={<ListOrdered className="h-4 w-4" />} title="ORDER FLOW DOMINANCE" />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-ink-dim num">
            <span className="flex items-center gap-1.5"><Layers3 className="h-3.5 w-3.5 text-info" /> universe {data?.universeScanned ?? 0}</span>
            <span>fresh & rankable {data?.stats.freshRankable ?? 0}</span>
            <span>excluded stale {data?.stats.excludedStale ?? 0}</span>
            <span>conflicting {data?.stats.conflicting ?? 0}</span>
            <span className="text-profit">premium {data?.qualityStats?.premium ?? 0}</span>
            <span className="text-info">good {data?.qualityStats?.good ?? 0}</span>
            <span className="text-ink-faint">speculative {data?.qualityStats?.speculative ?? 0}</span>
            <span className="text-ink-faint">gate ≥ {data?.minRankScore ?? 55}</span>
            {error ? <span className="text-warn/80">reconnecting…</span> : null}
            <span className="text-ink-faint">rank gate ≥ {data?.minRankScore ?? 60} · updated {fmtTime(data?.computedAt)}</span>
          </div>
        </div>
        <p className="mt-2 text-[10px] leading-4 text-ink-faint">
          Surfaces only <span className="text-ink font-semibold">quality</span> one-sided names. Resting depth must be
          SUSTAINED over repeated samples (a single flickering top-5 snapshot is not trusted), executed volume-weighted
          transaction flow carries the most weight, and a stock must clear real turnover &amp; RVOL floors to rank.
          Names whose resting book contradicts the tape are labelled CONFLICTING and never listed.
        </p>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-5">
        <DominanceColumn side="buyer" rows={data?.buyers ?? []} emptyHint={emptyHint("buyer", data)} />
        <DominanceColumn side="seller" rows={data?.sellers ?? []} emptyHint={emptyHint("seller", data)} />
      </div>

      {/* legend */}
      <section className="panel p-3 sm:p-4 text-[10px] text-ink-dim space-y-1.5">
        <div className="flex items-center gap-1.5 text-info font-bold tracking-widest text-[9px]">INTERPRETATION</div>
        <div className="flex flex-wrap gap-x-5 gap-y-1 num">
          <span><BandDot c="#34d399" /> 80–100 VERY STRONG</span>
          <span><BandDot c="#38bdf8" /> 70–79 STRONG</span>
          <span><BandDot c="#fbbf24" /> 60–69 MODERATE</span>
          <span className="text-ink-faint">&lt;60 NOT RANKED</span>
        </div>
        <p className="flex items-start gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-profit shrink-0 mt-px" />
          Scores use only live Upstox depth, orders, prices, volume, VWAP, futures OI and the existing momentum
          computations. Stale or missing critical data shows N/A and is excluded — conflicting signal sets are capped
          and labelled CONFLICTING FLOW.
        </p>
      </section>
    </div>
  );
}

function emptyHint(side: "buyer" | "seller", data: OrderFlowPayload | null): string {
  if (!data) return "Collecting order-flow data…";
  if (!data.engineRunning) return "Engine is not running — connect Upstox.";
  return `No ${side === "buyer" ? "buyer" : "seller"}-dominating stock clears the ${data.minRankScore} threshold with fresh, non-conflicting data right now. Not forcing results.`;
}

function BandDot({ c }: { c: string }) {
  return <span className="inline-block h-2 w-2 rounded-full mr-1.5" style={{ background: c }} />;
}

/* ------------------------------ a column --------------------------------- */

function DominanceColumn({ side, rows, emptyHint }: { side: "buyer" | "seller"; rows: OrderFlowResult[]; emptyHint: string }) {
  const isBuyer = side === "buyer";
  const score = (r: OrderFlowResult) => (isBuyer ? r.buyerScore : r.sellerScore);
  return (
    <section className="panel p-3 sm:p-4">
      <div className="flex items-center justify-between">
        <SectionTitle
          icon={isBuyer ? <TrendingUp className="h-4 w-4 text-profit" /> : <TrendingDown className="h-4 w-4 text-loss" />}
          title={isBuyer ? "TOP BUYER DOMINANCE" : "TOP SELLER DOMINANCE"}
          count={rows.length}
        />
        <span className={`chip ${isBuyer ? "text-profit border-profit/40 bg-profit/10" : "text-loss border-loss/40 bg-loss/10"}`}>
          {isBuyer ? "BUY-SIDE PRESSURE" : "SELL-SIDE PRESSURE"}
        </span>
      </div>
      <div className="mt-3 space-y-1.5">
        {rows.length === 0 && <div className="py-6 px-3 text-center text-[11px] leading-5 text-ink-faint">{emptyHint}</div>}
        {rows.map((r, i) => (
          <DominanceRow key={r.symbol} row={r} rank={i + 1} isBuyer={isBuyer} score={score(r)} />
        ))}
      </div>
    </section>
  );
}

function DominanceRow({
  row, rank, isBuyer, score,
}: {
  row: OrderFlowResult;
  rank: number;
  isBuyer: boolean;
  score: number;
}) {
  const [open, setOpen] = useState(false);
  const conf = isBuyer ? row.buyerConfidence : row.sellerConfidence;
  const band = isBuyer ? row.buyerBand : row.sellerBand;
  const trend = isBuyer ? row.buyerTrend : row.sellerTrend;
  const aligned = isBuyer ? row.alignedForBuyer : row.alignedForSeller;
  const tone = isBuyer ? "text-profit" : "text-loss";

  return (
    <div className="rounded-lg border border-line bg-panel-2 overflow-hidden">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2 sm:gap-3 px-2.5 sm:px-3 py-2.5 text-left table-row-hover">
        <span className="num text-ink-faint text-xs w-4">{rank}</span>
        <Link
          href={`/stock/${row.symbol}`}
          onClick={(e) => e.stopPropagation()}
          className="num font-bold text-sm w-24 sm:w-28 truncate hover:text-info transition"
        >
          {row.symbol}
        </Link>
        <div className="flex-1 min-w-[64px] max-w-[130px]">
          <Meter value={score} tone={isBuyer ? "green" : "red"} />
        </div>
        <span className={`num text-sm font-black ${tone}`}>{score}</span>
        <ConfChip conf={conf} />
        <span className="hidden md:inline"><TrendChip trend={trend} /></span>
        <span className={`chip shrink-0 ${
          row.quality === "PREMIUM" ? "text-profit border-profit/50 bg-profit/15" :
          row.quality === "GOOD" ? "text-info border-info/40 bg-info/10" :
          row.quality === "SPECULATIVE" ? "text-warn border-warn/40 bg-warn/10" :
          "text-ink-faint border-line"}`}>{row.quality}</span>
        <ChevronDown className={`h-3.5 w-3.5 text-ink-faint transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="border-t border-line px-3 py-3 space-y-2.5 text-[11px] rise-in">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <BandChip band={band} />
            <TrendChip trend={trend} />
            <span className="text-ink-faint">aligned {aligned}/6 · conflicts {row.conflictCount} · book samples {row.samplesUsed}{row.bookSustained ? " (sustained)" : row.samplesUsed < 3 ? " (building)" : ""}</span>
            <span className="text-ink-faint">coverage {row.coveragePct}%</span>
            {row.flowSmoothness != null && (
              <span className={row.flowSmoothness >= 50 ? "text-profit" : "text-ink-faint"}>
                smoothness {Math.round(row.flowSmoothness)}%
              </span>
            )}
            <DataStatusDot status={row.dataStatus} />
            {row.conflictingFlow && <span className="chip text-warn border-warn/40 bg-warn/10">CONFLICTING FLOW</span>}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-1.5">
            {row.components.map((c) => {
              const v = isBuyer ? c.buyerValue : c.sellerValue;
              return (
                <div key={c.key} className="flex items-center gap-2.5">
                  <span className="w-32 shrink-0 text-[10px] text-ink-dim">{c.label} <span className="text-ink-faint">{c.weight}%</span></span>
                  <div className="flex-1"><Meter value={v ?? 0} tone={v == null ? "cyan" : v >= 60 ? (isBuyer ? "green" : "red") : "cyan"} /></div>
                  <span className={`num w-8 text-right font-bold ${v == null ? "text-ink-faint" : tone}`}>{v == null ? "—" : v}</span>
                </div>
              );
            })}
          </div>
          <div className="space-y-1 border-t border-line/50 pt-2">
            {row.components.map((c) => (
              <div key={c.key} className="flex gap-2 text-[10px]">
                <span className="w-32 shrink-0 text-ink-faint">{c.label}</span>
                <span className="num text-ink-dim">{c.evidence}</span>
              </div>
            ))}
          </div>
          {row.qualityNotes.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] text-ink-faint num">
              {row.qualityNotes.map((q, i) => <span key={i}>· {q}</span>)}
            </div>
          )}
          {row.blockReasons.length > 0 && (
            <div className="rounded-lg border border-warn/20 bg-warn/5 px-2.5 py-1.5 text-[10px] text-warn/80 space-y-0.5">
              {row.blockReasons.map((b, i) => <div key={i}>• {b}</div>)}
            </div>
          )}
          {row.notes.length > 0 && (
            <div className="rounded-lg border border-warn/25 bg-warn/5 px-2.5 py-2 text-[10px] text-warn space-y-0.5">
              {row.notes.map((n, i) => <div key={i}>• {n}</div>)}
            </div>
          )}
          <div className="text-[9px] text-ink-faint">
            Pressure interpretation only — displayed depth imbalance is not proof of any participant's behaviour.
          </div>
        </div>
      )}
    </div>
  );
}

function ConfChip({ conf }: { conf: "HIGH" | "MEDIUM" | "LOW" }) {
  const cls =
    conf === "HIGH" ? "text-profit border-profit/40 bg-profit/10" :
    conf === "MEDIUM" ? "text-warn border-warn/40 bg-warn/10" :
    "text-ink-faint border-line bg-panel";
  return <span className={`chip ${cls}`}>{conf}</span>;
}

function BandChip({ band }: { band: DominanceBand }) {
  const cls =
    band === "VERY STRONG" ? "text-profit border-profit/40 bg-profit/10" :
    band === "STRONG" ? "text-info border-info/40 bg-info/10" :
    band === "MODERATE" ? "text-warn border-warn/40 bg-warn/10" :
    "text-ink-faint border-line";
  return <span className={`chip ${cls}`}>{band}</span>;
}

function TrendChip({ trend }: { trend: DominanceTrend }) {
  if (trend === "UNAVAILABLE") return <span className="text-[10px] text-ink-faint num">TREND N/A</span>;
  const map: Record<string, { cls: string; icon: React.ReactNode }> = {
    ACCELERATING: { cls: "text-profit", icon: <ArrowUpRight className="h-3 w-3" /> },
    WEAKENING: { cls: "text-loss", icon: <ArrowDownRight className="h-3 w-3" /> },
    STABLE: { cls: "text-ink-dim", icon: <CircleDot className="h-3 w-3" /> },
    REVERSING: { cls: "text-warn", icon: <Zap className="h-3 w-3" /> },
  };
  const m = map[trend];
  return <span className={`inline-flex items-center gap-1 text-[10px] font-bold num ${m.cls}`}>{m.icon}{trend}</span>;
}
