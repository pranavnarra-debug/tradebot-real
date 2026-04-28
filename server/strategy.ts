import { getBars, getMultiSnapshots, isMarketOpen } from "./alpaca";
import {
  sma, ema, rsi, macd, bollingerBands, atr, volumeRatio,
  roc, relativeStrength, detectBase, computeConviction, Bar
} from "./indicators";

// ── Unified 100-stock universe ─────────────────────────────────────────────
// Every stock is scanned against ALL 3 bucket strategies each cycle.
// The bot picks the highest conviction signal per symbol across all buckets.
export const UNIVERSE = [
  // Mega-cap tech & AI
  "AAPL","MSFT","NVDA","GOOGL","META","AMZN","TSLA","AVGO","TSM","AMD",
  // High-growth software
  "CRM","NOW","SNOW","DDOG","PANW","CRWD","ZS","MDB","SHOP","TTD",
  // Fintech & payments
  "V","MA","PYPL","SQ","HOOD","SOFI","COIN","AFRM","UPST","NU",
  // Healthcare & biotech
  "UNH","JNJ","LLY","ABBV","MRK","ISRG","DXCM","CELH","MRNA","REGN",
  // Energy & commodities
  "XOM","CVX","OXY","SLB","FANG","MPC","VLO","HAL","DVN","PSX",
  // Consumer & retail
  "HD","WMT","COST","TGT","AMZN","NKE","SBUX","MCD","CMG","LULU",
  // ETFs & indices
  "SPY","QQQ","XLK","XLV","XLF","SOXL","TQQQ","IWM","GLD","TLT",
  // High-volatility / momentum
  "PLTR","MARA","RIOT","GME","AMC","IONQ","RKLB","SMCI","DKNG","LCID",
  // Industrial & infrastructure
  "CAT","DE","BA","GE","HON","RTX","LMT","NOC","UNP","CSX",
  // Financials & banks
  "JPM","BAC","GS","MS","BLK","BRK.B","C","WFC","AXP","SCHW"
];

// Keep named exports for backward compatibility with routes.ts + bot.ts
export const VOLATILE_UNIVERSE = UNIVERSE;
export const SWING_UNIVERSE = UNIVERSE;
export const LONGTERM_UNIVERSE = UNIVERSE;

// ── Bucket config — 50% volatile / 50% swing ──────────────────────────────
export const BUCKET_CONFIG = {
  volatile: {
    allocationPct: 0.50,     // 50% of portfolio
    maxPositions: 8,
    positionSizePct: 0.04,   // 4% per trade
    stopLossPct: 0.03,       // 3% hard stop
    trailingTrigger: 0.08,   // trailing kicks in at +8% (let winners run)
    trailingPct: 3.0,        // 3% trail from peak once active
    minHoldHours: 24,        // PDT protection — never sell within 24h
    maxHoldDays: 3,          // force-exit after 3 days
    stopLossCooldownHours: 48, // 48h cooldown per ticker after stop-loss hit
    minConviction: 50,       // tighter gate (was 45)
  },
  swing: {
    allocationPct: 0.50,     // 50% of portfolio
    maxPositions: 6,
    positionSizePct: 0.06,   // 6% per trade
    stopLossPct: 0.08,       // 8% O'Neil rule
    trailingTrigger: 0.10,   // trailing kicks in at +10%
    trailingPct: 6.0,        // 6% trail
    minHoldHours: 0,         // no minimum hold for swing
    maxHoldDays: 45,
    stopLossCooldownHours: 48,
    minConviction: 40,
  },
  // longterm kept in config for backward compat — all positions migrated to swing
  longterm: {
    allocationPct: 0.00,     // disabled — no new entries
    maxPositions: 0,
    positionSizePct: 0.00,
    stopLossPct: 0.08,
    trailingTrigger: 0.10,
    trailingPct: 6.0,
    minHoldHours: 0,
    maxHoldDays: 45,
    stopLossCooldownHours: 48,
    minConviction: 40,
  },
};

