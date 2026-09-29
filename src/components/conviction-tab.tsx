"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ChevronDown, Crosshair, Flame, ShieldCheck, TrendingDown, TrendingUp, Target, AlertTriangle,
} from "lucide-react";
import type { ConvictionResult } from "@/lib/engine/conviction";
import { fetchJson, describeFetchError } from "@/lib/fetch-json";
import { DataStatusDot, Meter, ScoreRing, SectionTitle, fnum, fpct, fx, pcol } from "./ui";

interface Payload {
  computedAt: string;
  marketPhase: string;
  engineRunning: boolean;
  evaluated: number;
  minScore: number;
  longs: ConvictionResult[];
  shorts: ConvictionResult[];
  stats: { rankable: number; conflicted: number; stale: number; coverageAvg: number };
}

export function ConvictionTab() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchJson<Payload>("/api/conviction"));
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
          <SectionTitle icon={<Flame className="h-4 w-4" />} title="INTRADAY MOMENTUM CONVICTION" />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-ink-dim num">
            <span>evaluated {data?.evaluated ?? 0}</span>
            <span>rankable {data?.stats.rankable ?? 0}</span>
            <span>conflicted {data?.stats.conflicted ?? 0}</span>
            <span>avg coverage {data?.stats.coverageAvg ?? 0}%</span>
            {error && <span className="text-warn/80">reconnecting…</span>}
            <span className="text-ink-faint">gate ≥ {data?.minScore ?? 62} · updated {t(data?.computedAt)}</span>
          </div>
        </div>
        <p className="mt-2 text-[10px] leading-4 text-ink-faint">
          Fuses <span className="text-ink font-semibold">price action, order positioning, volume/RVOL, option-chain OI,
          futures positioning, relative strength and S/R location</span> into one conviction score per side. Contradicting
          evidence caps the score (CONFLICTED) and stale symbols are never ranked. Fewer than five results means fewer
          qualified — nothing is forced.
        </p>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-5">
        <Column
          side="LONG"
          rows={data?.longs ?? []}
          hint={hint("LONG", data)}
        />
        <Column
          side="SHORT"
          rows={data?.shorts ?? []}
          hint={hint("SHORT", data)}
        />
      </div>

      <section className="panel p-3 sm:p-4 text-[10px] text-ink-dim">
        <div className="flex items-start gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-profit shrink-0 mt-px" />
          <p>
            Conviction reflects <span className="text-ink font-semibold">measured market pressure and participation</span>,
            not participant identity or a guaranteed outcome. All inputs are live Upstox values; unavailable inputs show
            N/A and are excluded from the score rather than estimated.
          </p>
        </div>
      </section>
    </div>
  );
}

function hint(side: string, data: Payload | null): string {
  if (!data) return "Loading conviction data…";
  if (!data.engineRunning) return "Engine is not running — connect Upstox.";
  return `No ${side} candidate clears the ${data.minScore} conviction gate with fresh, non-conflicting evidence right now.`;
}

function Column({ side, rows, hint }: { side: "LONG" | "SHORT"; rows: ConvictionResult[]; hint: string }) {
  const isLong = side === "LONG";
  return (
    <section className="panel p-3 sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <SectionTitle
          icon={isLong ? <TrendingUp className="h-4 w-4 text-profit" /> : <TrendingDown className="h-4 w-4 text-loss" />}
          title={isLong ? "TOP LONG — BUYING MOMENTUM" : "TOP SHORT — SELLING MOMENTUM"}
          count={rows.length}
        />
      </div>
      <div className="mt-3 space-y-2">
        {rows.length === 0 && <div className="py-6 px-3 text-center text-[11px] leading-5 text-ink-faint">{hint}</div>}
        {rows.map((r, i) => <Card key={r.symbol} row={r} rank={i + 1} isLong={isLong} />)}
      </div>
    </section>
  );
}

