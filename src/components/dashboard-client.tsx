"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity, ArrowDownWideNarrow, ArrowUpNarrowWide, Clock3, DatabaseZap, Flame, Gauge,
  ListFilter, MoonStar, Radar, Settings2, ShieldCheck, TrendingUp, Zap, ChevronRight,
  PlugZap, AlertTriangle, Layers3, ScanSearch, ListChecks, Trophy, ChevronUp, ChevronDown, MoveHorizontal,
} from "lucide-react";
import type { DashboardPayload, Stage1Metrics } from "@/lib/engine/types";
import { fetchJson, describeFetchError } from "@/lib/fetch-json";
import { ConnectModal, SettingsDrawer } from "./modals";
import { SetupCard } from "./setup-card";
import { OrderFlowTab, TabsHeader, type AppTab } from "./orderflow-tab";
import { ConvictionTab } from "./conviction-tab";
import { MomentumRadarTab } from "./momentum-radar-tab";
import { ReversalRadarTab } from "./reversal-radar-tab";
import { DataTable, dtTableClass } from "./data-table";
import {
  DataStatusDot, DirBadge, FuturesBadge, SectionTitle, TrendBadge, fnum, fpct, fx, ftime, fvol, fcr, pcol,
} from "./ui";

const POLL_MS = 8000;

