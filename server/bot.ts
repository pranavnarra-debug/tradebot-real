import { storage } from "./storage";
import {
  getAccount, placeMarketOrder,
  getBars, isMarketOpen
} from "./alpaca";
import {
  scanVolatile, scanSwing, scanLongterm, scanAll, reassessPosition,
  BUCKET_CONFIG, SignalResult,
  UNIVERSE, VOLATILE_UNIVERSE, SWING_UNIVERSE, LONGTERM_UNIVERSE
} from "./strategy";
import { Bar } from "./indicators";
import {
  fetchNewsForSymbol, fetchNewsForSymbols,
  analyzeNewsSentiment, applyNewsSentiment,
  isInCoolingPeriod, setCoolingPeriod, newsEntryBoost
} from "./news";

let botRunning = false;
let lastRunAt: string | null = null;
let lastRunStatus: string = "idle";
let circuitBreakerActive = false;
let circuitBreakerUntil: Date | null = null;

// ── Daily universe refresh ─────────────────────────────────────────────────
// Extra symbols discovered from top movers/volume, refreshed each trading day
let dynamicVolatileExtras: string[] = [];
let dynamicSwingExtras: string[] = [];
let lastUniverseRefresh: string | null = null;

// Known stable tickers to exclude from dynamic additions (indices, bad data, etc.)
const EXCLUDED_FROM_DYNAMIC = new Set([
  "SPY", "QQQ", "IWM", "DIA", "VXX", "UVXY", "SVXY",
  "SQQQ", "SPXS", "SDOW", "SRTY"
]);

export async function refreshDynamicUniverse() {
  try {
    // Only refresh once per trading day
    const today = new Date().toDateString();
    if (lastUniverseRefresh === today) return;

    console.log("[BOT] Refreshing dynamic universe...");

    // Pull top 50 most active stocks from Alpaca
    const ALPACA_KEY = process.env.ALPACA_API_KEY || "PKCBITI3AV45CSDZ3JEATZLH7L";
    const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY || "CoEJFXcy6pSjN52i63fn2nwHj62qZfNea6M95GAcvhfm";
    const BASE = process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";

    const resp = await fetch(
      `${BASE}/v2/stocks/most_active?top=50&by=volume`,
      { headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET } }
    ).catch(() => null);

    if (!resp || !resp.ok) {
      console.log("[BOT] Could not fetch most active — skipping dynamic universe refresh");
      return;
    }

    const data = await resp.json();
    const mostActive: string[] = (data?.most_actives || data?.symbols || []).map((s: any) =>
      typeof s === "string" ? s : s.symbol
    );

    const allKnown = new Set([...UNIVERSE]);

    // New volatile extras: high-volume tickers not already in any universe
    const newVolatile = mostActive
      .filter(s => s && s.length <= 5 && !allKnown.has(s) && !EXCLUDED_FROM_DYNAMIC.has(s))
      .slice(0, 10);

    // Pull gainers for swing extras
    const gainResp = await fetch(
      `${BASE}/v2/stocks/gainers?top=30`,
      { headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET } }
    ).catch(() => null);

    let newSwing: string[] = [];
    if (gainResp && gainResp.ok) {
      const gainData = await gainResp.json();
      const gainers: string[] = (gainData?.gainers || gainData?.symbols || []).map((s: any) =>
        typeof s === "string" ? s : s.symbol
      );
      newSwing = gainers
        .filter(s => s && s.length <= 5 && !allKnown.has(s) && !EXCLUDED_FROM_DYNAMIC.has(s))
        .slice(0, 8);
    }

    dynamicVolatileExtras = newVolatile;
    dynamicSwingExtras = newSwing;
    lastUniverseRefresh = today;

    console.log(`[BOT] Dynamic universe refreshed — volatile extras: [${newVolatile.join(", ")}], swing extras: [${newSwing.join(", ")}]`);
  } catch (e) {
    console.error("[BOT] Dynamic universe refresh error:", e);
  }
}

export function getDynamicExtras() {
  return { volatileExtras: dynamicVolatileExtras, swingExtras: dynamicSwingExtras, lastRefresh: lastUniverseRefresh };
}

export function getBotStatus() {
  return { botRunning, lastRunAt, lastRunStatus, circuitBreakerActive, circuitBreakerUntil };
}

export function setBotRunning(val: boolean) { botRunning = val; }

