"use client";

import { useState } from "react";
import { X, ShieldCheck, KeyRound, ExternalLink, Loader2, Settings2, RefreshCw } from "lucide-react";
import type { ScannerConfig } from "@/lib/engine/types";

/* ------------------------------ Connect modal ----------------------------- */

export function ConnectModal({
  open,
  onClose,
  onConnected,
  connected,
  userName,
  tokenInvalid,
}: {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
  connected: boolean;
  userName: string | null;
  tokenInvalid: boolean;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/upstox/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (data.ok) {
        setToken("");
        onConnected();
        onClose();
      } else {
        setError(data.error ?? "connection failed");
      }
    } catch {
      setError("network error — is the server running?");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    await fetch("/api/upstox/status", { method: "DELETE" }).catch(() => void 0);
    setBusy(false);
    onConnected();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-3 sm:p-4" onClick={onClose}>
      <div className="panel w-full max-w-lg p-4 sm:p-6 rise-in max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-info" /> Upstox Connection
            </h2>
            <p className="text-xs text-ink-dim mt-1">
              The token is validated against <span className="text-ink">api.upstox.com</span> and stored only on your server.
            </p>
          </div>
          <button onClick={onClose} className="text-ink-faint hover:text-ink"><X className="h-5 w-5" /></button>
        </div>

        {tokenInvalid && (
          <div className="mt-3 rounded-lg border border-loss/40 bg-loss/10 px-3 py-2 text-xs text-loss">
            The stored token was rejected (401). Tokens expire daily — paste a fresh one.
          </div>
        )}

        {connected ? (
          <div className="mt-5 space-y-4">
            <div className="flex items-center gap-3 rounded-lg border border-profit/30 bg-profit/10 px-4 py-3">
              <ShieldCheck className="h-5 w-5 text-profit" />
              <div>
                <div className="text-sm font-semibold text-profit">Connected</div>
                <div className="text-xs text-ink-dim">Signed in as {userName ?? "Upstox user"}</div>
              </div>
            </div>
            <button
              onClick={disconnect}
              disabled={busy}
              className="w-full rounded-lg border border-loss/40 bg-loss/10 px-4 py-2 text-sm font-semibold text-loss hover:bg-loss/20 transition"
            >
              {busy ? "Removing…" : "Disconnect & remove token"}
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-5 space-y-4">
            <div className="rounded-lg border border-line bg-panel-2 p-4 text-xs leading-5 text-ink-dim space-y-1.5">
              <p className="font-semibold text-ink">How to get an access token:</p>
              <p>1. Create/log into your app at the Upstox Developer Console.</p>
              <p>2. Complete the OAuth login flow (or use your existing daily token generation).</p>
              <p>3. Paste the resulting <span className="text-info">access_token</span> below. Upstox tokens are valid until early morning of the next day.</p>
              <a
                href="https://upstox.com/developer/api-documentation/authentication/"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-info hover:underline"
              >
                Official authentication docs <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste access token — it never leaves this server"
              className="w-full rounded-lg border border-line bg-black/40 px-4 py-3 text-sm num placeholder:text-ink-faint focus:border-info/60 transition"
              autoComplete="off"
            />
            {error && <div className="text-xs text-loss">{error}</div>}
            <button
              type="submit"
              disabled={busy || token.length < 10}
              className="w-full rounded-lg bg-info/90 hover:bg-info text-terminal font-bold px-4 py-2.5 text-sm transition disabled:opacity-40 flex items-center justify-center gap-2"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {busy ? "Validating with Upstox…" : "Validate & Connect"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

/* ------------------------------ Settings drawer --------------------------- */

export function SettingsDrawer({
  open,
  onClose,
  config,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  config: ScannerConfig | null;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<ScannerConfig | null>(config);
  const [busy, setBusy] = useState(false);
  if (!open) return null;
  const d = draft ?? config;
  if (!d) return null;

  const num = (label: string, val: number, onChange: (v: number) => void, step = "1") => (
    <label className="flex items-center justify-between gap-3 text-xs">
      <span className="text-ink-dim">{label}</span>
      <input
        type="number"
        step={step}
        defaultValue={val}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-24 rounded-md border border-line bg-black/40 px-2 py-1.5 num text-right focus:border-info/60"
      />
    </label>
  );

  const setDraftFn = (fn: (c: ScannerConfig) => ScannerConfig) => setDraft((prev) => fn(JSON.parse(JSON.stringify(prev ?? config)) as ScannerConfig));

  const save = async () => {
    setBusy(true);
    await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(d),
    }).catch(() => void 0);
    setBusy(false);
    onSaved();
    onClose();
  };

  const control = async (action: string) => {
    await fetch("/api/scanner/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    }).catch(() => void 0);
    onSaved();
  };

  const mw = d.momentumWeights;
  const fw = d.finalWeights;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="safe-bottom h-full w-full max-w-md overflow-y-auto bg-terminal border-l border-line p-4 sm:p-6 rise-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold flex items-center gap-2"><Settings2 className="h-5 w-5 text-info" /> Engine Settings</h2>
          <button onClick={onClose} className="text-ink-faint hover:text-ink"><X className="h-5 w-5" /></button>
        </div>

        <div className="mt-5 space-y-6 text-sm">
          <section className="space-y-2.5">
            <h3 className="text-[11px] font-bold tracking-[0.15em] text-info">PIPELINE</h3>
            {num("Stage-2 candidates", d.stage2Candidates, (v) => setDraftFn((c) => ({ ...c, stage2Candidates: v })))}
            {num("Top-N setups", d.topNSetups, (v) => setDraftFn((c) => ({ ...c, topNSetups: v })))}
            {num("Quote poll (s)", d.quotePollIntervalSec, (v) => setDraftFn((c) => ({ ...c, quotePollIntervalSec: v })))}
            {num("Stage-2 interval (s)", d.stage2IntervalSec, (v) => setDraftFn((c) => ({ ...c, stage2IntervalSec: v })))}
            {num("Candle refreshes / scan", d.universeCandleRefreshPerScan, (v) => setDraftFn((c) => ({ ...c, universeCandleRefreshPerScan: v })))}
          </section>

          <section className="space-y-2.5">
            <h3 className="text-[11px] font-bold tracking-[0.15em] text-info">FILTERS & GATES</h3>
            {num("RVOL threshold", d.rvolThreshold, (v) => setDraftFn((c) => ({ ...c, rvolThreshold: v })), "0.1")}
            {num("Min avg daily volume", d.minAvgDailyVolume, (v) => setDraftFn((c) => ({ ...c, minAvgDailyVolume: v })), "10000")}
            {num("Min turnover (₹ Cr)", d.minTurnoverCr, (v) => setDraftFn((c) => ({ ...c, minTurnoverCr: v })), "10")}
            {num("Enter score (hysteresis ↑)", d.enterScore, (v) => setDraftFn((c) => ({ ...c, enterScore: v })))}
            {num("Exit score (hysteresis ↓)", d.exitScore, (v) => setDraftFn((c) => ({ ...c, exitScore: v })))}
            {num("Min R:R", d.minRR, (v) => setDraftFn((c) => ({ ...c, minRR: v })), "0.5")}
            {num("Max breakout extension %", d.maxBreakoutExtensionPct, (v) => setDraftFn((c) => ({ ...c, maxBreakoutExtensionPct: v })), "0.1")}
            {num("Opening range (min)", d.openingRangeMinutes, (v) => setDraftFn((c) => ({ ...c, openingRangeMinutes: v })))}
          </section>

          <section className="space-y-2.5">
            <h3 className="text-[11px] font-bold tracking-[0.15em] text-info">STAGE-1 MOMENTUM WEIGHTS</h3>
            {num("RVOL", mw.rvol, (v) => setDraftFn((c) => ({ ...c, momentumWeights: { ...c.momentumWeights, rvol: v } })))}
            {num("Relative strength", mw.rs, (v) => setDraftFn((c) => ({ ...c, momentumWeights: { ...c.momentumWeights, rs: v } })))}
            {num("RS acceleration", mw.rsAccel, (v) => setDraftFn((c) => ({ ...c, momentumWeights: { ...c.momentumWeights, rsAccel: v } })))}
            {num("5-min trend", mw.trend5m, (v) => setDraftFn((c) => ({ ...c, momentumWeights: { ...c.momentumWeights, trend5m: v } })))}
            {num("Price / VWAP", mw.vwap, (v) => setDraftFn((c) => ({ ...c, momentumWeights: { ...c.momentumWeights, vwap: v } })))}
            {num("Futures confirm", mw.futures, (v) => setDraftFn((c) => ({ ...c, momentumWeights: { ...c.momentumWeights, futures: v } })))}
            {num("Liquidity", mw.liquidity, (v) => setDraftFn((c) => ({ ...c, momentumWeights: { ...c.momentumWeights, liquidity: v } })))}
          </section>

          <section className="space-y-2.5">
            <h3 className="text-[11px] font-bold tracking-[0.15em] text-info">FINAL SCORE WEIGHTS</h3>
            {num("Price structure", fw.priceStructure, (v) => setDraftFn((c) => ({ ...c, finalWeights: { ...c.finalWeights, priceStructure: v } })))}
            {num("RVOL", fw.rvol, (v) => setDraftFn((c) => ({ ...c, finalWeights: { ...c.finalWeights, rvol: v } })))}
            {num("Relative strength", fw.rs, (v) => setDraftFn((c) => ({ ...c, finalWeights: { ...c.finalWeights, rs: v } })))}
            {num("RS acceleration", fw.rsAccel, (v) => setDraftFn((c) => ({ ...c, finalWeights: { ...c.finalWeights, rsAccel: v } })))}
            {num("S/R quality", fw.srQuality, (v) => setDraftFn((c) => ({ ...c, finalWeights: { ...c.finalWeights, srQuality: v } })))}
            {num("Option confluence", fw.optionConfluence, (v) => setDraftFn((c) => ({ ...c, finalWeights: { ...c.finalWeights, optionConfluence: v } })))}
            {num("Futures", fw.futures, (v) => setDraftFn((c) => ({ ...c, finalWeights: { ...c.finalWeights, futures: v } })))}
            {num("5-min trend", fw.trend5m, (v) => setDraftFn((c) => ({ ...c, finalWeights: { ...c.finalWeights, trend5m: v } })))}
            {num("Risk/Reward", fw.rr, (v) => setDraftFn((c) => ({ ...c, finalWeights: { ...c.finalWeights, rr: v } })))}
          </section>

          <section className="space-y-2">
            <h3 className="text-[11px] font-bold tracking-[0.15em] text-info">MAINTENANCE</h3>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => control("refresh-universe")} className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs font-semibold hover:border-info/50 transition flex items-center gap-1.5 justify-center">
                <RefreshCw className="h-3.5 w-3.5" /> Refresh universe
              </button>
              <button onClick={() => control("refresh-baselines")} className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs font-semibold hover:border-info/50 transition flex items-center gap-1.5 justify-center">
                <RefreshCw className="h-3.5 w-3.5" /> Rebuild baselines
              </button>
            </div>
          </section>

          <button onClick={save} disabled={busy} className="w-full rounded-lg bg-info/90 hover:bg-info text-terminal font-bold px-4 py-2.5 text-sm transition disabled:opacity-50">
            {busy ? "Saving…" : "Save configuration"}
          </button>
        </div>
      </div>
    </div>
  );
}
