"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, ChevronDown, RefreshCcw, ShieldCheck, TrendingDown, TrendingUp,
} from "lucide-react";
import type { ReversalResult, ScoreLine } from "@/lib/engine/reversal";
import { DataStatusDot, Meter, SectionTitle, fnum, fpct, pcol } from "./ui";
import { DataTable, dtTableClass } from "./data-table";
import { fetchJson, describeFetchError } from "@/lib/fetch-json";

interface Payload {
  computedAt: string;
  marketPhase: string;
  engineRunning: boolean;
  evaluated: number;
  stretched: number;
  overboughtReversal: ReversalResult[];
  oversoldReversal: ReversalResult[];
  overboughtContinuation: ReversalResult[];
  oversoldContinuation: ReversalResult[];
  stats: { reversalWatch: number; continuationRisk: number; insufficient: number; highConfidence: number };
}

export function ReversalRadarTab() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchJson<Payload>("/api/reversal-radar"));
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
          <SectionTitle icon={<RefreshCcw className="h-4 w-4" />} title="REVERSAL RADAR" />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-ink-dim num">
            <span>scanned {data?.evaluated ?? 0}</span>
            <span>stretched {data?.stretched ?? 0}</span>
            <span className="text-info">reversal watch {data?.stats.reversalWatch ?? 0}</span>
            <span className="text-warn">continuation risk {data?.stats.continuationRisk ?? 0}</span>
            <span className="text-profit">high confidence {data?.stats.highConfidence ?? 0}</span>
            {error && <span className="text-warn/80">reconnecting…</span>}
            <span className="text-ink-faint">updated {t(data?.computedAt)}</span>
          </div>
        </div>
        <p className="mt-2 text-[10px] leading-4 text-ink-faint">
          Overbought/oversold <span className="text-ink font-semibold">alone never triggers a reversal</span>. A stock must
          first clear a multi-factor extension test (RSI · VWAP/ATR · Bollinger · EMA extension · day return · volume ·
          range), then reversal evidence — exhaustion &amp; divergence, price-action rejection, volume non-confirmation,
          OI unwinding, option/S-R confluence — is scored <span className="text-ink font-semibold">independently against
          continuation evidence</span>. Names are staged <span className="text-violet-glow font-semibold">EARLY REVERSAL</span>
          the moment reversal evidence edges ahead, and promoted to <span className="text-info font-semibold">CONFIRMED</span>
          when it becomes decisive.
        </p>
      </section>

      <Group
        title="OVERBOUGHT — REVERSAL WATCH"
        icon={<TrendingDown className="h-4 w-4 text-loss" />}
        rows={data?.overboughtReversal ?? []}
        empty={emptyMsg(data, "No overbought stock shows reversal evidence dominating continuation.")}
        tone="loss"
      />
      <Group
        title="OVERSOLD — REVERSAL WATCH"
        icon={<TrendingUp className="h-4 w-4 text-profit" />}
        rows={data?.oversoldReversal ?? []}
        empty={emptyMsg(data, "No oversold stock shows reversal evidence dominating continuation.")}
        tone="profit"
      />
      <Group
        title="OVERBOUGHT — CONTINUATION RISK"
        icon={<AlertTriangle className="h-4 w-4 text-warn" />}
        rows={data?.overboughtContinuation ?? []}
        empty={emptyMsg(data, "No overbought names with trend still dominating.")}
        tone="warn"
        subtitle="stretched, but the uptrend is still stronger than the reversal case — do not fade"
      />
      <Group
        title="OVERSOLD — CONTINUATION RISK"
        icon={<AlertTriangle className="h-4 w-4 text-warn" />}
        rows={data?.oversoldContinuation ?? []}
        empty={emptyMsg(data, "No oversold names with downtrend still dominating.")}
        tone="warn"
        subtitle="stretched, but the downtrend is still stronger than the reversal case — do not catch"
      />

      <section className="panel p-3 sm:p-4 text-[10px] text-ink-dim">
        <div className="flex items-start gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-profit shrink-0 mt-px" />
          <p>
            Reversal Confidence is an <span className="text-ink font-semibold">evidence score, not a probability</span>.
            Every value is derived from live Upstox data; where inputs are missing the factor is excluded and the row is
            marked PARTIAL or INSUFFICIENT rather than scored optimistically.
          </p>
        </div>
      </section>
    </div>
  );
}

function emptyMsg(d: Payload | null, msg: string): string {
  if (!d) return "Loading…";
  if (!d.engineRunning) return "Engine is not running — connect Upstox.";
  return msg;
}

/* --------------------------------- group --------------------------------- */