// ── Main bot loop ──────────────────────────────────────────────────────────
export async function runBotCycle(): Promise<string> {
  if (!botRunning) return "Bot is paused";

  try {
    const open = await isMarketOpen();
    if (!open) {
      lastRunStatus = "Market closed — skipping cycle";
      lastRunAt = new Date().toISOString();
      return lastRunStatus;
    }

    // Circuit breaker check
    if (circuitBreakerActive && circuitBreakerUntil && new Date() < circuitBreakerUntil) {
      lastRunStatus = `Circuit breaker active until ${circuitBreakerUntil.toISOString()}`;
      return lastRunStatus;
    } else {
      circuitBreakerActive = false;
    }

    const account = await getAccount();
    const totalEquity = parseFloat(account.equity);
    const buyingPower = parseFloat(account.buying_power);

    // Check daily drawdown
    const dailyPnl = parseFloat(account.equity) - parseFloat(account.last_equity);
    const dailyPnlPct = dailyPnl / parseFloat(account.last_equity);
    if (dailyPnlPct < -0.05) {
      circuitBreakerActive = true;
      circuitBreakerUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await storage.setConfig("circuit_breaker", circuitBreakerUntil.toISOString());
      lastRunStatus = `CIRCUIT BREAKER: Daily loss ${(dailyPnlPct * 100).toFixed(2)}% — halting new entries for 24h`;
      lastRunAt = new Date().toISOString();
      return lastRunStatus;
    }

    // Get SPY bars for relative strength calc
    const spyBars: Bar[] = await getBars("SPY", "1Day", 150);

    // Refresh dynamic universe once per day (near open)
    await refreshDynamicUniverse();

    // ── Step 1: Fetch news for all open positions ─────────────────────────
    const openPositions = await storage.getOpenPositions();
    const openSymbols = openPositions.map(p => p.symbol);
    const newsMap = openSymbols.length
      ? await fetchNewsForSymbols(openSymbols, 24)
      : {};

    // ── Step 2: Reassess open positions ───────────────────────────────────
    for (const pos of openPositions) {
      try {
        const { conviction, shouldSell, reason, currentPrice, indicators } =
          await reassessPosition(
            pos.symbol,
            pos.bucket as "volatile" | "swing" | "longterm",
            pos.entryPrice,
            pos.peakPrice || pos.entryPrice,
            pos.openedAt
          );

        // Apply news sentiment to conviction
        const posNews = newsMap[pos.symbol] || [];
        const sentiment = analyzeNewsSentiment(posNews);
        const newsAdjustedConviction = applyNewsSentiment(conviction, sentiment);

        // Set cooling period if strongly negative news
        if (sentiment.coolingPeriodHours > 0) {
          setCoolingPeriod(pos.symbol, sentiment.coolingPeriodHours);
        }

        // Log news signal if significant
        if (Math.abs(sentiment.convictionDelta) >= 8) {
          const signalType = sentiment.convictionDelta > 0 ? "conviction_boost" : "conviction_drop";
          await storage.logSignal({
            symbol: pos.symbol,
            bucket: pos.bucket,
            signalType,
            details: JSON.stringify({
              reason: `News: ${sentiment.summary}`,
              headlines: sentiment.headlines.slice(0, 2),
              convictionDelta: sentiment.convictionDelta,
              newConviction: newsAdjustedConviction,
              newsLabel: sentiment.label,
            }),
            createdAt: new Date().toISOString(),
          });
        }

        // Update peak price and conviction
        if (currentPrice > (pos.peakPrice || 0)) {
          await storage.updatePosition(pos.id, { peakPrice: currentPrice, currentPrice, convictionScore: newsAdjustedConviction });
        } else {
          await storage.updatePosition(pos.id, { currentPrice, convictionScore: newsAdjustedConviction });
        }

        // News sentiment: ONLY block new entries — never force-exit open positions
        // (news exits caused too many premature sells at small losses)
        const cfg = BUCKET_CONFIG[pos.bucket as "volatile" | "swing" | "longterm"];

        // Only shouldSell from reassessPosition drives exits (no news exits)
        const finalShouldSell = shouldSell;
        const finalReason = reason;

        if (finalShouldSell) {
          // ── PDT / minimum hold protection ─────────────────────────────────
          // Volatile: never sell before 24h to avoid pattern day trader flag.
          // Hard stop-loss is the only exception (crash protection).
          const holdHours = (Date.now() - new Date(pos.openedAt).getTime()) / 3600000;
          const minHold = cfg.minHoldHours ?? 0;
          const isHardStop = finalReason.includes("Hard stop loss hit");

          if (holdHours < minHold && !isHardStop) {
            await storage.logSignal({
              symbol: pos.symbol, bucket: pos.bucket, signalType: "hold",
              details: JSON.stringify({
                reason: `Min hold not reached (${holdHours.toFixed(1)}h / ${minHold}h). Will exit when eligible.`,
                currentPrice,
              }),
              createdAt: new Date().toISOString(),
            });
            await storage.updatePosition(pos.id, { currentPrice });
            continue;
          }

          try {
            await placeMarketOrder(pos.symbol, pos.shares, "sell");
          } catch (e: any) {
            console.error(`Failed to sell ${pos.symbol}:`, e?.message);
          }

          const pnl = (currentPrice - pos.entryPrice) * pos.shares;
          const pnlPct = (currentPrice - pos.entryPrice) / pos.entryPrice * 100;
          const durationHours = (Date.now() - new Date(pos.openedAt).getTime()) / 3600000;

          // 48h cooldown after any stop-loss hit (prevents re-entering same losing ticker)
          if (isHardStop) {
            const cooldownHours = cfg.stopLossCooldownHours ?? 48;
            setCoolingPeriod(pos.symbol, cooldownHours);
            console.log(`[BOT] ${pos.symbol} stop-loss hit — ${cooldownHours}h cooldown set`);
          }

          await storage.closePosition(pos.id, currentPrice, finalReason);
          await storage.createTrade({
            symbol: pos.symbol,
            bucket: pos.bucket,
            strategy: pos.strategy,
            shares: pos.shares,
            entryPrice: pos.entryPrice,
            exitPrice: currentPrice,
            pnl,
            pnlPct,
            entryReason: pos.entryReason,
            closeReason: finalReason,
            openedAt: pos.openedAt,
            closedAt: new Date().toISOString(),
            durationHours,
          });

          await storage.logSignal({
            symbol: pos.symbol,
            bucket: pos.bucket,
            signalType: "exit",
            details: JSON.stringify({ reason: finalReason, currentPrice, conviction: newsAdjustedConviction, indicators, newsLabel: sentiment.label }),
            createdAt: new Date().toISOString(),
          });
        }
      } catch (e) {
        console.error(`Error reassessing ${pos.symbol}:`, e);
      }
    }

    // ── Step 3: Scan for new entries ──────────────────────────────────────
    if (buyingPower < 100) {
      lastRunStatus = "Low buying power — skipping new entries";
      lastRunAt = new Date().toISOString();
      return lastRunStatus;
    }

    const currentOpenPositions = await storage.getOpenPositions();
    const bucketCounts = {
      volatile: currentOpenPositions.filter(p => p.bucket === "volatile").length,
      swing: currentOpenPositions.filter(p => p.bucket === "swing").length,
      longterm: currentOpenPositions.filter(p => p.bucket === "longterm").length,
    };

    // Scan all stocks against all 3 bucket strategies, get highest conviction per symbol
    const extraSymbols = [...dynamicVolatileExtras, ...dynamicSwingExtras];
    const allSignals = await scanAll(spyBars, extraSymbols);

    // 50% volatile / 50% swing — longterm disabled (maxPositions: 0)
    const volatileSignals = allSignals.filter(s => s.bucket === "volatile" && bucketCounts.volatile < BUCKET_CONFIG.volatile.maxPositions);
    const swingSignals = allSignals.filter(s => s.bucket === "swing" && bucketCounts.swing < BUCKET_CONFIG.swing.maxPositions);

    await processSignals(volatileSignals, totalEquity, buyingPower, bucketCounts.volatile, "volatile");
    await processSignals(swingSignals, totalEquity, buyingPower, bucketCounts.swing, "swing");

    // ── Step 4: Portfolio snapshot ────────────────────────────────────────
    const updatedPositions = await storage.getOpenPositions();
    const positionsValue = updatedPositions.reduce((s, p) => s + p.currentPrice * p.shares, 0);
    const cashValue = parseFloat(account.cash);

    await storage.createSnapshot({
      totalValue: totalEquity,
      cashValue,
      positionsValue,
      dailyPnl,
      totalPnl: totalEquity - 100000,
      volatileBucketValue: updatedPositions.filter(p => p.bucket === "volatile").reduce((s, p) => s + p.currentPrice * p.shares, 0),
      swingBucketValue: updatedPositions.filter(p => p.bucket === "swing").reduce((s, p) => s + p.currentPrice * p.shares, 0),
      longtermBucketValue: updatedPositions.filter(p => p.bucket === "longterm").reduce((s, p) => s + p.currentPrice * p.shares, 0),
      recordedAt: new Date().toISOString(),
    });

    lastRunStatus = `Cycle complete — ${updatedPositions.length} open positions`;
    lastRunAt = new Date().toISOString();
    return lastRunStatus;

  } catch (e: any) {
    lastRunStatus = `Error: ${e.message}`;
    lastRunAt = new Date().toISOString();
    return lastRunStatus;
  }
}

