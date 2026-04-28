// Technical indicator calculations
// All functions take arrays of OHLCV bar data

export interface Bar {
  t: string; // timestamp
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

// Simple Moving Average
export function sma(values: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { result.push(NaN); continue; }
    const slice = values.slice(i - period + 1, i + 1);
    result.push(slice.reduce((a, b) => a + b, 0) / period);
  }
  return result;
}

// Exponential Moving Average
export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i === 0) { result.push(values[0]); continue; }
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

// RSI
export function rsi(closes: number[], period: number = 14): number[] {
  const result: number[] = new Array(period).fill(NaN);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  result.push(100 - 100 / (1 + (avgLoss === 0 ? 1e10 : avgGain / avgLoss)));
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    result.push(100 - 100 / (1 + (avgLoss === 0 ? 1e10 : avgGain / avgLoss)));
  }
  return result;
}

// MACD
export function macd(closes: number[], fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = ema(macdLine.slice(slow - 1), signal);
  const fullSignal = new Array(slow - 1).fill(NaN).concat(signalLine);
  const histogram = macdLine.map((v, i) => v - (fullSignal[i] || 0));
  return { macdLine, signalLine: fullSignal, histogram };
}

// Bollinger Bands
export function bollingerBands(closes: number[], period = 20, stdDev = 2) {
  const middle = sma(closes, period);
  const upper: number[] = [];
  const lower: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { upper.push(NaN); lower.push(NaN); continue; }
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = middle[i];
    const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
    const std = Math.sqrt(variance);
    upper.push(mean + stdDev * std);
    lower.push(mean - stdDev * std);
  }
  return { upper, middle, lower };
}

// Average True Range
export function atr(bars: Bar[], period = 14): number[] {
  const trs: number[] = [bars[0].h - bars[0].l];
  for (let i = 1; i < bars.length; i++) {
    trs.push(Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    ));
  }
  return sma(trs, period);
}

// Volume Ratio (current vs avg)
export function volumeRatio(bars: Bar[], period = 20): number[] {
  const vols = bars.map(b => b.v);
  const avgVol = sma(vols, period);
  return vols.map((v, i) => isNaN(avgVol[i]) ? 1 : v / avgVol[i]);
}

// Rate of Change
export function roc(closes: number[], period = 10): number[] {
  return closes.map((c, i) => i < period ? NaN : ((c - closes[i - period]) / closes[i - period]) * 100);
}

// Relative Strength vs SPY (simplified — compare % change)
export function relativeStrength(stockBars: Bar[], spyBars: Bar[], period = 63): number {
  if (stockBars.length < period || spyBars.length < period) return 50;
  const sLen = stockBars.length;
  const spLen = spyBars.length;
  const stockReturn = (stockBars[sLen - 1].c - stockBars[sLen - period].c) / stockBars[sLen - period].c;
  const spyReturn = (spyBars[spLen - 1].c - spyBars[spLen - period].c) / spyBars[spLen - period].c;
  // RS Rating 0-100
  const ratio = stockReturn / (spyReturn === 0 ? 0.001 : spyReturn);
  return Math.min(100, Math.max(0, 50 + ratio * 25));
}

// Detect breakout from consolidation base
export function detectBase(bars: Bar[], lookback = 30): { hasBase: boolean; baseHigh: number; baseLow: number } {
  if (bars.length < lookback) return { hasBase: false, baseHigh: 0, baseLow: 0 };
  const slice = bars.slice(-lookback - 1, -1); // exclude last bar
  const highs = slice.map(b => b.h);
  const lows = slice.map(b => b.l);
  const baseHigh = Math.max(...highs);
  const baseLow = Math.min(...lows);
  const range = (baseHigh - baseLow) / baseLow;
  return { hasBase: range < 0.35, baseHigh, baseLow }; // tight base = <35% range
}

// Compute conviction score for a position
export function computeConviction(params: {
  rsiVal: number;
  macdHistogram: number;
  volumeRatioVal: number;
  priceVsEntry: number; // % gain/loss
  bucket: string;
}): number {
  let score = 75;
  const { rsiVal, macdHistogram, volumeRatioVal, priceVsEntry, bucket } = params;

  // RSI scoring
  if (bucket === "volatile") {
    if (rsiVal > 80) score -= 20; // overbought = reduce conviction
    else if (rsiVal > 60 && rsiVal <= 80) score += 10;
    else if (rsiVal < 30) score -= 15;
  } else {
    if (rsiVal > 75) score -= 15;
    else if (rsiVal > 50 && rsiVal <= 75) score += 10;
    else if (rsiVal < 35) score -= 10;
  }

  // MACD momentum
  if (macdHistogram > 0) score += 10;
  else score -= 10;

  // Volume confirmation
  if (volumeRatioVal > 2) score += 10;
  else if (volumeRatioVal < 0.5) score -= 10;

  // P&L adjustment — if losing badly, reduce conviction
  if (priceVsEntry < -0.05) score -= 20;
  else if (priceVsEntry < -0.03) score -= 10;
  else if (priceVsEntry > 0.10) score += 5;

  return Math.min(100, Math.max(0, score));
}
