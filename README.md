# F&O Pulse — NSE Intraday Scanner & Trade Setup Engine

A two-stage NSE F&O intraday scanner powered **exclusively by the Upstox API**.
No synthetic, cached-third-party or fabricated market data anywhere — every
OHLC, LTP, volume, OI, option-chain value, RVOL, RS, support/resistance level,
entry, stop, target and score is derived from actual Upstox responses. If
Upstox does not provide a value, the UI shows `N/A` / `INSUFFICIENT DATA`.

- **Stage 1 — fast market-wide filter** across the entire live F&O universe
  (auto-derived from the official instrument master, ~210 underlyings):
  RVOL (time-of-day-adjusted vs real historical buckets), RS vs NIFTY,
  RS acceleration, price momentum, VWAP position, 5-minute EMA/structure
  trend, futures price + OI confirmation.
- **Stage 2 — deep analysis of the top candidates only**: combined dynamic
  support/resistance zones (previous-day levels, opening range, swings,
  consolidation, volume POC, VWAP, broken-level retests) merged with
  option-chain OI positioning, confluence-scored 0–100, then structural
  entries, invalidation stops, T1/T2/T3 targets and an R:R quality gate.
- Hysteresis state machine: `EARLY MOMENTUM → CONFIRMED MOMENTUM →
  TRADE SETUP / WAIT FOR BREAKOUT-BREAKDOWN-RETEST / NO TRADE`.
- Stocks with weak structure, poor R:R, contradicted futures/option
  positioning or stale data are shown explicitly as `NO TRADE` — the engine
  never manufactures the Top 10.

## Stack

Next.js (App Router) · PostgreSQL via Drizzle ORM · lightweight-charts ·
Tailwind CSS · Upstox v2/v3 REST APIs.

## Run locally

```bash
npm install
npm run build
npm start
# DATABASE_URL must point to PostgreSQL (schema auto-bootstraps on start)
```

Open the app, press **Connect Upstox**, and paste your daily Upstox
`access_token`. The token is verified against Upstox, stored only server-side
(PostgreSQL), never logged and never sent to the browser.

## Deploy to Render (one click)

This repo ships a Render blueprint (`render.yaml`):

1. Push to GitHub/GitLab.
2. Render Dashboard → **New → Blueprint** → select this repository.
3. Render provisions:
   - a **Node web service** (`npm install && npm run build`, `npm start`)
   - a **PostgreSQL** database, with `DATABASE_URL` auto-injected.
4. The database schema is created automatically on first start
   (`src/db/ensure-schema.ts`, idempotent — no migration step needed).
5. Open the app → **Connect Upstox** → paste your token. Done.

### Environment variables

| Key | Source | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Render Postgres (`fromDatabase`) | Required — works with both the **internal** URL (no TLS) and the **external** URL (`sslmode=require` is detected automatically) |
| `ENABLE_KEEPALIVE` | `"true"` | The engine pings itself every 60s so free/starter plans don't idle-sleep |
| `NODE_VERSION` | `"22"` in render.yaml | Also pinned via `.nvmrc` |
| Upstox token | *never an env var* | Entered in the UI per day, stored server-side only |

### Notes for hosting

- Run **one instance** of the web service — the scanner is an in-process
  singleton (multiple instances would duplicate Upstox API traffic).
- The free Render Postgres plan expires after 30 days; upgrade or recreate
  the DB (redeploy) and reconnect the token in the UI.
- Old Upstox tokens expire daily (early morning). The app shows a re-connect
  banner if Upstox rejects a stored token (401).
- **Fully responsive phone → desktop.** Every tab and every table column is
  reachable on mobile: wide tables (Stage-1 tape, Reversal Radar, option
  chain, pipeline) scroll horizontally with a **sticky header row and sticky
  symbol column**, plus an animated swipe hint that disappears once you
  scroll. Cards, stat grids and detail panels collapse to single/two columns,
  and the settings drawer becomes a full-height bottom sheet.
- The app survives host restarts: the schema, universe and candle caches
  rebuild automatically at boot.

## Data integrity policy

If Upstox is down, rate-limited, or a field is unavailable, affected values
render as **N/A / DATA UNAVAILABLE / INSUFFICIENT DATA** and trade suggestions
pause — they are never replaced with estimates.