function Group({
  title, icon, rows, empty, tone, subtitle,
}: {
  title: string; icon: React.ReactNode; rows: ReversalResult[]; empty: string;
  tone: "loss" | "profit" | "warn"; subtitle?: string;
}) {
  return (
    <section className="panel p-2.5 sm:p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <SectionTitle icon={icon} title={title} count={rows.length} />
        {subtitle && <span className="text-[10px] text-ink-faint">{subtitle}</span>}
      </div>
      {rows.length === 0 ? (
        <div className="py-5 text-center text-[11px] text-ink-faint">{empty}</div>
      ) : (
        <DataTable minWidthClass="min-w-[1180px]">
          <table className={dtTableClass("min-w-[1180px]")}>
            <thead>
              <tr className="text-[9px] tracking-widest text-ink-faint border-b border-line">
                {["STOCK", "LTP", "CHG%", "RSI", "VWAP DIST", "BB %", "MOMENTUM", "OI POSITION", "ΔOI", "S/R", "REV", "CONT", "EDGE", "CONF", "PRIMARY REASON", "STATUS"].map((h) => (
                  <th key={h} className={`py-1.5 font-semibold whitespace-nowrap px-1.5 ${h === "STOCK" || h === "PRIMARY REASON" ? "text-left" : "text-right"}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => <Row key={r.symbol} row={r} tone={tone} />)}
            </tbody>
          </table>
        </DataTable>
      )}
    </section>
  );
}

function Row({ row, tone }: { row: ReversalResult; tone: "loss" | "profit" | "warn" }) {
  const [open, setOpen] = useState(false);
  const toneCls = tone === "loss" ? "text-loss" : tone === "profit" ? "text-profit" : "text-warn";
  return (
    <>
      <tr className="border-b border-line/40 table-row-hover cursor-pointer" onClick={() => setOpen((v) => !v)}>
        <td className="py-1.5 px-1.5">
          <div className="flex items-center gap-1.5">
            <ChevronDown className={`h-3 w-3 text-ink-faint transition-transform ${open ? "rotate-180" : ""}`} />
            <Link href={`/stock/${row.symbol}`} onClick={(e) => e.stopPropagation()} className="num font-bold hover:text-info">
              {row.symbol}
            </Link>
          </div>
        </td>
        <td className="text-right num px-1.5">{fnum(row.ltp)}</td>
        <td className={`text-right num px-1.5 ${pcol(row.changePct)}`}>{fpct(row.changePct)}</td>
        <td className={`text-right num px-1.5 font-bold ${row.rsi != null && row.rsi >= 70 ? "text-loss" : row.rsi != null && row.rsi <= 30 ? "text-profit" : "text-ink-dim"}`}>
          {row.rsi != null ? row.rsi.toFixed(0) : "N/A"}
        </td>
        <td className="text-right num px-1.5 text-ink-dim">
          {row.vwapDistAtr != null ? `${row.vwapDistAtr >= 0 ? "+" : ""}${row.vwapDistAtr.toFixed(1)} ATR` : "N/A"}
        </td>
        <td className="text-right num px-1.5 text-ink-dim">{row.bbPercent != null ? `${Math.round(row.bbPercent * 100)}%` : "N/A"}</td>
        <td className={`text-right num px-1.5 ${row.momentumLabel.includes("divergence") ? toneCls + " font-semibold" : "text-ink-dim"}`}>{row.momentumLabel}</td>
        <td className="text-right num px-1.5 text-ink-dim whitespace-nowrap">{row.oiPosition}</td>
        <td className={`text-right num px-1.5 ${pcol(row.oiChangePct)}`}>
          {row.oiChangePct != null ? `${row.oiChangePct >= 0 ? "+" : ""}${row.oiChangePct.toFixed(1)}%` : "N/A"}
        </td>
        <td className="text-right num px-1.5 text-ink-faint whitespace-nowrap max-w-[150px] truncate" title={row.srContext}>{row.srContext}</td>
        <td className={`text-right num px-1.5 font-black ${toneCls}`}>{row.reversalScore}</td>
        <td className="text-right num px-1.5 text-ink-dim">{row.continuationScore}</td>
        <td className={`text-right num px-1.5 font-bold ${row.reversalEdge > 0 ? "text-info" : "text-warn"}`}>
          {row.reversalEdge >= 0 ? "+" : ""}{row.reversalEdge}
        </td>
        <td className="text-right px-1.5">
          <span className={`chip ${row.confidence === "HIGH" ? "text-profit border-profit/40 bg-profit/10" : row.confidence === "MEDIUM" ? "text-warn border-warn/40 bg-warn/10" : "text-ink-faint border-line"}`}>
            {row.confidence}
          </span>
        </td>
        <td className="px-1.5 text-ink-dim max-w-[240px] truncate" title={row.primaryReason}>{row.primaryReason}</td>
        <td className="text-right px-1.5">
          <div className="flex items-center justify-end gap-1.5">
            <span className={`chip ${
              row.stage === "CONFIRMED" ? "text-info border-info/50 bg-info/15" :
              row.stage === "EARLY" ? "text-violet-glow border-violet-glow/45 bg-violet-glow/10" :
              "text-warn border-warn/40 bg-warn/10"}`}>
              {row.stage === "CONFIRMED" ? "REVERSAL CONFIRMED" : row.stage === "EARLY" ? "EARLY REVERSAL" : "CONTINUATION"}
            </span>
            {row.dataQuality !== "COMPLETE" && (
              <span className="chip text-ink-faint border-line">{row.dataQuality}</span>
            )}
            <DataStatusDot status={row.dataStatus} />
          </div>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-line/40">
          <td colSpan={16} className="px-3 py-3 bg-panel-2/50">
            <Detail row={row} />
          </td>
        </tr>
      )}
    </>
  );
}

/* ----------------------------- detail panel ------------------------------ */

function Detail({ row }: { row: ReversalResult }) {
  return (
    <div className="space-y-3 text-[11px] rise-in">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Lines title="REVERSAL EVIDENCE" lines={row.reversalLines} total={row.reversalScore} tone="info" />
        <Lines title="CONTINUATION EVIDENCE" lines={row.continuationLines} total={row.continuationScore} tone="warn" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        <Block title="EXTENSION">
          <KV k="RSI(14)" v={row.rsi != null ? row.rsi.toFixed(1) : "N/A"} />
          <KV k="RSI(7)" v={row.rsiFast != null ? row.rsiFast.toFixed(1) : "N/A"} />
          <KV k="VWAP distance" v={row.vwapDistPct != null ? `${row.vwapDistPct >= 0 ? "+" : ""}${row.vwapDistPct.toFixed(2)}%${row.vwapDistAtr != null ? ` (${row.vwapDistAtr.toFixed(2)} ATR)` : ""}` : "N/A"} />
          <KV k="Bollinger %B" v={row.bbPercent != null ? `${Math.round(row.bbPercent * 100)}%` : "N/A"} />
          <KV k="Band width" v={row.extreme.bbWidthPct != null ? `${row.extreme.bbWidthPct.toFixed(2)}%${row.extreme.bbExpanding != null ? row.extreme.bbExpanding ? " (expanding)" : " (contracting)" : ""}` : "N/A"} />
          <KV k="EMA20 extension" v={row.extreme.emaExtAtr != null ? `${row.extreme.emaExtAtr >= 0 ? "+" : ""}${row.extreme.emaExtAtr.toFixed(2)} ATR` : "N/A"} />
          <KV k="Factors met" v={`${row.extreme.factorsHit}/${row.extreme.factors.length}${row.extreme.strong ? " · STRONG" : ""}`} />
        </Block>

        <Block title="MOMENTUM">
          <KV k="Divergence" v={row.exhaustion.divergence.present ? `${row.exhaustion.divergence.kind} — ${row.exhaustion.divergence.detail}` : row.exhaustion.divergence.detail} />
          <KV k="MACD hist" v={row.exhaustion.macdState.hist != null ? `${row.exhaustion.macdState.hist.toFixed(3)} (slope ${row.exhaustion.macdState.histSlope?.toFixed(3) ?? "N/A"})` : "N/A"} />
          <KV k="ROC 5" v={row.exhaustion.roc5 != null ? `${row.exhaustion.roc5.toFixed(2)}%${row.exhaustion.rocPrev5 != null ? ` (prev ${row.exhaustion.rocPrev5.toFixed(2)}%)` : ""}` : "N/A"} />
          <KV k="Bodies shrinking" v={yn(row.exhaustion.bodiesShrinking)} />
          <KV k="Volume non-confirm" v={yn(row.exhaustion.volumeNotConfirming)} />
          <KV k="Exhaustion score" v={row.exhaustion.score != null ? `${row.exhaustion.score}/100` : "N/A"} />
        </Block>

        <Block title="PRICE ACTION">
          {row.priceAction.signals.map((s, i) => <div key={i} className="text-ink-dim">▸ {s}</div>)}
          <KV k="Rejection wick" v={yn(row.priceAction.rejectionWick)} />
          <KV k="Engulfing" v={yn(row.priceAction.engulfing)} />
          <KV k="Failed new extreme" v={yn(row.priceAction.failedNewExtreme)} />
          <KV k="Structure break" v={yn(row.priceAction.structureBreak)} />
          <KV k="VWAP flip" v={yn(row.priceAction.vwapFlip)} />
        </Block>

        <Block title="FUTURES">
          <KV k="Positioning" v={row.oiPosition} />
          <KV k="ΔOI" v={row.oiChangePct != null ? `${row.oiChangePct >= 0 ? "+" : ""}${row.oiChangePct.toFixed(2)}%` : "N/A"} />
        </Block>

        <Block title="OPTIONS">
          <KV k="Nearby support" v={row.options.support} />
          <KV k="Nearby resistance" v={row.options.resistance} />
          <KV k="PCR" v={row.options.pcr != null ? row.options.pcr.toFixed(2) : "N/A"} />
          <div className="text-ink-faint">{row.options.note}</div>
        </Block>

        <Block title="S/R & LIQUIDITY">
          <KV k="Zone" v={row.srContext} />
          <KV k="Distance" v={row.srDistancePct != null ? `${row.srDistancePct >= 0 ? "+" : ""}${row.srDistancePct.toFixed(2)}%` : "N/A"} />
          <KV k="Order flow" v={row.liquidity.note} />
          <KV k="Absorption" v={row.liquidity.buyerAbsorption ? "buyer-side" : row.liquidity.sellerAbsorption ? "seller-side" : "none detected"} />
          <KV k="Volume" v={row.volume.evidence} />
        </Block>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="rounded-lg border border-info/25 bg-info/5 px-3 py-2">
          <div className="text-[9px] tracking-widest text-info font-bold mb-1">REVERSAL EVIDENCE IS INCREASING BECAUSE</div>
          {row.reversalWhy.length ? row.reversalWhy.map((w, i) => <div key={i} className="text-ink-dim">▸ {w}</div>)
            : <div className="text-ink-faint">no reversal factor is currently above threshold</div>}
        </div>
        <div className="rounded-lg border border-warn/25 bg-warn/5 px-3 py-2">
          <div className="text-[9px] tracking-widest text-warn font-bold mb-1">CONTINUATION EVIDENCE REMAINS BECAUSE</div>
          {row.continuationWhy.length ? row.continuationWhy.map((w, i) => <div key={i} className="text-warn/90">▸ {w}</div>)
            : <div className="text-ink-faint">no continuation factor is currently above threshold</div>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[10px] num text-ink-faint border-t border-line/50 pt-2">
        <span>Reversal <b className="text-info">{row.reversalScore}</b></span>
        <span>Continuation <b className="text-warn">{row.continuationScore}</b></span>
        <span>Edge <b className={row.reversalEdge > 0 ? "text-profit" : "text-loss"}>{row.reversalEdge >= 0 ? "+" : ""}{row.reversalEdge}</b></span>
        <span>Confidence {row.confidence}</span>
        <span>Data {row.dataQuality}</span>
        {row.dataGaps.length > 0 && <span>Gaps: {row.dataGaps.join("; ")}</span>}
      </div>
    </div>
  );
}

function Lines({ title, lines, total, tone }: { title: string; lines: ScoreLine[]; total: number; tone: "info" | "warn" }) {
  const col = tone === "info" ? "text-info" : "text-warn";
  return (
    <div className="rounded-lg border border-line bg-panel p-2.5">
      <div className="flex items-center justify-between">
        <span className={`text-[9px] tracking-widest font-bold ${col}`}>{title}</span>
        <span className={`num text-sm font-black ${col}`}>{total}</span>
      </div>
      <div className="mt-2 space-y-1.5">
        {lines.map((l) => (
          <div key={l.key} className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="w-32 shrink-0 text-[10px] text-ink-dim">{l.label} <span className="text-ink-faint">{l.weight}%</span></span>
              <div className="flex-1"><Meter value={l.value ?? 0} tone={l.value == null ? "cyan" : l.value >= 60 ? (tone === "info" ? "green" : "amber") : "cyan"} /></div>
              <span className={`num w-8 text-right font-bold ${l.value == null ? "text-ink-faint" : col}`}>{l.value == null ? "—" : l.value}</span>
            </div>
            <div className="pl-32 text-[9px] text-ink-faint">{l.evidence}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-panel p-2.5 space-y-0.5">
      <div className="text-[9px] tracking-widest text-ink-dim font-bold mb-1">{title}</div>
      {children}
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-0.5 sm:gap-2 text-[10px]">
      <span className="text-ink-faint shrink-0">{k}</span>
      <span className="num text-ink sm:text-right break-words">{v}</span>
    </div>
  );
}

function yn(v: boolean | null): string {
  return v == null ? "N/A" : v ? "yes" : "no";
}
