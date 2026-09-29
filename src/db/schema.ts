import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  doublePrecision,
  serial,
  index,
} from "drizzle-orm/pg-core";

/** Generic key-value settings bucket (scanner configuration lives here). */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Upstox authentication. Single-row table. The raw access token NEVER leaves
 * the server — API routes only expose connection status / user profile name.
 */
export const upstoxAuth = pgTable("upstox_auth", {
  id: integer("id").primaryKey(),
  accessToken: text("access_token").notNull(),
  userId: text("user_id"),
  userName: text("user_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Live NSE F&O universe derived from the official Upstox instrument master.
 * Refreshed automatically — new contracts appear, expired ones disappear.
 */
export const universeSymbols = pgTable("universe_symbols", {
  symbol: text("symbol").primaryKey(),
  name: text("name").notNull(),
  isin: text("isin"),
  equityKey: text("equity_key").notNull(),
  futuresKey: text("futures_key"),
  futuresTradingSymbol: text("futures_trading_symbol"),
  futuresExpiry: bigint("futures_expiry", { mode: "number" }),
  lotSize: integer("lot_size"),
  tickSize: doublePrecision("tick_size"),
  active: boolean("active").default(true).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Daily pre-computed baselines from Upstox historical candles.
 * volumeBuckets: array of average 15-minute volumes across the session,
 * aligned to IST minute offsets from 09:15. Computed exclusively from real
 * Upstox historical data.
 */
export const baselines = pgTable("baselines", {
  symbol: text("symbol").primaryKey(),
  tradeDate: text("trade_date").notNull(),
  avgDailyVolume: doublePrecision("avg_daily_volume"),
  volumeBuckets: jsonb("volume_buckets"),
  pdh: doublePrecision("pdh"),
  pdl: doublePrecision("pdl"),
  pdc: doublePrecision("pdc"),
  atr14: doublePrecision("atr14"),
  futPrevOi: doublePrecision("fut_prev_oi"),
  futPrevClose: doublePrecision("fut_prev_close"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** State transition audit trail (EARLY -> CONFIRMED -> SETUP etc.). */
export const signalEvents = pgTable(
  "signal_events",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    direction: text("direction"),
    score: doublePrecision("score"),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("signal_events_created_idx").on(t.createdAt)],
);
