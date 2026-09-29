import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

/**
 * SSL handling for managed Postgres (Render and similar):
 * - Render INTERNAL connection strings need no TLS — plain connection works.
 * - Render EXTERNAL connection strings include `sslmode=require`, which
 *   node-postgres does not enable by default — detect it (or PGSSL=true) and
 *   switch the pool to TLS so either URL style just works.
 */
const needsSsl =
  /sslmode=require|ssl=true/i.test(databaseUrl) ||
  (process.env.PGSSL ?? "").toLowerCase() === "true";

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  new Pool({
    connectionString: databaseUrl,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

export const db = drizzle(pool);
