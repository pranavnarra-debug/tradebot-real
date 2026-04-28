import { db } from "./db";
import {
  positions, trades, botConfig, signals, snapshots, stockNotes,
  Position, Trade, BotConfig, Signal, Snapshot, StockNote,
  InsertPosition, InsertTrade, InsertBotConfig, InsertSignal, InsertSnapshot
} from "@shared/schema";
import { eq, desc, and } from "drizzle-orm";

export interface IStorage {
  getOpenPositions(): Promise<Position[]>;
  getPositionBySymbolAndBucket(symbol: string, bucket: string): Promise<Position | undefined>;
  createPosition(p: InsertPosition): Promise<Position>;
  updatePosition(id: number, updates: Partial<Position>): Promise<void>;
  closePosition(id: number, exitPrice: number, reason: string): Promise<void>;
  getTrades(limit?: number): Promise<Trade[]>;
  createTrade(t: InsertTrade): Promise<Trade>;
  getConfig(key: string): Promise<string | undefined>;
  setConfig(key: string, value: string): Promise<void>;
  getRecentSignals(limit?: number): Promise<Signal[]>;
  logSignal(s: InsertSignal): Promise<Signal>;
  getSnapshots(limit?: number): Promise<Snapshot[]>;
  createSnapshot(s: InsertSnapshot): Promise<Snapshot>;
  getNotes(symbol: string): Promise<StockNote | undefined>;
  upsertNotes(symbol: string, content: string): Promise<StockNote>;
}

export class Storage implements IStorage {
  async getOpenPositions(): Promise<Position[]> {
    return db.select().from(positions).where(eq(positions.status, "open"));
  }

  async getPositionBySymbolAndBucket(symbol: string, bucket: string): Promise<Position | undefined> {
    const rows = await db.select().from(positions)
      .where(and(eq(positions.symbol, symbol), eq(positions.bucket, bucket), eq(positions.status, "open")));
    return rows[0];
  }

  async createPosition(p: InsertPosition): Promise<Position> {
    const rows = await db.insert(positions).values(p).returning();
    return rows[0];
  }

  async updatePosition(id: number, updates: Partial<Position>): Promise<void> {
    await db.update(positions).set(updates).where(eq(positions.id, id));
  }

  async closePosition(id: number, exitPrice: number, reason: string): Promise<void> {
    await db.update(positions).set({
      status: "closed",
      currentPrice: exitPrice,
      closedAt: new Date().toISOString(),
      closeReason: reason,
    }).where(eq(positions.id, id));
  }

  async getTrades(limit = 100): Promise<Trade[]> {
    return db.select().from(trades).orderBy(desc(trades.id)).limit(limit);
  }

  async createTrade(t: InsertTrade): Promise<Trade> {
    const rows = await db.insert(trades).values(t).returning();
    return rows[0];
  }

  async getConfig(key: string): Promise<string | undefined> {
    const rows = await db.select().from(botConfig).where(eq(botConfig.key, key));
    return rows[0]?.value;
  }

  async setConfig(key: string, value: string): Promise<void> {
    const existing = await db.select().from(botConfig).where(eq(botConfig.key, key));
    if (existing.length > 0) {
      await db.update(botConfig).set({ value }).where(eq(botConfig.key, key));
    } else {
      await db.insert(botConfig).values({ key, value });
    }
  }

  async getRecentSignals(limit = 50): Promise<Signal[]> {
    return db.select().from(signals).orderBy(desc(signals.id)).limit(limit);
  }

  async logSignal(s: InsertSignal): Promise<Signal> {
    const rows = await db.insert(signals).values(s).returning();
    return rows[0];
  }

  async getSnapshots(limit = 100): Promise<Snapshot[]> {
    return db.select().from(snapshots).orderBy(desc(snapshots.id)).limit(limit);
  }

  async createSnapshot(s: InsertSnapshot): Promise<Snapshot> {
    const rows = await db.insert(snapshots).values(s).returning();
    return rows[0];
  }

  async getNotes(symbol: string): Promise<StockNote | undefined> {
    const rows = await db.select().from(stockNotes).where(eq(stockNotes.symbol, symbol.toUpperCase()));
    return rows[0];
  }

  async upsertNotes(symbol: string, content: string): Promise<StockNote> {
    const sym = symbol.toUpperCase();
    const now = new Date().toISOString();
    const existing = await db.select().from(stockNotes).where(eq(stockNotes.symbol, sym));
    if (existing.length > 0) {
      const rows = await db.update(stockNotes)
        .set({ content, updatedAt: now })
        .where(eq(stockNotes.symbol, sym))
        .returning();
      return rows[0];
    } else {
      const rows = await db.insert(stockNotes)
        .values({ symbol: sym, content, updatedAt: now })
        .returning();
      return rows[0];
    }
  }
}

export const storage = new Storage();
