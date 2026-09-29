import type { FuturesSignal, Trend } from "@/lib/engine/types";

/* ------------------------------ formatting ------------------------------- */

export function fnum(n: number | null | undefined, d = 2): string {
  if (n == null || !Number.isFinite(n)) return "N/A";
  return n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fpct(n: number | null | undefined, sign = true, d = 2): string {
  if (n == null || !Number.isFinite(n)) return "N/A";
  const s = sign ? (n > 0 ? "+" : n < 0 ? "−" : "") : "";
  return `${s}${Math.abs(n).toFixed(d)}%`;
}

export function fx(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "N/A";
  return `${n.toFixed(2)}x`;
}

export function fvol(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "N/A";
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} K`;
  return `${Math.round(n)}`;
}

/** Traded value in ₹ crore — real turnover, N/A when unavailable. */
export function fcr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "N/A";
  if (n >= 10000) return `${(n / 1000).toFixed(1)}K`;
  if (n >= 1000) return `${n.toFixed(0)}`;
  if (n >= 100) return n.toFixed(0);
  return n.toFixed(1);
}

export function ftime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return "—";
  }
}

export function pcol(n: number | null | undefined, invert = false): string {
  if (n == null || !Number.isFinite(n)) return "text-ink-dim";
  const pos = invert ? n < 0 : n > 0;
  const neg = invert ? n > 0 : n < 0;
  if (pos) return "text-profit";
  if (neg) return "text-loss";
  return "text-ink";
}

/* ------------------------------- badges ---------------------------------- */

export function DirBadge({ dir }: { dir: "LONG" | "SHORT" | null }) {
  if (!dir) return <span className="chip text-ink-faint border-line">FLAT</span>;
  return (
    <span className={`chip ${dir === "LONG" ? "bg-profit/10 text-profit border-profit/40" : "bg-loss/10 text-loss border-loss/40"}`}>
      {dir}
    </span>
  );
}

export function TrendBadge({ trend }: { trend: Trend | null | undefined }) {
  const t = trend ?? "INSUFFICIENT_DATA";
  const cls =
    t === "BULLISH" ? "bg-profit/10 text-profit border-profit/40" :
    t === "BEARISH" ? "bg-loss/10 text-loss border-loss/40" :
    t === "NEUTRAL" ? "bg-ink-dim/10 text-ink-dim border-line-bright" :
    "bg-ink-faint/10 text-ink-faint border-line";
  return <span className={`chip ${cls}`}>{t === "INSUFFICIENT_DATA" ? "INSUFF DATA" : t}</span>;
}

export function SetupStateBadge({ state }: { state: string }) {
  const cls =
    state === "TRADE_SETUP" ? "bg-profit/15 text-profit border-profit/50" :
    state === "WAIT_RETEST" ? "bg-info/10 text-info border-info/40" :
    state.startsWith("WAIT") ? "bg-warn/10 text-warn border-warn/40" :
    state === "INSUFFICIENT_DATA" ? "bg-ink-faint/10 text-ink-faint border-line" :
    "bg-loss/10 text-loss border-loss/40";
  const label = state.replaceAll("_", " ");
  return <span className={`chip ${cls}`}>{label}</span>;
}

export function FuturesBadge({ signal }: { signal: FuturesSignal }) {
  if (signal === "UNAVAILABLE") return <span className="text-[10px] text-ink-faint num">N/A</span>;
  const cls =
    signal === "LONG_BUILDUP" ? "text-profit" :
    signal === "SHORT_BUILDUP" ? "text-loss" :
    signal === "NEUTRAL" ? "text-ink-dim" : "text-info";
  return <span className={`text-[10px] font-semibold num ${cls}`}>{signal.replaceAll("_", " ")}</span>;
}

export function DataStatusDot({ status }: { status: string }) {
  const map: Record<string, string> = {
    LIVE: "bg-profit live-dot",
    RECENT: "bg-warn",
    STALE: "bg-loss/70",
    PARTIAL: "bg-info",
    UNAVAILABLE: "bg-ink-faint/50",
  };
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 rounded-full ${map[status] ?? map.UNAVAILABLE}`} />
      <span className="text-[9px] tracking-wider text-ink-dim font-semibold">{status}</span>
    </span>
  );
}

/* ------------------------------ score ring ------------------------------- */

export function ScoreRing({ score, size = 58, tone }: { score: number; size?: number; tone?: "auto" | "cyan" }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, score)) / 100;
  const color =
    tone === "cyan" ? "#38bdf8" : score >= 75 ? "#34d399" : score >= 60 ? "#fbbf24" : "#fb7185";
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="#16203a" strokeWidth={5} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={5}
          fill="none"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - p)}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.6s ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="num text-sm font-bold" style={{ color }}>{Math.round(score)}</span>
      </div>
    </div>
  );
}

export function Meter({ value, tone = "cyan" }: { value: number; tone?: "cyan" | "green" | "amber" | "red" }) {
  const col = tone === "green" ? "#34d399" : tone === "amber" ? "#fbbf24" : tone === "red" ? "#fb7185" : "#38bdf8";
  return (
    <div className="meter-track h-1.5 w-full">
      <div
        className="h-1.5 rounded-full transition-all duration-500"
        style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: col }}
      />
    </div>
  );
}

export function ZoneLabel({ low, high }: { low: number | null | undefined; high: number | null | undefined }) {
  if (low == null || high == null) return <span className="num text-ink-faint">N/A</span>;
  return (
    <span className="num">
      {fnum(low)} <span className="text-ink-faint">–</span> {fnum(high)}
    </span>
  );
}

export function SectionTitle({ icon, title, hint, count }: { icon: React.ReactNode; title: string; hint?: string; count?: number }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-info">{icon}</span>
      <h3 className="text-[13px] font-bold tracking-[0.14em] text-ink">{title}</h3>
      {typeof count === "number" && (
        <span className="chip bg-info/10 text-info border-info/30 num">{count}</span>
      )}
      {hint && <span className="text-[10px] text-ink-faint ml-auto">{hint}</span>}
    </div>
  );
}