export interface SignalResult {
  symbol: string;
  bucket: "volatile" | "swing" | "longterm";
  action: "buy" | "hold" | "sell";
  reasons: string[];
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;  // always 9999 — trailing stop only
  trailingStop: number; // price level where trailing stop is active
  convictionScore: number;
  indicators: Record<string, number>;
}

// ── Volatile strategy ──────────────────────────────────────────────────────
export async function scanVolatile(spyBars: Bar[], extraSymbols: string[] = []): Promise<SignalResult[]> {
  const signals: SignalResult[] = [];
  const universe = [...new Set([...UNIVERSE, ...extraSymbols])];
  const snapshots = await getMultiSnapshots(universe);

  for (const symbol of universe) {
    try {
      const bars: Bar[] = await getBars(symbol, "15Min", 150);
      if (!bars || bars.length < 50) continue;
      const closes = bars.map(b => b.c);

      const rsiVals = rsi(closes, 14);
      const curRsi = rsiVals[rsiVals.length - 1];
      const { macdLine, histogram } = macd(closes);
      const curMacd = macdLine[macdLine.length - 1];
      const curHist = histogram[histogram.length - 1];
      const prevHist = histogram[histogram.length - 2];
      const volRatio = volumeRatio(bars, 20);
      const curVolRatio = volRatio[volRatio.length - 1];
      const rocVals = roc(closes, 5);
      const curRoc = rocVals[rocVals.length - 1];
      const ema9 = ema(closes, 9);
      const ema21 = ema(closes, 21);
      const curPrice = closes[closes.length - 1];
      const snap = snapshots[symbol];
      const changeToday = snap?.dailyBar
        ? (snap.dailyBar.c - snap.dailyBar.o) / snap.dailyBar.o * 100
        : 0;

      const reasons: string[] = [];
      let score = 0;

      // Signal 1: RSI momentum zone
      if (curRsi > 55 && curRsi < 75) { reasons.push(`RSI momentum zone (${curRsi.toFixed(1)})`); score++; }

      // Signal 2: MACD histogram crossover
      if (curHist > 0 && prevHist <= 0) { reasons.push("MACD histogram bullish crossover"); score += 2; }
      else if (curHist > 0) { reasons.push(`MACD positive momentum (${curMacd.toFixed(3)})`); score++; }

      // Signal 3: Volume surge
      if (curVolRatio > 2.5) { reasons.push(`Volume surge ${curVolRatio.toFixed(1)}x avg`); score += 2; }
      else if (curVolRatio > 1.5) { reasons.push(`Above-avg volume ${curVolRatio.toFixed(1)}x`); score++; }

      // Signal 4: Strong intraday momentum
      if (curRoc > 2) { reasons.push(`Strong 5-bar ROC ${curRoc.toFixed(1)}%`); score += 2; }
      else if (curRoc > 1) { reasons.push(`Positive ROC ${curRoc.toFixed(1)}%`); score++; }

      // Signal 5: EMA alignment
      if (ema9[ema9.length - 1] > ema21[ema21.length - 1] && curPrice > ema9[ema9.length - 1]) {
        reasons.push("Price above EMA9 > EMA21 (bullish stack)"); score++;
      }

      // Signal 6: Intraday gap/surge
      if (changeToday > 3) { reasons.push(`Up ${changeToday.toFixed(1)}% today`); score++; }

      // Signal 7: Oversold recovery bounce (RSI bouncing from oversold)
      const prevRsi = rsiVals[rsiVals.length - 2];
      if (prevRsi < 35 && curRsi > prevRsi + 3) {
        reasons.push(`Recovery bounce: RSI rising from oversold (${prevRsi.toFixed(1)} → ${curRsi.toFixed(1)})`);
        score += 2;
      }

      // Hard gate: RSI must be in tight momentum zone or recovering from oversold
      const hasRsiSignal = (curRsi > 58 && curRsi < 72) || (prevRsi < 35 && curRsi > prevRsi + 5);
      // Hard gate: must have meaningful volume surge (raised from 1.8x to 2.0x)
      const hasVolume = curVolRatio > 2.0;
      // Hard gate: must have clear positive price momentum (raised from 1.5 to 2.0 ROC)
      const hasMomentum = curRoc > 2.0 || changeToday > 3.0;
      // Hard gate: MACD must be positive (no entry against MACD)
      const hasMacd = curHist > 0;

      if (score >= 6 && reasons.length >= 3 && hasRsiSignal && hasVolume && hasMomentum && hasMacd) {
        const cfg = BUCKET_CONFIG.volatile;
        signals.push({
          symbol,
          bucket: "volatile",
          action: "buy",
          reasons,
          entryPrice: curPrice,
          stopLoss: curPrice * (1 - cfg.stopLossPct),
          takeProfit: 9999,
          trailingStop: curPrice * (1 + cfg.trailingTrigger), // +8% activation price
          convictionScore: Math.min(95, 55 + score * 5),
          indicators: { rsi: curRsi, macdHist: curHist, volumeRatio: curVolRatio, roc: curRoc },
        });
      }
    } catch { /* skip failed symbols */ }
  }

  return signals.sort((a, b) => b.convictionScore - a.convictionScore);
}

