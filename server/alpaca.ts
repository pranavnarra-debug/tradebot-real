import axios from "axios";

const BASE = "https://paper-api.alpaca.markets";
const DATA = "https://data.alpaca.markets";

const KEY = process.env.ALPACA_KEY || "PKCBITI3AV45CSDZ3JEATZLH7L";
const SECRET = process.env.ALPACA_SECRET || "CoEJFXcy6pSjN52i63fn2nwHj62qZfNea6M95GAcvhfm";

const headers = {
  "APCA-API-KEY-ID": KEY,
  "APCA-API-SECRET-KEY": SECRET,
};

export const alpaca = axios.create({ baseURL: BASE, headers });
export const alpacaData = axios.create({ baseURL: DATA, headers });

// ── Account ────────────────────────────────────────────────────────────────
export async function getAccount() {
  const r = await alpaca.get("/v2/account");
  return r.data;
}

// ── Positions ──────────────────────────────────────────────────────────────
export async function getAlpacaPositions() {
  const r = await alpaca.get("/v2/positions");
  return r.data;
}

// ── Orders ─────────────────────────────────────────────────────────────────
export async function placeMarketOrder(symbol: string, qty: number, side: "buy" | "sell") {
  const r = await alpaca.post("/v2/orders", {
    symbol,
    qty: Math.floor(qty),
    side,
    type: "market",
    time_in_force: "day",
  });
  return r.data;
}

export async function placeLimitOrder(
  symbol: string,
  qty: number,
  side: "buy" | "sell",
  limitPrice: number
) {
  const r = await alpaca.post("/v2/orders", {
    symbol,
    qty: Math.floor(qty),
    side,
    type: "limit",
    time_in_force: "gtc",
    limit_price: limitPrice.toFixed(2),
  });
  return r.data;
}

export async function placeTrailingStopOrder(
  symbol: string,
  qty: number,
  trailPercent: number
) {
  const r = await alpaca.post("/v2/orders", {
    symbol,
    qty: Math.floor(qty),
    side: "sell",
    type: "trailing_stop",
    time_in_force: "gtc",
    trail_percent: trailPercent.toFixed(1),
  });
  return r.data;
}

export async function cancelOrder(orderId: string) {
  await alpaca.delete(`/v2/orders/${orderId}`);
}

export async function getOrders(status = "open") {
  const r = await alpaca.get("/v2/orders", { params: { status, limit: 50 } });
  return r.data;
}

// ── Market Data ────────────────────────────────────────────────────────────
export async function getBars(
  symbol: string,
  timeframe: string,
  limit: number = 100
) {
  const end = new Date().toISOString();
  // SIP: wide 5-year window (paid plan handles it fine)
  const sipStart = new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000).toISOString();
  // IEX: sort=desc so newest bars come first, then reverse — ensures we always get the most recent bars
  // Window sized so we never hit the limit before reaching today
  // 15Min → 20 days, 1Hour → 90 days, Daily → 1 year
  const iexDays = timeframe === "15Min" ? 20 : timeframe === "1Hour" ? 90 : 365;
  const iexStart = new Date(Date.now() - iexDays * 24 * 60 * 60 * 1000).toISOString();

  // Try SIP feed first (requires paid subscription)
  try {
    const r = await alpacaData.get(`/v2/stocks/${symbol}/bars`, {
      params: { timeframe, limit, feed: "sip", start: sipStart, end },
    });
    if (r.data.bars && r.data.bars.length > 0) return r.data.bars;
  } catch {}

  // Fallback to IEX feed — sort desc so newest bars are first, then reverse for chart order
  try {
    const r = await alpacaData.get(`/v2/stocks/${symbol}/bars`, {
      params: { timeframe, limit, feed: "iex", sort: "desc", start: iexStart, end },
    });
    if (r.data.bars && r.data.bars.length > 0) {
      // Reverse so chart gets oldest→newest (ascending time order)
      return r.data.bars.slice().reverse();
    }
  } catch {}

  return [];
}

export async function getLatestQuote(symbol: string) {
  try {
    const r = await alpacaData.get(`/v2/stocks/${symbol}/quotes/latest`, {
      params: { feed: "iex" },
    });
    return r.data.quote;
  } catch {
    return null;
  }
}

export async function getLatestTrade(symbol: string) {
  try {
    const r = await alpacaData.get(`/v2/stocks/${symbol}/trades/latest`, {
      params: { feed: "iex" },
    });
    return r.data.trade;
  } catch {
    return null;
  }
}

export async function getSnapshot(symbol: string) {
  try {
    const r = await alpacaData.get(`/v2/stocks/${symbol}/snapshot`, {
      params: { feed: "iex" },
    });
    return r.data;
  } catch {
    return null;
  }
}

export async function getMultiSnapshots(symbols: string[]) {
  try {
    const r = await alpacaData.get("/v2/stocks/snapshots", {
      params: { symbols: symbols.join(","), feed: "iex" },
    });
    return r.data;
  } catch {
    return {};
  }
}

// ── Screener helpers ───────────────────────────────────────────────────────
export async function isMarketOpen(): Promise<boolean> {
  try {
    const r = await alpaca.get("/v2/clock");
    return r.data.is_open;
  } catch {
    return false;
  }
}

export async function getAsset(symbol: string) {
  try {
    const r = await alpaca.get(`/v2/assets/${symbol}`);
    return r.data;
  } catch {
    return null;
  }
}