async function processSignals(
  signals: SignalResult[],
  totalEquity: number,
  buyingPower: number,
  currentCount: number,
  bucket: "volatile" | "swing" | "longterm"
) {
  const cfg = BUCKET_CONFIG[bucket];
  const maxNew = cfg.maxPositions - currentCount;
  if (maxNew <= 0) return;

  // Fetch news for all candidate symbols at once
  const candidateSymbols = signals.slice(0, maxNew + 3).map(s => s.symbol);
  const newsMap = candidateSymbols.length
    ? await fetchNewsForSymbols(candidateSymbols, 24)
    : {};

  const toEnter = signals.slice(0, maxNew + 3); // fetch a few extra, filter below

  let entered = 0;
  for (const sig of toEnter) {
    if (entered >= maxNew) break;

    // Skip if already in position
    const existing = await storage.getPositionBySymbolAndBucket(sig.symbol, sig.bucket);
    if (existing) continue;

    // Skip if in cooling period (recent negative news)
    if (isInCoolingPeriod(sig.symbol)) {
      await storage.logSignal({
        symbol: sig.symbol,
        bucket: sig.bucket,
        signalType: "entry",
        details: JSON.stringify({ skipped: true, reason: "In news cooling period — blocked from entry" }),
        createdAt: new Date().toISOString(),
      });
      continue;
    }

    // Analyze news for this symbol
    const sentiment = analyzeNewsSentiment(newsMap[sig.symbol] || []);

    // Block entry if negative news
    if (sentiment.shouldBlockEntry) {
      setCoolingPeriod(sig.symbol, sentiment.coolingPeriodHours);
      await storage.logSignal({
        symbol: sig.symbol,
        bucket: sig.bucket,
        signalType: "entry",
        details: JSON.stringify({ skipped: true, reason: `Blocked by news: ${sentiment.summary}`, newsLabel: sentiment.label, headlines: sentiment.headlines.slice(0, 2) }),
        createdAt: new Date().toISOString(),
      });
      continue;
    }

    // Apply news boost to conviction
    const newsAdjustedConviction = Math.min(100, sig.convictionScore + sentiment.convictionDelta);
    const newsReasons = sentiment.convictionDelta > 0
      ? [...sig.reasons, `📰 News boost (${sentiment.label}): ${sentiment.headlines[0] || sentiment.summary}`]
      : sig.reasons;

    const bucketAllocation = totalEquity * cfg.allocationPct;
    const tradeValue = bucketAllocation * cfg.positionSizePct;
    const shares = Math.floor(tradeValue / sig.entryPrice);
    if (shares < 1) continue;
    if (tradeValue > buyingPower) continue;

    try {
      const order = await placeMarketOrder(sig.symbol, shares, "buy").catch(() => null);

      await storage.createPosition({
        symbol: sig.symbol,
        bucket: sig.bucket,
        strategy: `${sig.bucket}-${sig.indicators.rsRating ? "canslim" : "momentum"}`,
        shares,
        entryPrice: sig.entryPrice,
        currentPrice: sig.entryPrice,
        stopLoss: sig.stopLoss,
        takeProfit: 9999,
        trailingStop: sig.entryPrice * (1 + cfg.trailingTrigger), // real price level where trailing activates
        convictionScore: newsAdjustedConviction,
        entryReason: JSON.stringify(newsReasons),
        status: "open",
        alpacaOrderId: order?.id || null,
        openedAt: new Date().toISOString(),
        peakPrice: sig.entryPrice,
      });

      await storage.logSignal({
        symbol: sig.symbol,
        bucket: sig.bucket,
        signalType: "entry",
        details: JSON.stringify({
          reasons: newsReasons,
          indicators: sig.indicators,
          shares,
          tradeValue,
          newsLabel: sentiment.label,
          newsConvictionDelta: sentiment.convictionDelta,
        }),
        createdAt: new Date().toISOString(),
      });

      entered++;
    } catch (e: any) {
      console.error(`Failed to open ${sig.symbol}:`, e?.message);
    }
  }
}