// ── CANSLIM Swing strategy ─────────────────────────────────────────────────
export async function scanSwing(spyBars: Bar[], extraSymbols: string[] = []): Promise<SignalResult[]> {
  const signals: SignalResult[] = [];
  const universe = [...new Set([...UNIVERSE, ...extraSymbols])];

  // Fetch all bars in parallel batches
  const BATCH = 10;
  const barMap = new Map<string, Bar[]>();
  for (let i = 0; i < universe.length; i += BATCH) {
    const batch = universe.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(s => getBars(s, "1Day", 150).catch(() => [])));
    batch.forEach((s, idx) => barMap.set(s, results[idx]));
  }

  for (const symbol of universe) {
    try {
      const bars: Bar[] = barMap.get(symbol) || [];
      if (!bars || bars.length < 80) continue;
      const closes = bars.map(b => b.c);

      const rsiVals = rsi(closes, 14);
      const curRsi = rsiVals[rsiVals.length - 1];
      const { histogram } = macd(closes);
      const curHist = histogram[histogram.length - 1];
      const prevHist = histogram[histogram.length - 2];
      const volRatio = volumeRatio(bars, 50);
      const curVolRatio = volRatio[volRatio.length - 1];
      const sma50 = sma(closes, 50);
      const sma200 = sma(closes, 200);
      const ema21 = ema(closes, 21);
      const { baseHigh, hasBase } = detectBase(bars, 30);
      const curPrice = closes[closes.length - 1];
      const rsRating = relativeStrength(bars, spyBars, 63);
      const rocVals = roc(closes, 20);
      const curRoc = rocVals[rocVals.length - 1];

      const reasons: string[] = [];
      let score = 0;

      // C — Current quarterly earnings proxy (strong recent momentum)
      if (curRoc > 15) { reasons.push(`C: Strong 20-day momentum ${curRoc.toFixed(1)}% (earnings proxy)`); score += 2; }
      else if (curRoc > 8) { reasons.push(`C: Positive 20-day momentum ${curRoc.toFixed(1)}%`); score++; }
      // Recovery: even negative momentum that is improving counts
      else if (curRoc > -5 && curRoc > 0) { reasons.push(`C: Recovering momentum ${curRoc.toFixed(1)}%`); score++; }

      // A — Annual trend (price > 200 SMA, or recovering toward it)
      const cur200 = sma200[sma200.length - 1];
      if (curPrice > cur200) {
        reasons.push(`A: Annual uptrend (price > 200-day SMA)`); score++;
      } else if (curPrice > cur200 * 0.92) {
        // Within 8% of 200 SMA — still tradeable, just in a correction
        reasons.push(`A: Near 200-day SMA — correction not breakdown (${((curPrice/cur200-1)*100).toFixed(1)}%)`);
        score++;
      }

      // N — New high breakout from base
      if (hasBase && curPrice > baseHigh * 0.99) {
        reasons.push(`N: Breaking out from 30-day base (pivot ${baseHigh.toFixed(2)})`); score += 2;
      }

      // S — Supply/demand: volume on breakout
      if (curVolRatio > 1.4) { reasons.push(`S: Volume ${curVolRatio.toFixed(1)}x avg on move`); score += 2; }

      // L — Leading stock (RS Rating)
      if (rsRating > 80) { reasons.push(`L: RS Rating ${rsRating.toFixed(0)} (top leader)`); score += 2; }
      else if (rsRating > 65) { reasons.push(`L: RS Rating ${rsRating.toFixed(0)} (above avg)`); score++; }

      // I — Institutional (price > EMA21 = fund support)
      if (curPrice > ema21[ema21.length - 1]) {
        reasons.push(`I: Price above 21-EMA (institutional support)`); score++;
      }

      // M — Market direction (price > 50 SMA)
      if (curPrice > sma50[sma50.length - 1]) {
        reasons.push(`M: Market trend up (price > 50-day SMA)`); score++;
      }

      // Enhancement: MACD confirmation
      if (curHist > 0 && prevHist <= 0) { reasons.push("MACD bullish crossover confirms entry"); score++; }

      // Enhancement: RSI not overbought
      if (curRsi > 50 && curRsi < 70) { reasons.push(`RSI healthy momentum (${curRsi.toFixed(1)})`); score++; }

      // Enhancement: Oversold recovery bounce on daily
      const prevRsiSwing = rsiVals[rsiVals.length - 2];
      if (prevRsiSwing < 40 && curRsi > prevRsiSwing + 4) {
        reasons.push(`Recovery bounce: RSI rising from oversold (${prevRsiSwing.toFixed(1)} → ${curRsi.toFixed(1)})`);
        score += 2;
      }

      // Hard gates for swing: need RSI signal + volume + must be above 50-SMA
      const swingHasRsi = (curRsi > 52 && curRsi < 68) || (prevRsiSwing < 38 && curRsi > prevRsiSwing + 5);
      const swingHasVolume = curVolRatio > 1.6;
      const swingAbove50 = curPrice > sma50[sma50.length - 1];

      if (score >= 7 && reasons.length >= 5 && swingHasRsi && swingHasVolume && swingAbove50) {
        const cfg = BUCKET_CONFIG.swing;
        signals.push({
          symbol,
          bucket: "swing",
          action: "buy",
          reasons,
          entryPrice: curPrice,
          stopLoss: curPrice * (1 - cfg.stopLossPct),
          takeProfit: 9999,
          trailingStop: curPrice * (1 + cfg.trailingTrigger), // price where trailing activates
          convictionScore: Math.min(95, 50 + score * 5),
          indicators: { rsi: curRsi, macdHist: curHist, volumeRatio: curVolRatio, rsRating, roc: curRoc },
        });
      }
    } catch { /* skip */ }
  }

  return signals.sort((a, b) => b.convictionScore - a.convictionScore);
}