function Card({ row, rank, isLong }: { row: ConvictionResult; rank: number; isLong: boolean }) {
  const [open, setOpen] = useState(false);
  const score = isLong ? row.longScore : row.shortScore;
  const factors = isLong ? row.longFactors : row.shortFactors;
  const tone = isLong ? "text-profit" : "text-loss";

  return (
    <div className={`rounded-lg border bg-panel-2 overflow-hidden ${score >= 75 ? (isLong ? "border-profit/35" : "border-loss/35") : "border-line"}`}>
      <button onClick={() => setOpen((v) => !v)} className="w-full px-3 py-2.5 flex items-center gap-2.5 text-left table-row-hover">
        <span className="num text-ink-faint text-xs w-4">{rank}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Link href={`/stock/${row.symbol}`} onClick={(e) => e.stopPropagation()} className="num font-bold text-sm hover:text-info transition">
              {row.symbol}
            </Link>
            <span className={`chip ${isLong ? "text-profit border-profit/40 bg-profit/10" : "text-loss border-loss/40 bg-loss/10"}`}>{row.grade}</span>
            <span className={`chip ${row.conviction === "STRONG" ? "text-info border-info/40 bg-info/10" : row.conviction === "CONFLICTED" ? "text-warn border-warn/40 bg-warn/10" : "text-ink-dim border-line"}`}>
              {row.conviction}
            </span>
            <span className={`chip ${row.confidence === "HIGH" ? "text-profit border-profit/40 bg-profit/10" : row.confidence === "MEDIUM" ? "text-warn border-warn/40 bg-warn/10" : "text-ink-faint border-line"}`}>
              {row.confidence}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2.5 flex-wrap text-[10px] num text-ink-dim">
            <span className="text-ink font-semibold">₹{fnum(row.ltp)}</span>
            <span className={pcol(row.changePct)}>{fpct(row.changePct)}</span>
            <span>RVOL {fx(row.rvol)}</span>
            {row.turnoverCr != null && <span>₹{row.turnoverCr.toFixed(0)} Cr</span>}
            <DataStatusDot status={row.dataStatus} />
          </div>
          <div className="mt-1.5"><Meter value={score} tone={isLong ? "green" : "red"} /></div>
        </div>
        <div className="flex flex-col items-center shrink-0">
          <ScoreRing score={score} size={50} />
          <span className="text-[8px] text-ink-faint tracking-widest mt-0.5">{isLong ? "LONG" : "SHORT"}</span>
        </div>
        <ChevronDown className={`h-3.5 w-3.5 text-ink-faint transition-transform shrink-0 ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="border-t border-line px-3 py-3 space-y-2.5 text-[11px] rise-in">
          <p className={`font-semibold ${tone}`}>{row.headline}</p>

          <div className="space-y-1.5">
            {factors.map((f) => (
              <div key={f.key} className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="w-32 shrink-0 text-[10px] text-ink-dim">
                    {f.label} <span className="text-ink-faint">{f.weight}%</span>
                  </span>
                  <div className="flex-1"><Meter value={f.value ?? 0} tone={f.value == null ? "cyan" : f.value >= 60 ? (isLong ? "green" : "red") : f.value <= 35 ? "amber" : "cyan"} /></div>
                  <span className={`num w-8 text-right font-bold ${f.value == null ? "text-ink-faint" : tone}`}>{f.value == null ? "—" : f.value}</span>
                </div>
                <div className="pl-32 text-[9px] text-ink-faint num">{f.evidence}</div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 border-t border-line/50 pt-2 text-[10px]">
            <Mini label="Order flow" value={row.flowBias} />
            <Mini label="Options" value={row.optionBias} />
            <Mini label="Futures" value={row.futuresBias} />
            <Mini label="Location" value={row.locationNote} />
          </div>

          {row.drivers.length > 0 && (
            <div>
              <div className="text-[9px] tracking-widest text-profit font-bold mb-0.5">WHAT DRIVES IT</div>
              {row.drivers.map((d, i) => <div key={i} className="text-ink-dim">▸ {d}</div>)}
            </div>
          )}
          {row.risks.length > 0 && (
            <div className="rounded-lg border border-warn/25 bg-warn/5 px-2.5 py-2">
              <div className="text-[9px] tracking-widest text-warn font-bold mb-0.5 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> WHAT COULD INVALIDATE IT
              </div>
              {row.risks.map((r, i) => <div key={i} className="text-warn/90">• {r}</div>)}
            </div>
          )}
          <div className="text-[9px] text-ink-faint num">
            aligned {row.agreeCount} · conflicts {row.conflictCount} · coverage {row.coveragePct}% · opposite side {isLong ? row.shortScore : row.longScore}
          </div>
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
