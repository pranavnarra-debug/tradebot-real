import { pgTable, text, integer, real, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ── Positions ──────────────────────────────────────────────────────────────
export const positions = pgTable("positions", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  bucket: text("bucket").notNull(),
  strategy: text("strategy").notNull(),
  shares: real("shares").notNull(),
  entryPrice: real("entry_price").notNull(),
  currentPrice: real("current_price").notNull(),
  stopLoss: real("stop_loss").notNull(),
  takeProfit: real("take_profit").notNull(),
  trailingStop: real("trailing_stop"),
  convictionScore: integer("conviction_score").notNull().default(75),
  entryReason: text("entry_reason").notNull(),
  status: text("status").notNull().default("open"),
  alpacaOrderId: text("alpaca_order_id"),
  openedAt: text("opened_at").notNull(),
  closedAt: text("closed_at"),
  closeReason: text("close_reason"),
  peakPrice: real("peak_price"),
});

export const insertPositionSchema = createInsertSchema(positions).omit({ id: true });
export type InsertPosition = z.infer<typeof insertPositionSchema>;
export type Position = typeof positions.$inferSelect;

// ── Trades ─────────────────────────────────────────────────────────────────
export const trades = pgTable("trades", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  bucket: text("bucket").notNull(),
  strategy: text("strategy").notNull(),
  shares: real("shares").notNull(),
  entryPrice: real("entry_price").notNull(),
  exitPrice: real("exit_price").notNull(),
  pnl: real("pnl").notNull(),
  pnlPct: real("pnl_pct").notNull(),
  entryReason: text("entry_reason").notNull(),
  closeReason: text("close_reason").notNull(),
  openedAt: text("opened_at").notNull(),
  closedAt: text("closed_at").notNull(),
  durationHours: real("duration_hours").notNull(),
});

export const insertTradeSchema = createInsertSchema(trades).omit({ id: true });
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type Trade = typeof trades.$inferSelect;

// ── Bot Config ─────────────────────────────────────────────────────────────
export const botConfig = pgTable("bot_config", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
});

export const insertBotConfigSchema = createInsertSchema(botConfig).omit({ id: true });
export type InsertBotConfig = z.infer<typeof insertBotConfigSchema>;
export type BotConfig = typeof botConfig.$inferSelect;

// ── Signals Log ────────────────────────────────────────────────────────────
export const signals = pgTable("signals", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  bucket: text("bucket").notNull(),
  signalType: text("signal_type").notNull(),
  details: text("details").notNull(),
  createdAt: text("created_at").notNull(),
});

export const insertSignalSchema = createInsertSchema(signals).omit({ id: true });
export type InsertSignal = z.infer<typeof insertSignalSchema>;
export type Signal = typeof signals.$inferSelect;

// ── Portfolio Snapshots ────────────────────────────────────────────────────
export const snapshots = pgTable("snapshots", {
  id: serial("id").primaryKey(),
  totalValue: real("total_value").notNull(),
  cashValue: real("cash_value").notNull(),
  positionsValue: real("positions_value").notNull(),
  dailyPnl: real("daily_pnl").notNull(),
  totalPnl: real("total_pnl").notNull(),
  volatileBucketValue: real("volatile_bucket_value").notNull(),
  swingBucketValue: real("swing_bucket_value").notNull(),
  longtermBucketValue: real("longterm_bucket_value").notNull(),
  recordedAt: text("recorded_at").notNull(),
});

export const insertSnapshotSchema = createInsertSchema(snapshots).omit({ id: true });
export type InsertSnapshot = z.infer<typeof insertSnapshotSchema>;
export type Snapshot = typeof snapshots.$inferSelect;

// ── Stock Notes ────────────────────────────────────────────────────────────
export const stockNotes = pgTable("stock_notes", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull().unique(),
  content: text("content").notNull().default(""),
  updatedAt: text("updated_at").notNull(),
});

export const insertStockNoteSchema = createInsertSchema(stockNotes).omit({ id: true });
export type InsertStockNote = z.infer<typeof insertStockNoteSchema>;
export type StockNote = typeof stockNotes.$inferSelect;
