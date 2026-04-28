import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Add a PostgreSQL database in Railway.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

export const db = drizzle(pool, { schema });

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS positions (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      bucket TEXT NOT NULL,
      strategy TEXT NOT NULL,
      shares REAL NOT NULL,
      entry_price REAL NOT NULL,
      current_price REAL NOT NULL,
      stop_loss REAL NOT NULL,
      take_profit REAL NOT NULL,
      trailing_stop REAL,
      conviction_score INTEGER NOT NULL DEFAULT 75,
      entry_reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      alpaca_order_id TEXT,
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      close_reason TEXT,
      peak_price REAL
    );

    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      bucket TEXT NOT NULL,
      strategy TEXT NOT NULL,
      shares REAL NOT NULL,
      entry_price REAL NOT NULL,
      exit_price REAL NOT NULL,
      pnl REAL NOT NULL,
      pnl_pct REAL NOT NULL,
      entry_reason TEXT NOT NULL,
      close_reason TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      closed_at TEXT NOT NULL,
      duration_hours REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bot_config (
      id SERIAL PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS signals (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      bucket TEXT NOT NULL,
      signal_type TEXT NOT NULL,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id SERIAL PRIMARY KEY,
      total_value REAL NOT NULL,
      cash_value REAL NOT NULL,
      positions_value REAL NOT NULL,
      daily_pnl REAL NOT NULL,
      total_pnl REAL NOT NULL,
      volatile_bucket_value REAL NOT NULL,
      swing_bucket_value REAL NOT NULL,
      longterm_bucket_value REAL NOT NULL,
      recorded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_notes (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
  `);
  console.log("[DB] PostgreSQL tables ready");
}
