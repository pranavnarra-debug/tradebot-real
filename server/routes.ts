import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { getAccount, getAlpacaPositions, getBars, getMultiSnapshots, isMarketOpen } from "./alpaca";
import { runBotCycle, getBotStatus, setBotRunning, getDynamicExtras, refreshDynamicUniverse } from "./bot";
import { fetchNewsForSymbol, analyzeNewsSentiment, isInCoolingPeriod, getCoolingPeriodEnd } from "./news";
import { sma, ema, rsi, macd, bollingerBands, volumeRatio, roc, relativeStrength } from "./indicators";
import { UNIVERSE, VOLATILE_UNIVERSE, SWING_UNIVERSE, LONGTERM_UNIVERSE, BUCKET_CONFIG } from "./strategy";

let botInterval: ReturnType<typeof setInterval> | null = null;

function startBotInterval() {
  if (botInterval) return;
  // Run every 5 minutes
  botInterval = setInterval(async () => {
    try { await runBotCycle(); } catch (e) { console.error("Bot cycle error:", e); }
  }, 5 * 60 * 1000);
}

export async function registerRoutes(httpServer: Server, app: Express) {
  // ── Account ──────────────────────────────────────────────────────────────
  app.get("/api/account", async (req, res) => {
    try {
      const account = await getAccount();
      const marketOpen = await isMarketOpen();
      res.json({ ...account, marketOpen });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Bot control ──────────────────────────────────────────────────────────
  app.get("/api/bot/status", (req, res) => {
    res.json(getBotStatus());
  });

  app.post("/api/bot/start", async (req, res) => {
    setBotRunning(true);
    await storage.setConfig("bot_running", "true");
    startBotInterval();
    const result = await runBotCycle();
    res.json({ ok: true, message: result });
  });

  app.post("/api/bot/stop", async (req, res) => {
    setBotRunning(false);
    await storage.setConfig("bot_running", "false");
    if (botInterval) { clearInterval(botInterval); botInterval = null; }
    res.json({ ok: true, message: "Bot stopped" });
  });

  app.post("/api/bot/run-now", async (req, res) => {
    try {
      const result = await runBotCycle();
      res.json({ ok: true, message: result });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Positions ────────────────────────────────────────────────────────────
  // ── Sync Alpaca → local DB on startup ────────────────────────────────────
  async function syncAlpacaPositions() {
    try {
      const alpacaPositions = await getAlpacaPositions();
      const localPositions = await storage.getOpenPositions();
      const localSymbols = new Set(localPositions.map((p: any) => p.symbol));

      for (const ap of alpacaPositions) {
        if (!localSymbols.has(ap.symbol)) {
          // Position exists in Alpaca but not locally — re-register it
          const entryPrice = parseFloat(ap.avg_entry_price);
          // Use market_value / qty for most accurate current price
          const qty = Math.abs(parseFloat(ap.qty));
          const currentPrice = ap.market_value && qty > 0
            ? parseFloat(ap.market_value) / qty
            : parseFloat(ap.current_price || ap.lastday_price || ap.avg_entry_price);
          const shares = Math.abs(parseFloat(ap.qty));
          // Guess bucket: high-beta/momentum = volatile, large growth = swing, else longterm
          const volatileSymbols = new Set(["NVDA","AMD","TSLA","MARA","RIOT","COIN","PLTR","SOFI","GME","AMC","SOXL","TQQQ","IONQ","RKLB","SMCI","HOOD","DKNG","LCID","UPST","SPXL"]);
          const swingSymbols = new Set(["AAPL","MSFT","GOOGL","META","AMZN","NFLX","CRM","NOW","SNOW","DDOG","PANW","CRWD","ZS","MDB","SHOP","TTD","HUBS","CELH","AFRM","NU"]);
          // Default unknown symbols to swing (longterm disabled)
          const bucket = volatileSymbols.has(ap.symbol) ? "volatile" : "swing";
          const cfg = BUCKET_CONFIG[bucket];
          // Try to recover real entry reasons by running a quick scan on this symbol
          let entryReasons: string[] = [];
          try {
            const { scanAll } = await import("./strategy");
            const signals = await scanAll([ap.symbol]);
            const sig = signals.find((s: any) => s.symbol === ap.symbol);
            if (sig?.reasons?.length) {
              entryReasons = sig.reasons;
            }
          } catch { /* ignore scan errors during sync */ }

          // Fall back to a descriptive reason with entry price if scan gives nothing
          if (!entryReasons.length) {
            entryReasons = [`Position recovered from Alpaca — entered @ $${entryPrice.toFixed(2)}`, `Bucket: ${bucket}`];
          }

          await storage.createPosition({
            symbol: ap.symbol,
            bucket,
            shares,
            entryPrice,
            currentPrice,
            stopLoss: entryPrice * (1 - cfg.stopLossPct),
            takeProfit: 9999,
            trailingStop: entryPrice * (1 + cfg.trailingTrigger),
            peakPrice: currentPrice,
            strategy: bucket,
            entryReason: JSON.stringify(entryReasons),
            status: "open",
            openedAt: new Date().toISOString(),
          });
          console.log(`[SYNC] Re-registered ${ap.symbol} from Alpaca (${shares} shares @ $${entryPrice})`);
        }
      }
    } catch (e) {
      console.error("[SYNC] Alpaca position sync failed:", e);
    }
  }
  // Fix any positions where trailingStop was stored as a ratio (< 1) instead of a price
  async function fixTrailingStopRatios() {
    try {
      const allPositions = await storage.getOpenPositions();
      for (const pos of allPositions) {
        if (pos.trailingStop && pos.trailingStop < 1) {
          const cfg = BUCKET_CONFIG[pos.bucket as "volatile" | "swing" | "longterm"];
          const corrected = pos.entryPrice * (1 + cfg.trailingTrigger);
          await storage.updatePosition(pos.id, { trailingStop: corrected });
          console.log(`[FIX] ${pos.symbol} trailingStop corrected: ${pos.trailingStop} → $${corrected.toFixed(2)}`);
        }
      }
    } catch (e) {
      console.error("[FIX] trailingStop migration failed:", e);
    }
  }

  // Migrate any existing longterm positions to swing on startup
  async function migrateLongtermToSwing() {
    try {
      const allPositions = await storage.getOpenPositions();
      const longtermPositions = allPositions.filter((p: any) => p.bucket === "longterm");
      for (const pos of longtermPositions) {
        const swingCfg = BUCKET_CONFIG.swing;
        await storage.updatePosition(pos.id, {
          bucket: "swing",
          strategy: "swing",
          stopLoss: pos.entryPrice * (1 - swingCfg.stopLossPct),
          takeProfit: 9999,
          trailingStop: pos.entryPrice * (1 + swingCfg.trailingTrigger),
        });
        console.log(`[MIGRATE] ${pos.symbol} longterm → swing`);
      }
      if (longtermPositions.length) {
        console.log(`[MIGRATE] Migrated ${longtermPositions.length} longterm position(s) to swing`);
      }
    } catch (e) {
      console.error("[MIGRATE] Longterm migration failed:", e);
    }
  }

  // Run startup fixes
  syncAlpacaPositions();
  migrateLongtermToSwing();
  fixTrailingStopRatios();

  app.post("/api/positions/sync", async (req, res) => {
    await syncAlpacaPositions();
    res.json({ ok: true, positions: await storage.getOpenPositions() });
  });

  app.get("/api/positions", async (req, res) => {
    const openPositions = await storage.getOpenPositions();
    res.json(openPositions);
  });

  // ── Background price refresher (runs every 60s regardless of market hours) ─
  // Keeps currentPrice up to date — uses Alpaca live positions first (matches Alpaca app AH price),
  // falls back to snapshots if position isn't in Alpaca (e.g. manually synced)
  async function refreshPositionPrices() {
    try {
      const openPositions = await storage.getOpenPositions();
      if (!openPositions.length) return;

      // Primary: pull live positions from Alpaca — this is exactly what the Alpaca app shows,
      // including after-hours prices (current_price on the position is always up to date)
      const alpacaPositions = await getAlpacaPositions().catch(() => []);
      const alpacaPriceMap: Record<string, number> = {};
      for (const ap of alpacaPositions) {
        const qty = parseFloat(ap.qty);
        if (qty > 0) {
          alpacaPriceMap[ap.symbol] = parseFloat(ap.current_price);
        }
      }

      // Fallback: snapshots for any positions not found in Alpaca live feed
      const missingSymbols = openPositions
        .filter((p: any) => !alpacaPriceMap[p.symbol])
        .map((p: any) => p.symbol);
      const snapshots = missingSymbols.length
        ? await getMultiSnapshots(missingSymbols).catch(() => ({}))
        : {};

      await Promise.all(openPositions.map(async (pos) => {
        try {
          // Use Alpaca live price (matches Alpaca app exactly, including AH)
          const latestPrice =
            alpacaPriceMap[pos.symbol] ??
            (() => {
              const snap = (snapshots as any)[pos.symbol];
              return snap?.latestTrade?.p || snap?.minuteBar?.c || snap?.dailyBar?.c;
            })();

          if (latestPrice && Math.abs(latestPrice - pos.currentPrice) > 0.001) {
            await storage.updatePosition(pos.id, {
              currentPrice: latestPrice,
              peakPrice: Math.max(latestPrice, pos.peakPrice || pos.entryPrice),
            });
          }
        } catch { /* skip individual failures */ }
      }));
    } catch { /* skip */ }
  }
  // Start refreshing immediately and then every 60 seconds
  refreshPositionPrices();
  setInterval(refreshPositionPrices, 60_000);

  app.delete("/api/positions/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const pos = await storage.getOpenPositions().find(p => p.id === id);
      if (!pos) return res.status(404).json({ error: "Position not found" });
      const { getLatestTrade } = await import("./alpaca");
      const trade = await getLatestTrade(pos.symbol);
      const price = trade?.p || pos.currentPrice;
      const { placeMarketOrder } = await import("./alpaca");
      await placeMarketOrder(pos.symbol, pos.shares, "sell").catch(() => {});
      const pnl = (price - pos.entryPrice) * pos.shares;
      const pnlPct = (price - pos.entryPrice) / pos.entryPrice * 100;
      const durationHours = (Date.now() - new Date(pos.openedAt).getTime()) / 3600000;
      await storage.closePosition(id, price, "Manual close by user");
      await storage.createTrade({
        symbol: pos.symbol, bucket: pos.bucket, strategy: pos.strategy,
        shares: pos.shares, entryPrice: pos.entryPrice, exitPrice: price,
        pnl, pnlPct, entryReason: pos.entryReason, closeReason: "Manual close",
        openedAt: pos.openedAt, closedAt: new Date().toISOString(), durationHours,
      });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Trades history ───────────────────────────────────────────────────────
  app.get("/api/trades", async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 100;
    res.json(await storage.getTrades(limit));
  });

  // ── Signals ──────────────────────────────────────────────────────────────
  app.get("/api/signals", async (req, res) => {
    res.json(await storage.getRecentSignals(50));
  });

  // ── Snapshots (portfolio history) ────────────────────────────────────────
  app.get("/api/snapshots", async (req, res) => {
    res.json((await storage.getSnapshots(100)).reverse());
  });

  // ── Chart data ───────────────────────────────────────────────────────────
  app.get("/api/chart/:symbol", async (req, res) => {
    try {
      const { symbol } = req.params;
      const timeframe = (req.query.timeframe as string) || "1Day";
      const limit = parseInt(req.query.limit as string) || 120;
      const bars = await getBars(symbol, timeframe, limit);
      res.json(bars);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Universe info ──────────────────────────────────────────────────────────
  app.get("/api/universe", async (req, res) => {
    const extras = getDynamicExtras();
    res.json({
      universe: UNIVERSE,
      total: UNIVERSE.length,
      dynamicExtras: [...extras.volatileExtras, ...extras.swingExtras],
      lastRefreshed: extras.lastRefresh,
    });
  });

  app.post("/api/universe/refresh", async (req, res) => {
    try {
      await refreshDynamicUniverse();
      const extras = getDynamicExtras();
      res.json({ ok: true, ...extras });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Scan (manual trigger) ──────────────────────────────────────────────────────────────
  app.get("/api/scan/:bucket", async (req, res) => {
    try {
      const bucket = req.params.bucket as "volatile" | "swing" | "longterm";
      const { getBars } = await import("./alpaca");
      const spyBars = await getBars("SPY", "1Day", 150);
      let signals;
      if (bucket === "volatile") {
        const { scanVolatile } = await import("./strategy");
        signals = await scanVolatile(spyBars);
      } else if (bucket === "swing") {
        const { scanSwing } = await import("./strategy");
        signals = await scanSwing(spyBars);
      } else {
        const { scanLongterm } = await import("./strategy");
        signals = await scanLongterm(spyBars);
      }
      res.json(signals);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Stock Research ──────────────────────────────────────────────────────
  app.get("/api/research/:symbol", async (req, res) => {
    try {
      const symbol = req.params.symbol.toUpperCase().trim();
      const requestedBucket = req.query.bucket as string | undefined;

      // Determine which bucket this symbol belongs to (if any)
      // Any ticker can be searched — unknown symbols are scanned with swing logic as best-effort
      let bucket: "volatile" | "swing" | "longterm" | "unknown" = "unknown";
      if (requestedBucket === "volatile") bucket = "volatile";
      else if (requestedBucket === "swing") bucket = "swing";
      else if (requestedBucket === "longterm") bucket = "longterm";
      else if (VOLATILE_UNIVERSE.includes(symbol)) bucket = "volatile";
      else if (SWING_UNIVERSE.includes(symbol)) bucket = "swing";
      else if (LONGTERM_UNIVERSE.includes(symbol)) bucket = "longterm";
      // For unknown symbols with no bucket requested, default to swing analysis (daily bars, full indicators)
      const effectiveBucket = bucket === "unknown" ? "swing" : bucket;

      // Timeframe based on bucket (override respected)
      const timeframe = (requestedBucket === "volatile" || (!requestedBucket && bucket === "volatile")) ? "15Min" : "1Day";

      // Fetch full chart history (500 bars) — chart shows all of it
      // Signal evaluation uses only the recent relevant window per bucket
      const CHART_LIMIT = 500;
      const EVAL_WINDOW = effectiveBucket === "volatile" ? 60 : effectiveBucket === "longterm" ? 500 : 200;

      // Fetch bars + SPY for relative strength
      const [bars, spyBars, newsItems] = await Promise.all([
        getBars(symbol, timeframe, CHART_LIMIT),
        getBars("SPY", "1Day", 200),
        fetchNewsForSymbol(symbol, 72),
      ]);

      // If Alpaca returned too few bars, retry with a smaller window
      let finalBars = bars;
      if (!finalBars || finalBars.length < 20) {
        finalBars = await getBars(symbol, timeframe, 100).catch(() => []);
      }
      if (!finalBars || finalBars.length < 5) {
        return res.status(404).json({ error: `No price data available for ${symbol}. The market may be closed, or this ticker may be unavailable on Alpaca paper trading.` });
      }

      // Chart gets the full history; signals evaluate only the recent window
      const chartBarsAll = finalBars;
      const evalBars = finalBars.slice(-EVAL_WINDOW);

      const closes = evalBars.map((b: any) => b.c);
      const curPrice = closes[closes.length - 1];

      // Compute indicators
      const rsiVals = rsi(closes, 14);
      const curRsi = rsiVals[rsiVals.length - 1];
      const prevRsi = rsiVals[rsiVals.length - 2];
      const { macdLine, signalLine, histogram } = macd(closes);
      const curMacd = macdLine[macdLine.length - 1];
      const curSignal = signalLine[signalLine.length - 1];
      const curHist = histogram[histogram.length - 1];
      const prevHist = histogram[histogram.length - 2];
      const volRatio = volumeRatio(evalBars, 20);
      const curVolRatio = volRatio[volRatio.length - 1];
      const ema9vals = ema(closes, 9);
      const ema21vals = ema(closes, 21);
      const sma50vals = sma(closes, 50);
      const sma200vals = closes.length >= 200 ? sma(closes, 200) : null;
      const bb = bollingerBands(closes, 20, 2);
      const rocVals = roc(closes, effectiveBucket === "volatile" ? 5 : 20);
      const curRoc = rocVals[rocVals.length - 1];
      const rsRating = spyBars.length > 60 ? relativeStrength(bars, spyBars, 63) : 50;

      const curEma9  = ema9vals[ema9vals.length - 1];
      const curEma21 = ema21vals[ema21vals.length - 1];
      const curSma50 = sma50vals[sma50vals.length - 1];
      const curSma200 = sma200vals ? sma200vals[sma200vals.length - 1] : null;
      const prevSma50 = sma50vals[sma50vals.length - 5];
      const bbMid = bb.middle[bb.middle.length - 1];
      const bbUpper = bb.upper[bb.upper.length - 1];
      const bbLower = bb.lower[bb.lower.length - 1];

      // News sentiment
      const sentiment = analyzeNewsSentiment(newsItems);
      const coolingActive = isInCoolingPeriod(symbol);
      const coolingUntil = getCoolingPeriodEnd(symbol);

      // Build signal evaluation — check each signal and whether it passed or failed
      const signals: { name: string; passed: boolean; detail: string; score: number }[] = [];

      // RSI zone
      if (effectiveBucket === "volatile") {
        const passed = curRsi > 58 && curRsi < 75;
        const recovery = prevRsi < 35 && curRsi > prevRsi + 5;
        signals.push({ name: "RSI Momentum Zone", passed: passed || recovery, score: passed ? 1 : recovery ? 2 : 0, detail: passed ? `RSI ${curRsi.toFixed(1)} is in the 58–75 momentum zone` : recovery ? `RSI recovering from oversold: ${prevRsi.toFixed(1)} → ${curRsi.toFixed(1)}` : `RSI ${curRsi.toFixed(1)} is outside 58–75 momentum zone` });
      } else {
        const passed = curRsi > 52 && curRsi < 68;
        const recovery = prevRsi < 38 && curRsi > prevRsi + 5;
        signals.push({ name: "RSI Momentum Zone", passed: passed || recovery, score: passed ? 1 : recovery ? 2 : 0, detail: passed ? `RSI ${curRsi.toFixed(1)} is healthy (52–68)` : recovery ? `RSI recovering from oversold: ${prevRsi.toFixed(1)} → ${curRsi.toFixed(1)}` : `RSI ${curRsi.toFixed(1)} is outside healthy zone (52–68)` });
      }

      // MACD
      const macdCross = curHist > 0 && prevHist <= 0;
      const macdPos = curHist > 0;
      signals.push({ name: "MACD Signal", passed: macdPos, score: macdCross ? 2 : macdPos ? 1 : 0, detail: macdCross ? `MACD bullish crossover (histogram flipped positive)` : macdPos ? `MACD positive momentum (${curMacd.toFixed(3)})` : `MACD negative (${curMacd.toFixed(3)}) — bearish momentum` });

      // Volume
      const volHigh = curVolRatio > 2.5;
      const volAbove = curVolRatio > 1.5;
      signals.push({ name: "Volume Surge", passed: volAbove, score: volHigh ? 2 : volAbove ? 1 : 0, detail: volHigh ? `Volume surge ${curVolRatio.toFixed(1)}x average — strong institutional interest` : volAbove ? `Above-average volume ${curVolRatio.toFixed(1)}x` : `Volume ${curVolRatio.toFixed(1)}x average — below threshold (need 1.5x+)` });

      // EMA stack
      const emaStack = curEma9 > curEma21 && curPrice > curEma9;
      signals.push({ name: "EMA Alignment (9/21)", passed: emaStack, score: emaStack ? 1 : 0, detail: emaStack ? `Price > EMA9 > EMA21 — bullish stack confirmed` : `EMA stack not aligned. Price: $${curPrice.toFixed(2)}, EMA9: $${curEma9.toFixed(2)}, EMA21: $${curEma21.toFixed(2)}` });

      // SMA 50
      const aboveSma50 = curPrice > curSma50;
      signals.push({ name: "Price vs 50-day SMA", passed: aboveSma50, score: aboveSma50 ? 1 : 0, detail: aboveSma50 ? `Price $${curPrice.toFixed(2)} is above 50-day SMA $${curSma50.toFixed(2)}` : `Price $${curPrice.toFixed(2)} is below 50-day SMA $${curSma50.toFixed(2)} — short-term downtrend` });

      // SMA 200
      if (curSma200) {
        const above200 = curPrice > curSma200;
        const near200 = curPrice > curSma200 * 0.92;
        signals.push({ name: "Price vs 200-day SMA", passed: above200 || near200, score: above200 ? 1 : near200 ? 1 : 0, detail: above200 ? `Price $${curPrice.toFixed(2)} above 200-day SMA $${curSma200.toFixed(2)} — long-term uptrend` : near200 ? `Price within 8% of 200-day SMA — correction, not breakdown (${((curPrice/curSma200-1)*100).toFixed(1)}%)` : `Price $${curPrice.toFixed(2)} is ${((curPrice/curSma200-1)*100).toFixed(1)}% below 200-day SMA $${curSma200.toFixed(2)} — major downtrend` });
      }

      // Golden cross
      if (curSma200) {
        const goldenCross = prevSma50 <= (sma200vals![sma200vals!.length - 5]) && curSma50 > curSma200;
        const above = curSma50 > curSma200;
        signals.push({ name: "Golden Cross (50/200 SMA)", passed: above, score: goldenCross ? 3 : above ? 1 : 0, detail: goldenCross ? `Golden cross just triggered — 50-SMA crossed above 200-SMA` : above ? `50-day SMA above 200-day SMA — long-term uptrend intact` : `50-day SMA below 200-day SMA — death cross / long-term downtrend` });
      }

      // Bollinger Bands
      const atLower = curPrice <= bbLower * 1.01;
      const betweenLowerMid = curPrice > bbLower && curPrice < bbMid;
      signals.push({ name: "Bollinger Band Position", passed: atLower || betweenLowerMid, score: atLower ? 1 : betweenLowerMid ? 1 : 0, detail: atLower ? `Price at/near lower Bollinger Band — extreme oversold dip entry` : betweenLowerMid ? `Price between lower band and midline — dip entry opportunity` : curPrice > bbUpper ? `Price above upper Bollinger Band — overbought, poor entry` : `Price near midline — neutral Bollinger Band position` });

      // ROC momentum
      const rocStrong = curRoc > (effectiveBucket === "volatile" ? 2 : 15);
      const rocPos = curRoc > (effectiveBucket === "volatile" ? 1 : 8);
      signals.push({ name: "Price Momentum (ROC)", passed: rocPos || rocStrong, score: rocStrong ? 2 : rocPos ? 1 : 0, detail: rocStrong ? `Strong momentum: ${curRoc.toFixed(1)}% over recent period` : rocPos ? `Positive momentum: ${curRoc.toFixed(1)}%` : `Weak/negative momentum: ${curRoc.toFixed(1)}% — trend not confirmed` });

      // Relative Strength
      if (effectiveBucket !== "volatile") {
        const rsTop = rsRating > 80;
        const rsAbove = rsRating > 65;
        signals.push({ name: "Relative Strength vs SPY", passed: rsAbove, score: rsTop ? 2 : rsAbove ? 1 : 0, detail: rsTop ? `RS Rating ${rsRating.toFixed(0)} — top market leader` : rsAbove ? `RS Rating ${rsRating.toFixed(0)} — outperforming market` : `RS Rating ${rsRating.toFixed(0)} — underperforming the S&P 500` });
      }

      // News sentiment as a signal
      const newsGood = sentiment.convictionDelta > 0;
      const newsBad = sentiment.shouldBlockEntry;
      signals.push({ name: "News Sentiment", passed: !newsBad, score: newsGood ? 1 : newsBad ? -2 : 0, detail: `${sentiment.summary} (score: ${sentiment.score > 0 ? "+" : ""}${sentiment.score})` });

      // Compute total score and threshold — MUST stay in sync with strategy.ts v5.3
      const totalScore = signals.reduce((s, sig) => s + (sig.score > 0 ? sig.score : 0), 0);
      const threshold = effectiveBucket === "volatile" ? 6 : 7;    // v5.3: volatile 5→6
      const minReasons = effectiveBucket === "volatile" ? 3 : 5;
      const volGateR = effectiveBucket === "volatile" ? 2.0 : 1.6;  // v5.3: volatile 1.8→2.0

      // Hard gates — identical to strategy.ts scanVolatile
      const rsiSig = signals.find(s => s.name === "RSI Momentum Zone");
      const hardRsiR = rsiSig?.passed ?? false;
      const hardVolR = curVolRatio > volGateR;
      const hardMomR = effectiveBucket !== "volatile" || curRoc > 2.0;  // v5.3: 1.5→2.0
      const hardMacdR = effectiveBucket !== "volatile" || curHist > 0;  // v5.3: MACD positive required
      const passedReasonCount = signals.filter(s => s.passed).length;
      const hardGatesPassedR = hardRsiR && hardVolR && hardMomR && hardMacdR;

      // Score + hard gates are independent checks — both must pass
      const scorePass = totalScore >= threshold && passedReasonCount >= minReasons;
      const wouldBuy = scorePass && hardGatesPassedR && !sentiment.shouldBlockEntry && !coolingActive;
      const convictionScore = Math.min(95, 50 + totalScore * 5);

      // Build skip reasons — surface hard gate failures even when score passes
      const skipReasons: string[] = [];
      if (!wouldBuy) {
        if (coolingActive) skipReasons.push(`Ticker in cooldown period — blocked after recent stop-loss hit`);
        if (sentiment.shouldBlockEntry) skipReasons.push(`Blocked by negative news (score: ${sentiment.score})`);
        if (totalScore < threshold) skipReasons.push(`Score ${totalScore}/${threshold} — need ${threshold - totalScore} more point(s)`);
        else if (passedReasonCount < minReasons) skipReasons.push(`Only ${passedReasonCount}/${minReasons} signals passed (score ${totalScore} ≥ ${threshold} but need more signals)`);
        // Hard gates — these block even when score passes
        if (!hardRsiR) {
          const zone = effectiveBucket === "volatile" ? "58–72" : "52–68";
          skipReasons.push(`Hard gate FAILED: RSI ${curRsi.toFixed(1)} outside ${zone} zone (score passes, but RSI gate is required)`);
        }
        if (!hardVolR) skipReasons.push(`Hard gate FAILED: Volume ${curVolRatio.toFixed(1)}x below required ${volGateR}x (score passes, but volume gate is required)`);
        if (!hardMomR) skipReasons.push(`Hard gate FAILED: ROC ${curRoc?.toFixed(1) ?? "?"}% below 2.0% required`);
        if (!hardMacdR) skipReasons.push(`Hard gate FAILED: MACD histogram negative — no entry against bearish MACD`);
        const failedSignals = signals.filter(s => !s.passed && s.score === 0).map(s => s.name);
        if (failedSignals.length && skipReasons.length < 4) skipReasons.push(`Failed signals: ${failedSignals.join(", ")}`);
      }

      res.json({
        symbol,
        bucket,
        effectiveBucket,
        inUniverse: bucket !== "unknown",
        currentPrice: curPrice,
        wouldBuy,
        convictionScore: wouldBuy ? convictionScore : 0,
        totalScore,
        threshold,
        skipReasons,
        signals,
        indicators: {
          rsi: curRsi,
          macd: curMacd,
          macdSignal: curSignal,
          macdHistogram: curHist,
          volumeRatio: curVolRatio,
          ema9: curEma9,
          ema21: curEma21,
          sma50: curSma50,
          sma200: curSma200,
          bbUpper,
          bbMid,
          bbLower,
          roc: curRoc,
          rsRating,
        },
        news: newsItems.slice(0, 8).map((n: any) => ({
          headline: n.headline,
          summary: n.summary,
          source: n.source,
          url: n.url,
          createdAt: n.created_at,
          sentiment: (() => {
            const text = (n.headline + " " + (n.summary || "")).toLowerCase();
            if (["fraud","bankruptcy","bankrupt","delisted","chapter 11"].some(kw => text.includes(kw))) return "strongly_negative";
            if (["earnings miss","downgrade","layoffs","revenue decline"].some(kw => text.includes(kw))) return "moderately_negative";
            if (["uncertainty","headwinds","cautious"].some(kw => text.includes(kw))) return "mildly_negative";
            if (["fda approved","acquisition","earnings beat","record revenue"].some(kw => text.includes(kw))) return "strongly_positive";
            if (["beats estimates","upgrade","raised guidance","outperform"].some(kw => text.includes(kw))) return "moderately_positive";
            if (["partnership","new product","expansion"].some(kw => text.includes(kw))) return "mildly_positive";
            return "neutral";
          })(),
        })),
        newsSentiment: sentiment,
        coolingActive,
        coolingUntil,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Research: Force scan + trade if valid ───────────────────────────────
  app.post("/api/research/:symbol/trade", async (req, res) => {
    try {
      const symbol = req.params.symbol.toUpperCase().trim();
      const { bucket: requestedBucket, timeframe: requestedTf } = req.body as { bucket?: string; timeframe?: string };

      // Determine bucket — longterm removed, all go to volatile or swing
      let bucket: "volatile" | "swing" = "volatile";
      if (requestedBucket === "swing" || SWING_UNIVERSE.includes(symbol)) bucket = "swing";
      else if (requestedBucket === "volatile" || VOLATILE_UNIVERSE.includes(symbol)) bucket = "volatile";

      const cfg = BUCKET_CONFIG[bucket];
      const timeframe = requestedTf || (bucket === "volatile" ? "15Min" : "1Day");
      const barLimit = 150;

      const [bars, spyBars, newsItems] = await Promise.all([
        getBars(symbol, timeframe, barLimit),
        getBars("SPY", "1Day", 150),
        fetchNewsForSymbol(symbol, 72),
      ]);

      if (!bars || bars.length < 20) {
        return res.status(404).json({ ok: false, reason: `No price data for ${symbol}` });
      }

      const closes = bars.map((b: any) => b.c);
      const curPrice = closes[closes.length - 1];

      // Run indicators
      const rsiVals = rsi(closes, 14);
      const curRsi = rsiVals[rsiVals.length - 1];
      const prevRsi = rsiVals[rsiVals.length - 2];
      const { histogram } = macd(closes);
      const curHist = histogram[histogram.length - 1];
      const prevHist = histogram[histogram.length - 2];
      const volRatio = volumeRatio(bars, 20);
      const curVolRatio = volRatio[volRatio.length - 1];
      const ema9v = ema(closes, 9);
      const ema21v = ema(closes, 21);
      const sma50v = sma(closes, 50);
      const sma200v = closes.length >= 200 ? sma(closes, 200) : null;
      const rocVals = roc(closes, bucket === "volatile" ? 5 : 20);
      const curRoc = rocVals[rocVals.length - 1];
      const rsRating = spyBars.length > 60 ? relativeStrength(bars, spyBars, 63) : 50;

      const sentiment = analyzeNewsSentiment(newsItems);
      const coolingActive = isInCoolingPeriod(symbol);

      // Score the stock (same logic as scanner)
      let score = 0;
      const reasons: string[] = [];

      // RSI (v4.3 gates)
      const rsiOk = bucket === "volatile" ? (curRsi > 58 && curRsi < 75) : bucket === "swing" ? (curRsi > 52 && curRsi < 68) : (curRsi > 45 && curRsi < 65);
      const rsiRecovery = bucket === "volatile" ? (prevRsi < 35 && curRsi > prevRsi + 5) : (prevRsi < 38 && curRsi > prevRsi + 5);
      if (rsiOk) { reasons.push(`RSI ${curRsi.toFixed(1)} in momentum zone`); score++; }
      else if (rsiRecovery) { reasons.push(`RSI recovery bounce ${prevRsi.toFixed(1)} → ${curRsi.toFixed(1)}`); score += 2; }

      // MACD
      if (curHist > 0 && prevHist <= 0) { reasons.push("MACD bullish crossover"); score += 2; }
      else if (curHist > 0) { reasons.push(`MACD positive (${curHist.toFixed(4)})`); score++; }

      // Volume (v4.3 gates)
      const volGate = bucket === "volatile" ? 1.8 : bucket === "swing" ? 1.6 : 1.2;
      if (curVolRatio > volGate * 1.5) { reasons.push(`Volume surge ${curVolRatio.toFixed(1)}x`); score += 2; }
      else if (curVolRatio > volGate) { reasons.push(`Above-avg volume ${curVolRatio.toFixed(1)}x`); score++; }

      // EMA stack
      if (ema9v[ema9v.length-1] > ema21v[ema21v.length-1] && curPrice > ema9v[ema9v.length-1]) {
        reasons.push("Price > EMA9 > EMA21 bullish stack"); score++;
      }

      // SMA 50
      if (curPrice > sma50v[sma50v.length-1]) { reasons.push(`Above 50-SMA`); score++; }

      // SMA 200
      if (sma200v) {
        const cur200 = sma200v[sma200v.length-1];
        if (curPrice > cur200) { reasons.push("Above 200-SMA"); score++; }
        else if (curPrice > cur200 * 0.92) { reasons.push("Within 8% of 200-SMA (correction)"); score++; }
      }

      // ROC
      const rocThresh = bucket === "volatile" ? 1 : 8;
      if (curRoc > rocThresh * 2) { reasons.push(`Strong momentum ${curRoc.toFixed(1)}%`); score += 2; }
      else if (curRoc > rocThresh) { reasons.push(`Positive momentum ${curRoc.toFixed(1)}%`); score++; }

      // RS
      if (bucket !== "volatile" && rsRating > 65) { reasons.push(`RS Rating ${rsRating.toFixed(0)}`); score++; }

      // News boost
      if (sentiment.label === "strongly_positive") score += 2;
      else if (sentiment.label === "moderately_positive") score += 1;

      const threshold = bucket === "volatile" ? 5 : bucket === "swing" ? 7 : 5;
      const minReasons = bucket === "volatile" ? 3 : bucket === "swing" ? 5 : 4;
      // Hard gates
      const hardRsi = rsiOk || rsiRecovery;
      const hardVol = curVolRatio > volGate;
      const hardMomentum = bucket !== "volatile" || curRoc > 1.5;
      const hardGatesPassed = hardRsi && hardVol && hardMomentum;
      const convictionScore = Math.min(95, 50 + score * 5);
      const passes = score >= threshold && reasons.length >= minReasons && hardGatesPassed && !sentiment.shouldBlockEntry && !coolingActive;

      if (!passes) {
        const skipReasons: string[] = [];
        if (coolingActive) skipReasons.push("News cooling period active");
        if (sentiment.shouldBlockEntry) skipReasons.push(`Negative news blocking entry (score: ${sentiment.score})`);
        if (score < threshold) skipReasons.push(`Score ${score}/${threshold} — need ${threshold - score} more point(s)`);
        if (reasons.length < minReasons) skipReasons.push(`Only ${reasons.length}/${minReasons} signals confirmed`);
        if (!hardRsi) skipReasons.push(`RSI ${curRsi.toFixed(1)} outside required zone`);
        if (!hardVol) skipReasons.push(`Volume ${curVolRatio.toFixed(1)}x below required ${volGate}x`);
        if (!hardMomentum) skipReasons.push(`Momentum too weak (ROC ${curRoc.toFixed(1)}%)`);
        return res.json({ ok: false, traded: false, reason: skipReasons.join(" | "), score, threshold, reasons, convictionScore: 0 });
      }

      // Check if already holding this symbol
      const openPositions = await storage.getOpenPositions();
      const alreadyHolding = openPositions.some((p: any) => p.symbol === symbol);
      if (alreadyHolding) {
        return res.json({ ok: false, traded: false, reason: `Already holding ${symbol}`, score, threshold, reasons, convictionScore });
      }

      // Check max positions for bucket
      const bucketPositions = openPositions.filter((p: any) => p.bucket === bucket);
      if (bucketPositions.length >= cfg.maxPositions) {
        return res.json({ ok: false, traded: false, reason: `${bucket} bucket full (${cfg.maxPositions} max positions)`, score, threshold, reasons, convictionScore });
      }

      // Calculate position size
      const account = await getAccount();
      const equity = parseFloat(account.equity);
      const bucketAlloc = equity * cfg.allocationPct;
      const positionValue = bucketAlloc * cfg.positionSizePct;
      const shares = Math.floor(positionValue / curPrice);

      if (shares < 1) {
        return res.json({ ok: false, traded: false, reason: "Position size too small (insufficient buying power)", score, threshold, reasons, convictionScore });
      }

      // Place the order
      const { placeMarketOrder } = await import("./alpaca");
      await placeMarketOrder(symbol, shares, "buy");

      const stopLoss = curPrice * (1 - cfg.stopLossPct);
      const trailingActivatePrice = curPrice * (1 + cfg.trailingTrigger);
      const entryReason = `[Manual Scan] ${reasons.join(" | ")}`;

      await storage.createPosition({
        symbol, bucket, strategy: bucket,
        shares, entryPrice: curPrice, currentPrice: curPrice,
        stopLoss, takeProfit: 9999,
        trailingStop: trailingActivatePrice,
        peakPrice: curPrice,
        entryReason, openedAt: new Date().toISOString(),
        convictionScore,
      });

      await storage.logSignal({
        symbol, bucket,
        signalType: "entry",
        details: JSON.stringify({
          reasons, entryPrice: curPrice, stopLoss,
          trailingActivatePrice, convictionScore,
          indicators: { rsi: curRsi, macdHist: curHist, volumeRatio: curVolRatio },
        }),
        createdAt: new Date().toISOString(),
      });

      res.json({
        ok: true, traded: true,
        symbol, bucket, shares,
        entryPrice: curPrice, stopLoss,
        trailingActivatePrice, convictionScore,
        score, threshold, reasons,
        message: `Bought ${shares} shares of ${symbol} at $${curPrice.toFixed(2)}`,
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, traded: false, reason: e.message });
    }
  });

  // ── Notes API ───────────────────────────────────────────────────────────
  app.get("/api/notes/:symbol", async (req, res) => {
    try {
      const symbol = req.params.symbol.toUpperCase().trim();
      const note = await storage.getNotes(symbol);
      res.json({ symbol, content: note?.content ?? "", updatedAt: note?.updatedAt ?? null });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/notes/:symbol", async (req, res) => {
    try {
      const symbol = req.params.symbol.toUpperCase().trim();
      const { content } = req.body as { content: string };
      if (typeof content !== "string") return res.status(400).json({ error: "content required" });
      const note = await storage.upsertNotes(symbol, content);
      res.json({ ok: true, note });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Auto-resume bot if it was running before server restart
  const wasRunning = await storage.getConfig("bot_running");
  if (wasRunning === "true") {
    setBotRunning(true);
    startBotInterval();
    runBotCycle().catch(console.error);
  }
}