// ── Long-term strategy ────────────────────────────────────────────────────
export async function scanLongterm(spyBars: Bar[]): Promise<SignalResult[]> {
  const signals: SignalResult[] = [];

  // Fetch all bars in parallel (batch of 10 at a time to avoid rate limits)
  const BATCH = 10;
  const barMap = new Map<string, Bar[]>();
  for (let i = 0; i < UNIVERSE.length; i += BATCH) {
    const batch = UNIVERSE.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(s => getBars(s, "1Day", 250).catch(() => [])));
    batch.forEach((s, idx) => barMap.set(s, results[idx]));
  }

  for (const symbol of UNIVERSE) {
    try {
      const bars: Bar[] = barMap.get(symbol) || [];
      if (!bars || bars.length < 120) continue;
      const closes = bars.map(b => b.c);

      const sma50 = sma(closes, 50);
      const sma200 = sma(closes, 200);
      const rsiVals = rsi(closes, 14);
      const curRsi = rsiVals[rsiVals.length - 1];
      const { histogram } = macd(closes, 12, 26, 9);
      const curHist = histogram[histogram.length - 1];
      const bb = bollingerBands(closes, 20, 2);
      const curPrice = closes[closes.length - 1];
      const curSma50 = sma50[sma50.length - 1];
      const curSma200 = sma200[sma200.length - 1];
      const prevSma50 = sma50[sma50.length - 5];
      const volRatio = volumeRatio(bars, 50);
      const curVolRatio = volRatio[volRatio.length - 1];
      const rsRating = relativeStrength(bars, spyBars, 63);
      const rocVals = roc(closes, 63);
      const curRoc = rocVals[rocVals.length - 1];

      const reasons: string[] = [];
      let score = 0;

      // Golden cross or above both MAs
      if (curSma50 > curSma200 && prevSma50 <= curSma200) {
        reasons.push("Golden cross (50-SMA crossed above 200-SMA)"); score += 3;
      } else if (curSma50 > curSma200) {
        reasons.push("Long-term uptrend: 50-SMA above 200-SMA"); score++;
      }

      // Price above 50-SMA (trend confirmation)
      if (curPrice > curSma50) { reasons.push("Price above 50-SMA (trend intact)"); score++; }

      // Price near Bollinger lower band = dip opportunity
      const bbMid = bb.middle[bb.middle.length - 1];
      const bbLow = bb.lower[bb.lower.length - 1];
      if (curPrice < bbMid && curPrice > bbLow) {
        reasons.push("Pullback to Bollinger midpoint — dip entry"); score++;
      } else if (curPrice <= bbLow * 1.01) {
        reasons.push("Price at/near Bollinger lower band — extreme oversold dip"); score++;
      }

      // RSI not overbought, strong but not extreme
      if (curRsi > 45 && curRsi < 65) { reasons.push(`RSI in healthy zone (${curRsi.toFixed(1)})`); score++; }

      // Oversold recovery bounce on long-term
      const prevRsiLt = rsiVals[rsiVals.length - 2];
      if (prevRsiLt < 38 && curRsi > prevRsiLt + 4) {
        reasons.push(`Recovery bounce: RSI rising from oversold (${prevRsiLt.toFixed(1)} → ${curRsi.toFixed(1)})`);
        score += 2;
      }

      // Quarterly momentum
      if (curRoc > 10) { reasons.push(`63-day return ${curRoc.toFixed(1)}% (strong fundamental momentum)`); score++; }

      // MACD positive
      if (curHist > 0) { reasons.push("MACD positive — trend momentum intact"); score++; }

      // RS above average
      if (rsRating > 60) { reasons.push(`Relative strength ${rsRating.toFixed(0)} — outperforming market`); score++; }

      // Hard gates for long-term: need RSI in healthy zone + 50-SMA above 200-SMA + volume
      const ltHasRsi = (curRsi > 45 && curRsi < 65) || (prevRsiLt < 38 && curRsi > prevRsiLt + 4);
      const ltHasTrend = curSma50 > curSma200 * 0.97; // 50-SMA must be near or above 200-SMA
      const ltHasVolume = curVolRatio > 1.2;

      if (score >= 5 && reasons.length >= 4 && ltHasRsi && ltHasTrend && ltHasVolume) {
        const cfg = BUCKET_CONFIG.longterm;
        signals.push({
          symbol,
          bucket: "longterm",
          action: "buy",
          reasons,
          entryPrice: curPrice,
          stopLoss: curPrice * (1 - cfg.stopLossPct),
          takeProfit: 9999,
          trailingStop: curPrice * (1 + cfg.trailingTrigger),
          convictionScore: Math.min(95, 50 + score * 7),
          indicators: { rsi: curRsi, macdHist: curHist, volumeRatio: curVolRatio, rsRating, roc: curRoc, sma50Vs200: (curSma50 / curSma200 - 1) * 100 },
        });
      }
    } catch { /* skip */ }
  }

  return signals.sort((a, b) => b.convictionScore - a.convictionScore);
}

