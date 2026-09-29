/**
 * Idempotent schema bootstrap. Runs at server start so the app works on any
 * fresh PostgreSQL (e.g. Render) without a separate migration step. Mirrors
 * src/db/schema.ts — uses CREATE TABLE/INDEX IF NOT EXISTS so it is safe to
 * run on every boot and on existing local databases.
 */

import { pool } from "./index";

const DDL = `
CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS upstox_auth (
  id integer PRIMARY KEY,
  access_token text NOT NULL,
  user_id text,
  user_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS universe_symbols (
  symbol text PRIMARY KEY,
  name text NOT NULL,
  isin text,
  equity_key text NOT NULL,
  futures_key text,
  futures_trading_symbol text,
  futures_expiry bigint,
  lot_size integer,
  tick_size double precision,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS baselines (
  symbol text PRIMARY KEY,
  trade_date text NOT NULL,
  avg_daily_volume double precision,
  volume_buckets jsonb,
  pdh double precision,
  pdl double precision,
  pdc double precision,
  atr14 double precision,
  fut_prev_oi double precision,
  fut_prev_close double precision,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signal_events (
  id serial PRIMARY KEY,
  symbol text NOT NULL,
  from_state text,
  to_state text NOT NULL,
  direction text,
  score double precision,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signal_events_created_idx ON signal_events (created_at);
`;

let ensured = false;

export async function ensureSchema(): Promise<void> {
  if (ensured) return;
  try {
    await pool.query(DDL);
    ensured = true;
  } catch (e) {
    // Non-fatal: the engine degrades to disconnected state; /api/health still
    // reports DB health independently.
    console.error("schema bootstrap failed:", e instanceof Error ? e.message : e);
  }
}