export function DashboardClient() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<AppTab>("scanner");
  const [ts, setTs] = useState("");

  const load = useCallback(async () => {
    try {
      const payload = await fetchJson<DashboardPayload>("/api/dashboard");
      setData(payload);
      setError(null);
    } catch (e) {
      setError(describeFetchError(e));
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    const clock = setInterval(() => {
      setTs(
        new Intl.DateTimeFormat("en-IN", {
          timeZone: "Asia/Kolkata",
          hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
        }).format(new Date()),
      );
    }, 1000);
    return () => clearInterval(clock);
  }, []);

  const e = data?.engine;
  const mkt = data?.market;
  const phase = e?.marketPhase ?? "CLOSED";
  const marketOpen = phase === "OPEN";
  const connected = !!e?.connected;

  return (
    <div className="min-h-screen">
      {/* ============================== TOP BAR ============================== */}
      <header className="sticky top-0 z-40 border-b border-line bg-terminal/85 backdrop-blur-md">
        <div className="mx-auto max-w-[1500px] px-3 sm:px-4 py-2.5 flex items-center gap-2.5 sm:gap-4 flex-wrap">
          <div className="flex items-center gap-2 shrink-0">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-info/30 to-violet-glow/20 border border-info/30 flex items-center justify-center">
              <Radar className="h-[18px] w-[18px] text-info" />
            </div>
            <div className="hidden sm:block">
              <div className="text-sm font-black tracking-[0.18em]">F&O PULSE</div>
              <div className="text-[9px] text-ink-faint tracking-[0.22em]">UPSTOX TWO-STAGE SCANNER</div>
            </div>
          </div>

          {/* actions — always visible, right-aligned */}
          <div className="ml-auto flex items-center gap-2 shrink-0 order-2">
            <button
              onClick={() => setSettingsOpen(true)}
              className="rounded-lg border border-line bg-panel p-2.5 text-ink-dim hover:text-info hover:border-info/50 transition"
              title="Engine settings"
            >
              <Settings2 className="h-4 w-4" />
            </button>
            <button
              onClick={() => setConnectOpen(true)}
              className={`flex items-center gap-2 rounded-lg border px-3 sm:px-3.5 py-2.5 sm:py-2 text-xs font-bold transition ${
                connected
                  ? "border-profit/40 bg-profit/10 text-profit hover:bg-profit/20"
                  : "border-info/50 bg-info/90 text-terminal hover:bg-info"
              }`}
            >
              <PlugZap className="h-4 w-4" />
              <span className="max-w-[110px] truncate sm:max-w-none">
                {connected ? (e?.userName ?? "Connected") : "Connect Upstox"}
              </span>
            </button>
          </div>

          {/* market strip — scrolls horizontally on narrow screens */}
          <div className="order-3 sm:order-2 sm:flex-1 w-full sm:w-auto min-w-0 flex items-center gap-2.5 overflow-x-auto scrollable-x">
            <div className="flex items-center gap-2.5 sm:gap-3 rounded-lg border border-line bg-panel px-3 py-1.5 shrink-0">
              <div className="text-[9px] tracking-widest text-ink-faint font-bold">NIFTY 50</div>
              <div className="num text-sm sm:text-base font-bold">{fnum(mkt?.niftyLtp ?? null, 2)}</div>
              <div className={`num text-xs font-semibold ${pcol(mkt?.niftyChangePct ?? null)}`}>
                {fpct(mkt?.niftyChangePct ?? null)}
              </div>
              {mkt?.regime && (
                <span className={`chip hidden sm:inline ${mkt.regime === "RISK-ON" ? "text-profit border-profit/40 bg-profit/10" : mkt.regime === "RISK-OFF" ? "text-loss border-loss/40 bg-loss/10" : "text-warn border-warn/40 bg-warn/10"}`}>
                  {mkt.regime}
                </span>
              )}
            </div>
            {mkt?.advances != null && (
              <div className="hidden lg:flex items-center gap-2 text-[11px] num shrink-0">
                <span className="text-profit">▲ {mkt.advances}</span>
                <span className="text-ink-faint">/</span>
                <span className="text-loss">▼ {mkt.declines}</span>
                <span className="text-[9px] text-ink-faint tracking-wider">BREADTH</span>
              </div>
            )}
            <div className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[10px] font-bold tracking-wider shrink-0 ${
              marketOpen ? "border-profit/40 bg-profit/10 text-profit" : "border-line bg-panel text-ink-dim"
            }`}>
              {marketOpen ? <Activity className="h-3.5 w-3.5 live-dot" /> : <MoonStar className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">{marketOpen ? "MARKET OPEN" : "MARKET CLOSED"}</span>
              <span className="sm:hidden">{marketOpen ? "OPEN" : "CLOSED"}</span>
            </div>
            <DataStatusDot status={mkt?.dataStatus ?? "UNAVAILABLE"} />
            <div className="flex items-center gap-1.5 text-[10px] text-ink-dim num shrink-0">
              <Clock3 className="h-3.5 w-3.5" />
              <span title="IST clock">{ts || "—"}</span>
            </div>
            <div className="hidden xl:block text-[9px] text-ink-faint num shrink-0" title="Last engine scan">
              SCAN {ftime(e?.lastScanAt ?? null)} · DEEP {ftime(e?.lastStage2At ?? null)}
            </div>
          </div>
        </div>
        {e?.tokenInvalid && (
          <div className="bg-loss/15 border-t border-loss/30 text-loss text-xs px-4 py-1.5 flex items-center gap-2 justify-center">
            <AlertTriangle className="h-3.5 w-3.5" /> Token rejected by Upstox (401) — reconnect with a fresh token. Trade generation paused.
          </div>
        )}
        {!marketOpen && connected && (
          <div className="bg-warn/5 border-t border-warn/20 text-warn text-[11px] px-4 py-1.5 text-center num tracking-wide">
            MARKET CLOSED — live signal generation paused. Engine resumes automatically at 09:15 IST. Historical analysis uses actual Upstox data only.
          </div>
        )}
      </header>

      <main className="mx-auto max-w-[1500px] px-3 sm:px-4 py-4 sm:py-5 space-y-4 sm:space-y-5">
        {!connected ? (
          <NotConnected onConnect={() => setConnectOpen(true)} />
        ) : (
          <>
            <TabsHeader tab={tab} setTab={setTab} />
            {tab === "reversal" ? (
              <ReversalRadarTab />
            ) : tab === "radar" ? (
              <MomentumRadarTab />
            ) : tab === "conviction" ? (
              <ConvictionTab />
            ) : tab === "orderflow" ? (
              <OrderFlowTab />
            ) : (
              <>
            {/* ============================ PIPELINE ============================ */}
            <Pipeline data={data} />

            {error && (
              <div className="rounded-lg border border-warn/25 bg-warn/5 px-4 py-1.5 text-[11px] text-warn/80 flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-warn live-dot" />
                {error} — auto-scan continues in the background
              </div>
            )}

            {/* ===================== TOP 10 + SIDE PANELS ===================== */}
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
              <section className="xl:col-span-2 space-y-3">
                <SectionTitle
                  icon={<Flame className="h-4 w-4" />}
                  title={`TOP ${data?.config.topNSetups ?? 10} TRADE SETUPS`}
                  hint={data ? `${data.pipeline.stage2Analyzed} deep-analyzed → ${data.pipeline.setups} valid` : undefined}
                />
                {data && data.topSetups.length === 0 ? (
                  <EmptyPanel
                    icon={<Trophy className="h-6 w-6 text-ink-faint" />}
                    title="No trade-quality setups right now"
                    body={
                      marketOpen
                        ? "The engine refuses to force trades. Candidates are being scanned; setups appear only when structure, volume, RS, futures and option positioning converge with valid R:R."
                        : "Market is closed. Setup generation resumes when NSE opens (09:15 IST)."
                    }
                  />
                ) : (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                    {data?.topSetups.map((s, i) => <SetupCard key={s.stage1.symbol} data={s} rank={i + 1} />)}
                  </div>
                )}
              </section>

              <aside className="space-y-4">
                <StockListPanel
                  icon={<Clock3 className="h-4 w-4" />}
                  title="EARLY MOMENTUM"
                  rows={data?.earlyMomentum ?? []}
                  empty="No 1-min ignition detected"
                  highlight="score"
                />
                <StockListPanel
                  icon={<ListChecks className="h-4 w-4" />}
                  title="CONFIRMED MOMENTUM"
                  rows={data?.confirmedMomentum ?? []}
                  empty="Awaiting 5-min confirmation"
                  highlight="score"
                />
                <StockListPanel
                  icon={<ArrowUpNarrowWide className="h-4 w-4" />}
                  title="BREAKOUT WATCH"
                  rows={data?.breakoutWatch ?? []}
                  empty="No pending breakouts"
                  highlight="rs"
                />
                <StockListPanel
                  icon={<ArrowDownWideNarrow className="h-4 w-4" />}
                  title="BREAKDOWN WATCH"
                  rows={data?.breakdownWatch ?? []}
                  empty="No pending breakdowns"
                  highlight="rs"
                />
              </aside>
            </div>

            {/* ======================== LEADERBOARDS ======================== */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
              <TablePanel
                icon={<TrendingUp className="h-4 w-4" />}
                title="STRONGEST RS"
                rows={data?.strongestRs ?? []}
                metric="rs"
              />
              <TablePanel
                icon={<TrendingUp className="h-4 w-4 rotate-180" />}
                title="STRONGEST RW"
                rows={data?.strongestRw ?? []}
                metric="rs"
                invert
              />
              <TablePanel
                icon={<Gauge className="h-4 w-4" />}
                title="HIGHEST RVOL"
                rows={data?.highestRvol ?? []}
                metric="rvol"
              />
            </div>

            {/* ======================== CANDIDATE TAPE ======================== */}
            <CandidateTape rows={data?.candidates ?? []} />

            <footer className="safe-bottom flex flex-wrap items-center gap-x-6 gap-y-1 pt-2 pb-6 text-[10px] text-ink-faint">
              <span className="flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" /> Data source: Upstox API only — zero synthetic market data. Missing values render as N/A.</span>
              <span>Universe updated: {ftime(data?.universe.universeUpdatedAt ?? null)}</span>
              <span>Baselines: {data?.universe.baselinesReady ?? 0}/{Math.max(data?.universe.total ?? 0, 0)} symbols</span>
              <span>Liquidity gate: ≥ ₹{data?.config.minTurnoverCr ?? 150} Cr turnover — {data?.universe.illiquidFiltered ?? 0} excluded</span>
              <span>Generated: {ftime(data?.generatedAt)}</span>
            </footer>
              </>
            )}
          </>
        )}
      </main>

      <ConnectModal
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        onConnected={load}
        connected={connected}
        userName={e?.userName ?? null}
        tokenInvalid={!!e?.tokenInvalid}
      />
      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        config={data?.config ?? null}
        onSaved={load}
      />
    </div>
  );
}

/* ================================ pipeline ================================ */

function Pipeline({ data }: { data: DashboardPayload | null }) {
  const p = data?.pipeline;
  const nodes = [
    { icon: Layers3, label: "ALL NSE F&O", value: data?.universe.total ?? 0, sub: `${data?.universe.withQuotes ?? 0} quoted · ${data?.universe.liquidCount ?? 0} liquid`, tone: "text-ink" },
    { icon: ScanSearch, label: "STAGE 1 · FAST FILTER", value: (p?.candidatesLong ?? 0) + (p?.candidatesShort ?? 0), sub: `${p?.candidatesLong ?? 0}L / ${p?.candidatesShort ?? 0}S · liq ≥ ₹${data?.config.minTurnoverCr ?? 150} Cr`, tone: "text-info" },
    { icon: ListFilter, label: "STAGE 2 · DEEP ANALYSIS", value: p?.stage2Analyzed ?? 0, sub: "S/R · options · futures", tone: "text-violet-glow" },
    { icon: DatabaseZap, label: "VALID R:R", value: p?.setups ?? 0, sub: `min 1:${data?.config.minRR ?? 2}`, tone: "text-warn" },
    { icon: Trophy, label: `TOP ${data?.config.topNSetups ?? 10}`, value: Math.min(p?.setups ?? 0, data?.config.topNSetups ?? 10), sub: "final score ranked", tone: "text-profit" },
  ];
  return (
    <section className="panel p-2.5 sm:p-3.5">
      <div className="dt-hint">
        <MoveHorizontal className="h-3.5 w-3.5" />
        <span>swipe for pipeline stages</span>
      </div>
      <div className="scrollable-x">
      <div className="flex items-stretch gap-2 min-w-[860px]">
        {nodes.map((n, i) => (
          <div key={n.label} className="flex items-center gap-2 flex-1 min-w-0">
            <div className="flex-1 rounded-lg border border-line bg-panel-2 px-3 py-2.5 min-w-0">
              <div className="flex items-center gap-2">
                <n.icon className={`h-4 w-4 shrink-0 ${n.tone}`} />
                <div className="text-[9px] tracking-[0.12em] text-ink-faint font-bold truncate">{n.label}</div>
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className={`num text-xl font-black ${n.tone}`}>{n.value}</span>
                <span className="text-[9px] text-ink-faint truncate">{n.sub}</span>
              </div>
            </div>
            {i < nodes.length - 1 && (
              <div className="relative w-6 shrink-0 hidden md:block">
                <div className="absolute inset-x-0 top-1/2 h-px flow-line" />
                <ChevronRight className="h-3.5 w-3.5 text-info/70 absolute -right-1 top-1/2 -translate-y-1/2" />
              </div>
            )}
          </div>
        ))}
      </div>
      </div>
      <div className="mt-2 hidden sm:flex flex-wrap gap-x-4 gap-y-0.5 text-[9px] text-ink-faint tracking-wider px-1">
        <span>STAGE 1: RVOL · RS · RS-ACCEL · VWAP · MOMENTUM · 5M EMA/STRUCTURE · FUTURES OI</span>
        <span>STAGE 2: DYNAMIC S/R · OPTION-CHAIN OI · VOLUME LEVELS · BREAKOUT/RETEST · FINAL SCORE</span>
      </div>
    </section>
  );
}

/* ================================ panels ================================= */

function EmptyPanel({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="panel px-6 py-10 text-center">
      <div className="flex justify-center">{icon}</div>
      <div className="mt-2 text-sm font-bold text-ink-dim">{title}</div>
      <p className="mx-auto mt-1.5 max-w-md text-[11px] leading-5 text-ink-faint">{body}</p>
    </div>
  );
}

function StockListPanel({
  icon, title, rows, empty, highlight,
}: {
  icon: React.ReactNode;
  title: string;
  rows: Stage1Metrics[];
  empty: string;
  highlight: "score" | "rs";
}) {
  return (
    <section className="panel p-3.5">
      <SectionTitle icon={icon} title={title} count={rows.length} />
      <div className="mt-2.5 space-y-1">
        {rows.length === 0 && <div className="py-4 text-center text-[11px] text-ink-faint">{empty}</div>}
        {rows.slice(0, 8).map((m) => (
          <Link key={m.symbol} href={`/stock/${m.symbol}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 table-row-hover transition">
            <span className="num text-xs font-bold w-24 truncate">{m.symbol}</span>
            <DirBadge dir={m.direction} />
            <span className={`num text-[11px] ml-auto ${highlight === "score" ? (m.momentumScore >= 75 ? "text-profit" : m.momentumScore >= 60 ? "text-warn" : "text-loss") : pcol(m.rsNiftyPct)}`}>
              {highlight === "score" ? m.momentumScore : fpct(m.rsNiftyPct)}
            </span>
            <span className="num text-[10px] text-ink-faint w-12 text-right">{fx(m.rvol)}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function TablePanel({
  icon, title, rows, metric, invert,
}: {
  icon: React.ReactNode;
  title: string;
  rows: Stage1Metrics[];
  metric: "rs" | "rvol";
  invert?: boolean;
}) {
  return (
    <section className="panel p-3.5 overflow-hidden">
      <SectionTitle icon={icon} title={title} count={rows.length} />
      <table className="mt-2 w-full text-[11px]">
        <thead>
          <tr className="text-[9px] tracking-widest text-ink-faint border-b border-line">
            <th className="text-left py-1.5 font-semibold">SYMBOL</th>
            <th className="text-right font-semibold">DIR</th>
            <th className="text-right font-semibold">{metric === "rs" ? "RS %" : "RVOL"}</th>
            <th className="text-right font-semibold">CHG %</th>
            <th className="text-right font-semibold">SCORE</th>
            <th className="text-right font-semibold">5M</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.symbol} className="border-b border-line/40 table-row-hover">
              <td className="py-1.5">
                <Link href={`/stock/${m.symbol}`} className="num font-bold hover:text-info">{m.symbol}</Link>
              </td>
              <td className="text-right"><DirBadge dir={m.direction} /></td>
              <td className={`text-right num font-bold ${metric === "rs" ? pcol(m.rsNiftyPct, invert) : "text-info"}`}>
                {metric === "rs" ? fpct(m.rsNiftyPct) : fx(m.rvol)}
              </td>
              <td className={`text-right num ${pcol(m.returnDayPct)}`}>{fpct(m.returnDayPct)}</td>
              <td className="text-right num text-ink-dim">{m.momentumScore}</td>
              <td className="text-right"><TrendBadge trend={m.trend5m} /></td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={6} className="py-6 text-center text-ink-faint">No data yet — engine warming up</td></tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

/* ------------------------- STAGE-1 tape (sortable) ------------------------ */

type TapeSortKey =
  | "symbol" | "ltp" | "returnDayPct" | "return5mPct" | "return15mPct" | "priceAccel"
  | "rvol" | "turnoverCr" | "rsNiftyPct" | "rsAccelPct" | "aboveVwap" | "trend5m"
  | "futures" | "momentumScore" | "momentumState" | "dataStatus";

const TREND_RANK: Record<string, number> = { BULLISH: 3, NEUTRAL: 2, BEARISH: 1, INSUFFICIENT_DATA: 0 };
const FUT_RANK: Record<string, number> = { LONG_BUILDUP: 5, SHORT_COVERING: 4, NEUTRAL: 3, LONG_UNWINDING: 2, SHORT_BUILDUP: 1, UNAVAILABLE: 0 };
const STATE_RANK: Record<string, number> = { CONFIRMED_MOMENTUM: 2, EARLY_MOMENTUM: 1, IDLE: 0 };
const STATUS_RANK: Record<string, number> = { LIVE: 4, RECENT: 3, PARTIAL: 2, STALE: 1, UNAVAILABLE: 0 };

const TAPE_COLUMNS: { key: TapeSortKey; label: string; get: (m: Stage1Metrics) => number | string | null }[] = [
  { key: "symbol", label: "SYMBOL", get: (m) => m.symbol },
  { key: "ltp", label: "LTP", get: (m) => m.ltp },
  { key: "returnDayPct", label: "CHG%", get: (m) => m.returnDayPct },
  { key: "return5mPct", label: "5M%", get: (m) => m.return5mPct },
  { key: "return15mPct", label: "15M%", get: (m) => m.return15mPct },
  { key: "priceAccel", label: "ACCEL", get: (m) => m.priceAccel },
  { key: "rvol", label: "RVOL", get: (m) => m.rvol },
  { key: "turnoverCr", label: "LIQ ₹CR", get: (m) => m.turnoverCr },
  { key: "rsNiftyPct", label: "RS NIFTY", get: (m) => m.rsNiftyPct },
  { key: "rsAccelPct", label: "RS ACCEL", get: (m) => m.rsAccelPct },
  { key: "aboveVwap", label: "VWAP", get: (m) => (m.aboveVwap == null ? null : m.aboveVwap ? 1 : 0) },
  { key: "trend5m", label: "5M TREND", get: (m) => TREND_RANK[m.trend5m] ?? 0 },
  { key: "futures", label: "FUTURES", get: (m) => FUT_RANK[m.futures.signal] ?? 0 },
  { key: "momentumScore", label: "SCORE", get: (m) => m.momentumScore },
  { key: "momentumState", label: "STATE", get: (m) => STATE_RANK[m.momentumState] ?? 0 },
  { key: "dataStatus", label: "STATUS", get: (m) => STATUS_RANK[m.dataStatus] ?? 0 },
];

function CandidateTape({ rows }: { rows: Stage1Metrics[] }) {
  const [sort, setSort] = useState<{ key: TapeSortKey; dir: "asc" | "desc" }>({ key: "momentumScore", dir: "desc" });

  const toggleSort = (key: TapeSortKey) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));
  };

  // N/A values always sink to the bottom regardless of direction, so missing
  // data never masquerades as a top-ranked row.
  const sorted = useMemo(() => {
    const col = TAPE_COLUMNS.find((c) => c.key === sort.key);
    if (!col) return rows;
    return [...rows].sort((a, b) => {
      const va = col.get(a);
      const vb = col.get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [rows, sort]);

  return (
    <section className="panel p-2.5 sm:p-3.5">
      <SectionTitle icon={<Zap className="h-4 w-4" />} title="STAGE-1 CANDIDATE TAPE" count={rows.length} hint="fast metrics · click headers to sort" />
      <DataTable minWidthClass="min-w-[980px]">
      <table className={`${dtTableClass("min-w-[980px]")} tape-table`}>
        <thead>
          <tr className="text-[9px] tracking-widest text-ink-faint border-b border-line">
            {TAPE_COLUMNS.map((c) => {
              const active = sort.key === c.key;
              return (
                <th key={c.key} className="text-right first:text-left py-1.5 font-semibold whitespace-nowrap px-1.5">
                  <button
                    onClick={() => toggleSort(c.key)}
                    className={`inline-flex items-center gap-0.5 transition ${active ? "text-info" : "hover:text-ink-dim"}`}
                    title={`Sort by ${c.label}`}
                  >
                    {c.label}
                    {active ? (
                      sort.dir === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronDown className="h-3 w-3 opacity-0 group-hover:opacity-40" />
                    )}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((m) => (
            <tr key={m.symbol} className="border-b border-line/40 table-row-hover">
              <td className="py-1.5 px-1.5">
                <Link href={`/stock/${m.symbol}`} className="num font-bold hover:text-info">{m.symbol}</Link>
              </td>
              <td className="text-right num px-1.5">{fnum(m.ltp)}</td>
              <td className={`text-right num px-1.5 ${pcol(m.returnDayPct)}`}>{fpct(m.returnDayPct)}</td>
              <td className={`text-right num px-1.5 ${pcol(m.return5mPct)}`}>{fpct(m.return5mPct)}</td>
              <td className={`text-right num px-1.5 ${pcol(m.return15mPct)}`}>{fpct(m.return15mPct)}</td>
              <td className={`text-right num px-1.5 ${pcol(m.priceAccel)}`}>{fpct(m.priceAccel)}</td>
              <td className={`text-right num px-1.5 ${m.rvol != null && m.rvol >= 1.5 ? "text-info font-bold" : "text-ink-dim"}`}>{fx(m.rvol)}</td>
              <td
                className={`text-right num px-1.5 font-semibold ${
                  m.liquidityPass === true ? "text-profit" : m.liquidityPass === false ? "text-loss" : "text-ink-faint"
                }`}
                title={
                  m.turnoverCr != null
                    ? `Traded value ₹${m.turnoverCr.toFixed(1)} Cr (day volume × VWAP)`
                    : "Turnover unavailable"
                }
              >
                {fcr(m.turnoverCr)}
              </td>
              <td className={`text-right num px-1.5 ${pcol(m.rsNiftyPct)}`}>{fpct(m.rsNiftyPct)}</td>
              <td className={`text-right num px-1.5 ${pcol(m.rsAccelPct)}`}>{fpct(m.rsAccelPct)}</td>
              <td className="text-right px-1.5">
                {m.aboveVwap == null ? <span className="text-ink-faint num">N/A</span> : (
                  <span className={`chip ${m.aboveVwap ? "text-profit border-profit/30 bg-profit/10" : "text-loss border-loss/30 bg-loss/10"}`}>{m.aboveVwap ? "ABOVE" : "BELOW"}</span>
                )}
              </td>
              <td className="text-right px-1.5"><TrendBadge trend={m.trend5m} /></td>
              <td className="text-right px-1.5"><FuturesBadge signal={m.futures.signal} /></td>
              <td className={`text-right num font-bold px-1.5 ${m.momentumScore >= 75 ? "text-profit" : m.momentumScore >= 60 ? "text-warn" : "text-loss"}`}>{m.momentumScore}</td>
              <td className="text-right px-1.5">
                <span className={`chip ${m.momentumState === "CONFIRMED_MOMENTUM" ? "text-profit border-profit/40 bg-profit/10" : m.momentumState === "EARLY_MOMENTUM" ? "text-warn border-warn/40 bg-warn/10" : "text-ink-faint border-line"}`}>
                  {m.momentumState === "CONFIRMED_MOMENTUM" ? "CONFIRMED" : m.momentumState === "EARLY_MOMENTUM" ? "EARLY" : "—"}
                </span>
              </td>
              <td className="text-right px-1.5"><DataStatusDot status={m.dataStatus} /></td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={16} className="py-8 text-center text-ink-faint">Engine is collecting quotes & candles across the F&O universe…</td></tr>
          )}
        </tbody>
      </table>
      </DataTable>
    </section>
  );
}

/* ============================ not connected ============================== */

function NotConnected({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="panel mx-auto max-w-2xl p-8 text-center rise-in">
      <div className="mx-auto h-14 w-14 rounded-2xl bg-gradient-to-br from-info/25 to-violet-glow/15 border border-info/30 flex items-center justify-center">
        <PlugZap className="h-7 w-7 text-info" />
      </div>
      <h1 className="mt-4 text-xl font-black tracking-wide">CONNECT UPSTOX TO ARM THE ENGINE</h1>
      <p className="mx-auto mt-2 max-w-lg text-xs leading-6 text-ink-dim">
        This terminal scans the <span className="text-ink font-semibold">entire live NSE F&O universe</span> in two stages —
        fast market-wide momentum filtering, then deep structural + option-chain analysis on the winners —
        using <span className="text-ink font-semibold">your Upstox API token as the only market data source</span>.
      </p>
      <button
        onClick={onConnect}
        className="mt-5 rounded-lg bg-info/90 px-6 py-3 text-sm font-bold text-terminal hover:bg-info transition"
      >
        Connect with Upstox token
      </button>
      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-2 text-left text-[10px] text-ink-faint">
        {[
          ["Stage 1", "RVOL · RS vs NIFTY · RS acceleration · VWAP · 5m trend · futures OI across 200+ stocks"],
          ["Stage 2", "Dynamic S/R · option-chain OI · volume levels · breakout/retest · R:R-qualified setups"],
          ["Integrity", "Zero synthetic data. Missing fields show N/A / INSUFFICIENT DATA — never estimates"],
          ["Security", "Token stored server-side only, never logged, never sent to the browser"],
        ].map(([t, d]) => (
          <div key={t} className="rounded-lg border border-line bg-panel-2 p-3">
            <div className="font-bold text-info tracking-widest text-[9px]">{t.toUpperCase()}</div>
            <div className="mt-1 leading-4.5 leading-[18px]">{d}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
