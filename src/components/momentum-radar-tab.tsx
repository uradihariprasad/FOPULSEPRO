"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ChevronDown, Eye, Radar, ShieldCheck, TrendingDown, TrendingUp, AlertTriangle, Flame, Hourglass,
} from "lucide-react";
import type { MomentumRadarResult, MomentumPhase } from "@/lib/engine/momentum-radar";
import { DataStatusDot, Meter, ScoreRing, SectionTitle, fnum, fpct, fx, pcol } from "./ui";
import { fetchJson, describeFetchError } from "@/lib/fetch-json";

interface Payload {
  computedAt: string;
  marketPhase: string;
  engineRunning: boolean;
  evaluated: number;
  minScore: number;
  buys: MomentumRadarResult[];
  sells: MomentumRadarResult[];
  watchlist: MomentumRadarResult[];
  stats: { rankable: number; explosive: number; exhaustion: number; stale: number };
}

const PHASE_STYLE: Record<MomentumPhase, string> = {
  IGNITION: "text-info border-info/45 bg-info/10",
  ACCELERATION: "text-profit border-profit/50 bg-profit/15",
  CONTINUATION: "text-profit/85 border-profit/30 bg-profit/5",
  PULLBACK: "text-warn border-warn/40 bg-warn/10",
  STALLING: "text-warn border-warn/40 bg-warn/10",
  EXHAUSTION: "text-loss border-loss/50 bg-loss/15",
  REVERSAL: "text-loss border-loss/50 bg-loss/15",
  FADING: "text-ink-dim border-line bg-panel",
};

export function MomentumRadarTab() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchJson<Payload>("/api/momentum-radar"));
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
          <SectionTitle icon={<Radar className="h-4 w-4" />} title="MOMENTUM RADAR" />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-ink-dim num">
            <span>scanned {data?.evaluated ?? 0}</span>
            <span>active {data?.stats.rankable ?? 0}</span>
            <span className="text-profit">explosive {data?.stats.explosive ?? 0}</span>
            <span className="text-loss">exhaustion/reversal {data?.stats.exhaustion ?? 0}</span>
            {error && <span className="text-warn/80">reconnecting…</span>}
            <span className="text-ink-faint">gate ≥ {data?.minScore ?? 55} · updated {t(data?.computedAt)}</span>
          </div>
        </div>
        <p className="mt-2 text-[10px] leading-4 text-ink-faint">
          Detects stocks moving <span className="text-ink font-semibold">right now</span> — sudden price velocity &amp;
          acceleration, price shock vs the day&apos;s typical range, last-bar volume surge, RVOL change, futures OI build
          and range expansion — then classifies the phase: ignition, acceleration, continuation, pullback, stalling,
          exhaustion, reversal or fading.
        </p>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-5">
        <Column side="BUY" rows={data?.buys ?? []} hint={hint("BUY", data)} />
        <Column side="SELL" rows={data?.sells ?? []} hint={hint("SELL", data)} />
      </div>

      <WatchList rows={data?.watchlist ?? []} running={data?.engineRunning ?? false} />

      <section className="panel p-3 sm:p-4 text-[10px] text-ink-dim">
        <div className="flex items-start gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-profit shrink-0 mt-px" />
          <p>
            Phase context describes <span className="text-ink font-semibold">what the move is doing now</span>, not a trade
            call — EXHAUSTION and REVERSAL flag deteriorating momentum and are score-capped. All values are live Upstox
            figures; missing inputs show N/A and are excluded from scoring.
          </p>
        </div>
      </section>
    </div>
  );
}

function hint(side: string, d: Payload | null): string {
  if (!d) return "Scanning for momentum bursts…";
  if (!d.engineRunning) return "Engine is not running — connect Upstox.";
  return `No ${side} stock currently clears the ${d.minScore} burst threshold with fresh data.`;
}