// ── Reassess open position conviction ────────────────────────────────────

// ── Unified scan: run all 3 buckets, pick highest conviction per symbol ────
export async function scanAll(spyBars: Bar[], extraSymbols: string[] = []): Promise<SignalResult[]> {
  // Run volatile + swing only (longterm disabled)
  const [volatileSignals, swingSignals] = await Promise.all([
    scanVolatile(spyBars, extraSymbols),
    scanSwing(spyBars, extraSymbols),
  ]);

  const all = [...volatileSignals, ...swingSignals];

  // Per symbol: keep only the highest conviction bucket
  const best = new Map<string, SignalResult>();
  for (const sig of all) {
    const existing = best.get(sig.symbol);
    if (!existing || sig.convictionScore > existing.convictionScore) {
      best.set(sig.symbol, sig);
    }
  }

  return Array.from(best.values()).sort((a, b) => b.convictionScore - a.convictionScore);
}

export async function reassessPosition(
  symbol: string,
  bucket: "volatile" | "swing" | "longterm",
  entryPrice: number,
  peakPrice: number,
  openedAt?: string
): Promise<{ conviction: number; shouldSell: boolean; reason: string; currentPrice: number; indicators: Record<string, number> }> {
  const timeframe = bucket === "volatile" ? "15Min" : "1Day";
  const bars: Bar[] = await getBars(symbol, timeframe, 100);
  if (!bars || bars.length < 20) {
    return { conviction: 50, shouldSell: false, reason: "", currentPrice: entryPrice, indicators: {} };
  }

  const closes = bars.map(b => b.c);
  const curPrice = closes[closes.length - 1];
  const rsiVals = rsi(closes, 14);
  const curRsi = rsiVals[rsiVals.length - 1];
  const { histogram } = macd(closes);
  const curHist = histogram[histogram.length - 1];
  const volRatio = volumeRatio(bars, 20);
  const curVolRatio = volRatio[volRatio.length - 1];
  const priceVsEntry = (curPrice - entryPrice) / entryPrice;

  const cfg = BUCKET_CONFIG[bucket];
  const indicators = { rsi: curRsi, macdHist: curHist, volumeRatio: curVolRatio, priceVsEntry: priceVsEntry * 100 };

  // Hard stop loss — always honoured regardless of hold time
  if (priceVsEntry < -cfg.stopLossPct) {
    return { conviction: 0, shouldSell: true, reason: `Hard stop loss hit (${(priceVsEntry * 100).toFixed(2)}%)`, currentPrice: curPrice, indicators };
  }

  // Trailing stop (if activated) — no take profit, let winners run
  const peakGain = (peakPrice - entryPrice) / entryPrice;
  if (peakGain >= cfg.trailingTrigger) {
    const drawdownFromPeak = (curPrice - peakPrice) / peakPrice;
    if (drawdownFromPeak < -(cfg.trailingPct / 100)) {
      return {
        conviction: 20,
        shouldSell: true,
        reason: `Trailing stop triggered: ${(drawdownFromPeak * 100).toFixed(2)}% from peak of $${peakPrice.toFixed(2)}`,
        currentPrice: curPrice,
        indicators
      };
    }
  }

  // Max hold days — force exit if position has been open too long
  const holdDays = (Date.now() - new Date(openedAt || 0).getTime()) / 86400000;
  if (holdDays >= cfg.maxHoldDays) {
    return {
      conviction: 30,
      shouldSell: true,
      reason: `Max hold days reached (${holdDays.toFixed(1)}d / ${cfg.maxHoldDays}d)`,
      currentPrice: curPrice,
      indicators
    };
  }

  const conviction = computeConviction({ rsiVal: curRsi, macdHistogram: curHist, volumeRatioVal: curVolRatio, priceVsEntry, bucket });

  // Conviction-based exit
  if (conviction < cfg.minConviction) {
    return { conviction, shouldSell: true, reason: `Conviction dropped to ${conviction} (below threshold ${cfg.minConviction})`, currentPrice: curPrice, indicators };
  }

  return { conviction, shouldSell: false, reason: "", currentPrice: curPrice, indicators };
}