function Column({ side, rows, hint }: { side: "BUY" | "SELL"; rows: MomentumRadarResult[]; hint: string }) {
  const isBuy = side === "BUY";
  return (
    <section className="panel p-3 sm:p-4">
      <SectionTitle
        icon={isBuy ? <TrendingUp className="h-4 w-4 text-profit" /> : <TrendingDown className="h-4 w-4 text-loss" />}
        title={isBuy ? "TOP BUY MOMENTUM" : "TOP SELL MOMENTUM"}
        count={rows.length}
      />
      <div className="mt-3 space-y-2">
        {rows.length === 0 && <div className="py-6 px-3 text-center text-[11px] leading-5 text-ink-faint">{hint}</div>}
        {rows.map((r, i) => <Card key={r.symbol} row={r} rank={i + 1} isBuy={isBuy} />)}
      </div>
    </section>
  );
}

function Card({ row, rank, isBuy }: { row: MomentumRadarResult; rank: number; isBuy: boolean }) {
  const [open, setOpen] = useState(false);
  const tone = isBuy ? "text-profit" : "text-loss";

  return (
    <div className={`rounded-lg border bg-panel-2 overflow-hidden ${row.grade === "EXPLOSIVE" ? (isBuy ? "border-profit/40" : "border-loss/40") : "border-line"}`}>
      <button onClick={() => setOpen((v) => !v)} className="w-full px-3 py-2.5 flex items-center gap-2.5 text-left table-row-hover">
        <span className="num text-ink-faint text-xs w-4">{rank}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Link href={`/stock/${row.symbol}`} onClick={(e) => e.stopPropagation()} className="num font-bold text-sm hover:text-info transition">
              {row.symbol}
            </Link>
            <span className={`chip ${PHASE_STYLE[row.phase]}`}>{row.phaseLabel}</span>
            {row.grade === "EXPLOSIVE" && <Flame className="h-3.5 w-3.5 text-warn" />}
            <span className={`chip ${row.confidence === "HIGH" ? "text-profit border-profit/40 bg-profit/10" : row.confidence === "MEDIUM" ? "text-warn border-warn/40 bg-warn/10" : "text-ink-faint border-line"}`}>
              {row.confidence}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2.5 flex-wrap text-[10px] num text-ink-dim">
            <span className="text-ink font-semibold">₹{fnum(row.ltp)}</span>
            <span className={pcol(row.changePct)}>{fpct(row.changePct)}</span>
            <span className={pcol(row.velocity5mPct)}>5m {fpct(row.velocity5mPct)}</span>
            <span>vol {row.volumeSurge != null ? `${row.volumeSurge.toFixed(2)}×` : "N/A"}</span>
            <span>RVOL {fx(row.rvol)}</span>
            {row.oiChangePct != null && <span>ΔOI {row.oiChangePct >= 0 ? "+" : ""}{row.oiChangePct.toFixed(1)}%</span>}
            <DataStatusDot status={row.dataStatus} />
          </div>
          <div className="mt-1.5"><Meter value={row.score} tone={isBuy ? "green" : "red"} /></div>
        </div>
        <div className="flex flex-col items-center shrink-0">
          <ScoreRing score={row.score} size={50} />
          <span className="text-[8px] text-ink-faint tracking-widest mt-0.5">BURST</span>
        </div>
        <ChevronDown className={`h-3.5 w-3.5 text-ink-faint transition-transform shrink-0 ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="border-t border-line px-3 py-3 space-y-2.5 text-[11px] rise-in">
          <p className={`font-semibold ${tone}`}>{row.headline}</p>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px]">
            <Mini label="1m / 3m" value={`${fpct(row.velocity1mPct)} / ${fpct(row.velocity3mPct)}`} />
            <Mini label="5m / 15m" value={`${fpct(row.velocity5mPct)} / ${fpct(row.velocity15mPct)}`} />
            <Mini label="Acceleration" value={fpct(row.accelerationPct)} />
            <Mini label="Price shock" value={row.priceShock != null ? `${row.priceShock.toFixed(1)}× rng` : "N/A"} />
            <Mini label="Vol surge" value={row.volumeSurge != null ? `${row.volumeSurge.toFixed(2)}×` : "N/A"} />
            <Mini label="RVOL Δ5m" value={row.rvolChange != null ? `${row.rvolChange >= 0 ? "+" : ""}${row.rvolChange.toFixed(2)}` : "N/A"} />
            <Mini label="Follow-through" value={row.followThrough != null ? `${Math.round(row.followThrough * 100)}%` : "N/A"} />
            <Mini label="Turnover" value={row.turnoverCr != null ? `₹${row.turnoverCr.toFixed(0)} Cr` : "N/A"} />
          </div>

          <div className="space-y-1.5">
            {row.signals.map((s) => (
              <div key={s.key} className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="w-28 shrink-0 text-[10px] text-ink-dim">{s.label} <span className="text-ink-faint">{s.weight}%</span></span>
                  <div className="flex-1"><Meter value={s.value ?? 0} tone={s.value == null ? "cyan" : s.value >= 60 ? (isBuy ? "green" : "red") : "cyan"} /></div>
                  <span className={`num w-8 text-right font-bold ${s.value == null ? "text-ink-faint" : tone}`}>{s.value == null ? "—" : s.value}</span>
                </div>
                <div className="pl-28 text-[9px] text-ink-faint num">{s.evidence}</div>
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-line bg-panel px-2.5 py-2 text-[10px]">
            <span className="text-[9px] tracking-widest text-info font-bold">PHASE · {row.phaseLabel.toUpperCase()}</span>
            <div className="text-ink-dim mt-0.5">{row.phaseNote}</div>
            <div className="text-ink-faint mt-0.5">Futures: {row.oiInterpretation}</div>
          </div>

          {row.drivers.length > 0 && (
            <div>
              <div className="text-[9px] tracking-widest text-profit font-bold mb-0.5">WHAT IS DRIVING IT</div>
              {row.drivers.map((d, i) => <div key={i} className="text-ink-dim">▸ {d}</div>)}
            </div>
          )}
          {row.warnings.length > 0 && (
            <div className="rounded-lg border border-warn/25 bg-warn/5 px-2.5 py-2">
              <div className="text-[9px] tracking-widest text-warn font-bold mb-0.5 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> CAUTION
              </div>
              {row.warnings.map((w, i) => <div key={i} className="text-warn/90">• {w}</div>)}
            </div>
          )}
          <div className="text-[9px] text-ink-faint num">coverage {row.coveragePct}% · grade {row.grade}</div>
        </div>
      )}
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-panel px-2 py-1.5">
      <div className="text-[8px] tracking-widest text-ink-faint">{label.toUpperCase()}</div>
      <div className="num text-[10px] text-ink truncate" title={value}>{value}</div>
    </div>
  );
}


/* ---------------------- pre-burst watchlist (bottom) ---------------------- */

function WatchList({ rows, running }: { rows: MomentumRadarResult[]; running: boolean }) {
  const [openSym, setOpenSym] = useState<string | null>(null);
  return (
    <section className="panel p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <SectionTitle icon={<Eye className="h-4 w-4" />} title="WATCHLIST — BREAKOUT / BREAKDOWN SETUP" count={rows.length} />
        <span className="text-[10px] text-ink-faint">
          compressed &amp; quiet — ready to break, not already moving
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="py-6 text-center text-[11px] leading-5 text-ink-faint">
          {running
            ? "No stock is currently compressed and coiled at a breakout/breakdown level with building participation."
            : "Engine is not running — connect Upstox."}
        </div>
      ) : (
        <div className="mt-3 space-y-1.5">
          {rows.map((r, i) => {
            const isBuy = r.readinessSide === "BUY";
            const open = openSym === r.symbol;
            return (
              <div key={r.symbol} className="rounded-lg border border-line bg-panel-2 overflow-hidden">
                <button
                  onClick={() => setOpenSym(open ? null : r.symbol)}
                  className="w-full px-2.5 sm:px-3 py-2 flex items-center gap-2 sm:gap-3 text-left table-row-hover"
                >
                  <span className="num text-ink-faint text-xs w-4">{i + 1}</span>
                  <Link
                    href={`/stock/${r.symbol}`}
                    onClick={(e) => e.stopPropagation()}
                    className="num font-bold text-sm w-24 sm:w-28 shrink-0 truncate hover:text-info transition"
                  >
                    {r.symbol}
                  </Link>
                  <span className={`chip shrink-0 ${isBuy ? "text-profit border-profit/40 bg-profit/10" : "text-loss border-loss/40 bg-loss/10"}`}>
                    {isBuy ? "BREAKOUT SETUP" : "BREAKDOWN SETUP"}
                  </span>
                  <span className="hidden md:inline-flex items-center gap-1 text-[10px] text-ink-dim num shrink-0">
                    <Hourglass className="h-3 w-3" />
                    coil {r.coilRatio != null ? `${Math.round(r.coilRatio * 100)}%` : "N/A"}
                  </span>
                  {r.compressed && r.quietNow && (
                    <span className="chip text-info border-info/30 bg-info/10 shrink-0">COILED</span>
                  )}
                  <span className="hidden lg:inline text-[10px] text-ink-dim num shrink-0">RVOL {fx(r.rvol)}</span>
                  <span className="hidden xl:inline text-[10px] text-ink-faint num truncate flex-1">{r.triggerNote}</span>
                  <div className="ml-auto flex items-center gap-2 shrink-0">
                    <div className="w-16 sm:w-24"><Meter value={r.readiness} tone={isBuy ? "green" : "red"} /></div>
                    <span className={`num text-sm font-black ${isBuy ? "text-profit" : "text-loss"}`}>{r.readiness}</span>
                    <DataStatusDot status={r.dataStatus} />
                    <ChevronDown className={`h-3.5 w-3.5 text-ink-faint transition-transform ${open ? "rotate-180" : ""}`} />
                  </div>
                </button>

                {open && (
                  <div className="border-t border-line px-3 py-2.5 space-y-2 text-[11px] rise-in">
                    <div className="rounded-md border border-info/25 bg-info/5 px-2.5 py-1.5">
                      <span className="text-[9px] tracking-widest text-info font-bold">TRIGGER — </span>
                      <span className="text-ink-dim">{r.triggerNote}</span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px]">
                      <Mini label="Price" value={`₹${fnum(r.ltp)}`} />
                      <Mini label="Day chg" value={fpct(r.changePct)} />
                      <Mini label="Range pos" value={r.rangePosition != null ? `${Math.round(r.rangePosition * 100)}%` : "N/A"} />
                      <Mini label="Burst score" value={`${r.score} (pre-trigger)`} />
                      <Mini label="Coil" value={r.coilRatio != null ? `${Math.round(r.coilRatio * 100)}%` : "N/A"} />
                      <Mini label="5m velocity" value={r.velocity5mPctQuiet != null ? `${r.velocity5mPctQuiet >= 0 ? "+" : ""}${r.velocity5mPctQuiet.toFixed(2)}%` : "N/A"} />
                    </div>
                    <div className="space-y-1.5">
                      {r.readinessFactors.map((f) => (
                        <div key={f.key} className="space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span className="w-28 shrink-0 text-[10px] text-ink-dim">
                              {f.label} <span className="text-ink-faint">{f.weight}%</span>
                            </span>
                            <div className="flex-1">
                              <Meter value={f.value ?? 0} tone={f.value == null ? "cyan" : f.value >= 60 ? (isBuy ? "green" : "red") : "cyan"} />
                            </div>
                            <span className={`num w-8 text-right font-bold ${f.value == null ? "text-ink-faint" : isBuy ? "text-profit" : "text-loss"}`}>
                              {f.value == null ? "—" : f.value}
                            </span>
                          </div>
                          <div className="pl-28 text-[9px] text-ink-faint num">{f.evidence}</div>
                        </div>
                      ))}
                    </div>
                    <div className="rounded-md border border-line bg-panel px-2.5 py-1.5 text-[9px] text-ink-faint">
                      Entry requires the range to actually break with volume — a stock is only listed here while it stays
                      compressed (coil ≤ 85% of prior range) and quiet (|5m| ≤ 0.45%, |15m| ≤ 0.90%). It moves into the
                      momentum lists above the moment velocity and volume fire.
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
