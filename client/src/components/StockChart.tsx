import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";

interface Props {
  symbol: string;
  timeframe?: string;
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;   // kept for trade history charts — ignored if 9999
  trailingStop?: number; // price level where trailing activates (shown as dashed amber line)
  entryTime?: string;
  exitTime?: string;
  exitPrice?: number;
  bucket?: string;
  height?: number;
  showIndicators?: boolean;
}

// ── Indicator math (client-side) ──────────────────────────────────────────
function calcSMA(vals: number[], period: number): number[] {
  return vals.map((_, i) => {
    if (i < period - 1) return NaN;
    return vals.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  });
}

function calcEMA(vals: number[], period: number): number[] {
  const k = 2 / (period + 1);
  return vals.reduce((acc: number[], v, i) => {
    if (i === 0) { acc.push(v); return acc; }
    acc.push(v * k + acc[i - 1] * (1 - k));
    return acc;
  }, []);
}

function calcRSI(closes: number[], period = 14): number[] {
  const result: number[] = new Array(period).fill(NaN);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  result.push(100 - 100 / (1 + (avgLoss === 0 ? 1e10 : avgGain / avgLoss)));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    result.push(100 - 100 / (1 + (avgLoss === 0 ? 1e10 : avgGain / avgLoss)));
  }
  return result;
}

function calcMACD(closes: number[]) {
  const fast = calcEMA(closes, 12);
  const slow = calcEMA(closes, 26);
  const macdLine = fast.map((v, i) => v - slow[i]);
  const signal = calcEMA(macdLine.slice(25), 9);
  const fullSignal = new Array(25).fill(NaN).concat(signal);
  const hist = macdLine.map((v, i) => isNaN(fullSignal[i]) ? NaN : v - fullSignal[i]);
  return { macdLine, signal: fullSignal, hist };
}

function calcBB(closes: number[], period = 20, std = 2) {
  const mid = calcSMA(closes, period);
  const upper = mid.map((m, i) => {
    if (isNaN(m)) return NaN;
    const slice = closes.slice(i - period + 1, i + 1);
    const variance = slice.reduce((a, b) => a + Math.pow(b - m, 2), 0) / period;
    return m + std * Math.sqrt(variance);
  });
  const lower = mid.map((m, i) => {
    if (isNaN(m)) return NaN;
    const slice = closes.slice(i - period + 1, i + 1);
    const variance = slice.reduce((a, b) => a + Math.pow(b - m, 2), 0) / period;
    return m - std * Math.sqrt(variance);
  });
  return { upper, mid, lower };
}

export default function StockChart({
  symbol, timeframe = "1Day", entryPrice, stopLoss, takeProfit, trailingStop,
  entryTime, exitTime, exitPrice, bucket = "swing",
  height = 420, showIndicators = true
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const { data: bars, isLoading } = useQuery({
    queryKey: ["/api/chart", symbol, timeframe],
    queryFn: () => apiRequest("GET", `/api/chart/${symbol}?timeframe=${timeframe}&limit=100`).then(r => r.json()),
    refetchInterval: 60000,
  });

  useEffect(() => {
    if (!bars?.length || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const W = canvas.offsetWidth;
    const H = height;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    const closes = bars.map((b: any) => b.c);
    const opens = bars.map((b: any) => b.o);
    const highs = bars.map((b: any) => b.h);
    const lows = bars.map((b: any) => b.l);
    const volumes = bars.map((b: any) => b.v);
    const n = bars.length;

    // Indicator calculations
    const ema9 = calcEMA(closes, 9);
    const ema21 = calcEMA(closes, 21);
    const sma50 = calcSMA(closes, 50);
    const sma200 = calcSMA(closes, 200);
    const bb = calcBB(closes, 20, 2);
    const rsiVals = calcRSI(closes, 14);
    const { macdLine, signal: macdSignal, hist: macdHist } = calcMACD(closes);
    const maxVol = Math.max(...volumes);
    const avgVol = calcSMA(volumes, 20);

    // Layout panels
    const isVolatile = bucket === "volatile";
    const showSMA200 = !isVolatile && n >= 200;

    // Panel heights
    const priceH = showIndicators ? H * 0.52 : H * 0.82;
    const volH = H * 0.1;
    const rsiH = showIndicators ? H * 0.15 : 0;
    const macdH = showIndicators ? H * 0.15 : 0;
    const padL = 58, padR = 12, padTop = 16, gap = 6;

    const priceTop = padTop;
    const volTop = priceTop + priceH + gap;
    const rsiTop = volTop + volH + gap;
    const macdTop = rsiTop + rsiH + gap;

    const chartW = W - padL - padR;

    // Background
    ctx.fillStyle = "hsl(220, 18%, 7%)";
    ctx.fillRect(0, 0, W, H);

    // ── Helpers ────────────────────────────────────────────────────────────
    const px = (i: number) => padL + (i / (n - 1)) * chartW;

    const drawLine = (vals: number[], top: number, panH: number, min: number, max: number, color: string, lw = 1.5) => {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.lineJoin = "round";
      let started = false;
      vals.forEach((v, i) => {
        if (isNaN(v)) { started = false; return; }
        const y = top + panH - ((v - min) / (max - min)) * panH;
        if (!started) { ctx.moveTo(px(i), y); started = true; } else ctx.lineTo(px(i), y);
      });
      ctx.stroke();
    };

    const drawHLine = (y: number, color: string, dash: number[] = [], label = "", lw = 1) => {
      ctx.save();
      ctx.setLineDash(dash);
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.setLineDash([]);
      if (label) {
        ctx.fillStyle = color;
        ctx.font = "bold 9px Inter, sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(label, padL + 2, y - 3);
      }
      ctx.restore();
    };

    const drawYAxis = (top: number, panH: number, min: number, max: number, steps = 4, prefix = "", decimals = 2) => {
      ctx.fillStyle = "hsl(210, 10%, 45%)";
      ctx.font = "9px Inter, sans-serif";
      ctx.textAlign = "right";
      for (let i = 0; i <= steps; i++) {
        const v = min + (max - min) * (i / steps);
        const y = top + panH - ((v - min) / (max - min)) * panH;
        ctx.fillText(`${prefix}${v.toFixed(decimals)}`, padL - 3, y + 3);
        ctx.strokeStyle = "hsl(220, 15%, 13%)";
        ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      }
    };

    const drawLabel = (text: string, x: number, y: number, color: string) => {
      ctx.fillStyle = color;
      ctx.font = "bold 9px Inter, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(text, x, y);
    };

    // ── Price panel ────────────────────────────────────────────────────────
    const priceVals = [...highs, ...lows];
    const effectiveTp = takeProfit && takeProfit < 9000 ? takeProfit : undefined;
    // Guard: trailingStop must be a real price (> 1.0), not a stored ratio like 0.08
    const effectiveTrail = trailingStop && trailingStop > 1 ? trailingStop : undefined;
    if (entryPrice) priceVals.push(entryPrice, stopLoss || entryPrice);
    if (effectiveTp) priceVals.push(effectiveTp);
    if (effectiveTrail) priceVals.push(effectiveTrail);
    const priceMin = Math.min(...priceVals) * 0.997;
    const priceMax = Math.max(...priceVals) * 1.003;
    const pyP = (v: number) => priceTop + priceH - ((v - priceMin) / (priceMax - priceMin)) * priceH;

    drawYAxis(priceTop, priceH, priceMin, priceMax, 5, "$", priceMin > 100 ? 0 : 2);

    // Bollinger Bands fill
    ctx.beginPath();
    bb.upper.forEach((v, i) => { if (!isNaN(v)) { if (i === 0 || isNaN(bb.upper[i-1])) ctx.moveTo(px(i), pyP(v)); else ctx.lineTo(px(i), pyP(v)); } });
    bb.lower.slice().reverse().forEach((v, i) => { const ri = n - 1 - i; if (!isNaN(v)) ctx.lineTo(px(ri), pyP(v)); });
    ctx.closePath();
    ctx.fillStyle = "hsl(207 100% 55% / 0.06)";
    ctx.fill();

    // BB lines
    drawLine(bb.upper, priceTop, priceH, priceMin, priceMax, "hsl(207 100% 55% / 0.35)", 1);
    drawLine(bb.lower, priceTop, priceH, priceMin, priceMax, "hsl(207 100% 55% / 0.35)", 1);
    drawLine(bb.mid, priceTop, priceH, priceMin, priceMax, "hsl(207 100% 55% / 0.2)", 1);

    // EMAs and SMAs
    if (!isVolatile) {
      if (showSMA200) drawLine(sma200, priceTop, priceH, priceMin, priceMax, "hsl(280 80% 60% / 0.7)", 1.5);
      drawLine(sma50, priceTop, priceH, priceMin, priceMax, "hsl(35 100% 55% / 0.8)", 1.5);
    }
    drawLine(ema21, priceTop, priceH, priceMin, priceMax, "hsl(142 76% 50% / 0.8)", 1.5);
    drawLine(ema9, priceTop, priceH, priceMin, priceMax, "hsl(207 100% 65% / 0.9)", 1.5);

    // Price candles
    const candleW = Math.max(2, chartW / n - 1.5);
    bars.forEach((b: any, i: number) => {
      const x = px(i);
      const isUp = b.c >= b.o;
      const col = isUp ? "hsl(142, 76%, 45%)" : "hsl(0, 72%, 51%)";
      // Wick
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, pyP(b.h));
      ctx.lineTo(x, pyP(b.l));
      ctx.stroke();
      // Body
      const bodyTop = pyP(Math.max(b.o, b.c));
      const bodyH = Math.max(1, Math.abs(pyP(b.o) - pyP(b.c)));
      ctx.fillStyle = isUp ? "hsl(142, 76%, 45%)" : "hsl(0, 72%, 51%)";
      ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);
    });

    // Entry/exit/stop/target lines
    if (entryPrice) {
      drawHLine(pyP(entryPrice), "hsl(207 100% 65%)", [4, 3], `Entry $${entryPrice.toFixed(2)}`);
    }
    if (stopLoss) {
      drawHLine(pyP(stopLoss), "hsl(0 72% 60%)", [3, 3], `Stop $${stopLoss.toFixed(2)}`);
    }
    if (effectiveTp) {
      drawHLine(pyP(effectiveTp), "hsl(142 76% 55%)", [3, 3], `Target $${effectiveTp.toFixed(2)}`);
    }
    if (effectiveTrail) {
      drawHLine(pyP(effectiveTrail), "hsl(38 92% 50%)", [4, 4], `Trail activates $${effectiveTrail.toFixed(2)}`);
    }

    // Entry/exit arrows on candles
    if (entryTime) {
      const entryIdx = bars.findIndex((b: any) => b.t >= entryTime);
      if (entryIdx >= 0) {
        const x = px(entryIdx);
        const y = pyP(lows[entryIdx]) + 14;
        ctx.fillStyle = "hsl(142 76% 55%)";
        ctx.beginPath();
        ctx.moveTo(x, y - 10); ctx.lineTo(x - 5, y); ctx.lineTo(x + 5, y);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = "hsl(142 76% 55%)";
        ctx.font = "bold 8px Inter";
        ctx.textAlign = "center";
        ctx.fillText("BUY", x, y + 9);
      }
    }
    if (exitTime) {
      const exitIdx = bars.findIndex((b: any) => b.t >= exitTime);
      if (exitIdx >= 0) {
        const x = px(exitIdx);
        const y = pyP(highs[exitIdx]) - 14;
        ctx.fillStyle = "hsl(0 72% 60%)";
        ctx.beginPath();
        ctx.moveTo(x, y + 10); ctx.lineTo(x - 5, y); ctx.lineTo(x + 5, y);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = "hsl(0 72% 60%)";
        ctx.font = "bold 8px Inter";
        ctx.textAlign = "center";
        ctx.fillText("SELL", x, y - 3);
      }
    }

    // Panel label
    drawLabel(symbol, padL + 2, priceTop + 12, "hsl(210 20% 80%)");

    // Legend
    const legends = isVolatile
      ? [["EMA9", "hsl(207 100% 65%)"], ["EMA21", "hsl(142 76% 50%)"], ["BB", "hsl(207 100% 55% / 0.5)"]]
      : showSMA200
        ? [["EMA9", "hsl(207 100% 65%)"], ["EMA21", "hsl(142 76% 50%)"], ["SMA50", "hsl(35 100% 55%)"], ["SMA200", "hsl(280 80% 60%)"], ["BB", "hsl(207 100% 55% / 0.5)"]]
        : [["EMA9", "hsl(207 100% 65%)"], ["EMA21", "hsl(142 76% 50%)"], ["SMA50", "hsl(35 100% 55%)"], ["BB", "hsl(207 100% 55% / 0.5)"]];
    let lx = W - padR;
    ctx.font = "9px Inter";
    legends.slice().reverse().forEach(([label, color]) => {
      const tw = ctx.measureText(label).width + 14;
      lx -= tw;
      ctx.fillStyle = color as string;
      ctx.beginPath(); ctx.arc(lx + 4, priceTop + 10, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "hsl(210 10% 60%)";
      ctx.textAlign = "left";
      ctx.fillText(label, lx + 10, priceTop + 13);
    });

    // ── Volume panel ───────────────────────────────────────────────────────
    drawLabel("VOL", padL + 2, volTop + 10, "hsl(210 10% 45%)");
    bars.forEach((b: any, i: number) => {
      const x = px(i);
      const vh = (b.v / maxVol) * volH;
      const isUp = b.c >= b.o;
      ctx.fillStyle = isUp ? "hsl(142 76% 45% / 0.5)" : "hsl(0 72% 51% / 0.5)";
      ctx.fillRect(x - candleW / 2, volTop + volH - vh, candleW, vh);
    });
    // Avg volume line
    drawLine(avgVol.map(v => v / maxVol * volH), volTop + volH, volH, 0, volH, "hsl(207 100% 65% / 0.6)", 1);
    ctx.fillStyle = "hsl(207 100% 65% / 0.7)";
    ctx.font = "8px Inter"; ctx.textAlign = "left";
    ctx.fillText("avg", padL + 2, volTop + volH - (avgVol[n-1] / maxVol * volH) - 2);

    if (!showIndicators) {
      // Just draw x-axis dates and return
      drawXDates(ctx, bars, px, H - 8, padL, W - padR);
      return;
    }

    // ── RSI panel ──────────────────────────────────────────────────────────
    const rsiMin = 0, rsiMax = 100;
    const pyR = (v: number) => rsiTop + rsiH - ((v - rsiMin) / (rsiMax - rsiMin)) * rsiH;

    drawLabel("RSI(14)", padL + 2, rsiTop + 10, "hsl(210 10% 45%)");

    // Overbought/oversold zones
    ctx.fillStyle = "hsl(0 72% 51% / 0.08)";
    ctx.fillRect(padL, pyR(70), chartW, pyR(100) - pyR(70));
    ctx.fillStyle = "hsl(142 76% 45% / 0.08)";
    ctx.fillRect(padL, pyR(30), chartW, pyR(0) - pyR(30));

    drawHLine(pyR(70), "hsl(0 72% 51% / 0.4)", [2, 2], "70");
    drawHLine(pyR(50), "hsl(210 10% 40% / 0.5)", [2, 2], "50");
    drawHLine(pyR(30), "hsl(142 76% 45% / 0.4)", [2, 2], "30");

    // RSI line colored by zone
    ctx.beginPath();
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    rsiVals.forEach((v, i) => {
      if (isNaN(v)) return;
      const y = pyR(v);
      const color = v > 70 ? "hsl(0 72% 60%)" : v < 30 ? "hsl(142 76% 55%)" : "hsl(207 100% 65%)";
      if (i === 0 || isNaN(rsiVals[i-1])) {
        ctx.stroke(); ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.moveTo(px(i), y);
      } else {
        ctx.lineTo(px(i), y);
      }
    });
    ctx.stroke();

    // Current RSI value
    const curRSI = rsiVals[n - 1];
    if (!isNaN(curRSI)) {
      const rsiColor = curRSI > 70 ? "hsl(0 72% 60%)" : curRSI < 30 ? "hsl(142 76% 55%)" : "hsl(207 100% 65%)";
      ctx.fillStyle = rsiColor;
      ctx.font = "bold 9px Inter";
      ctx.textAlign = "right";
      ctx.fillText(curRSI.toFixed(1), W - padR - 2, pyR(curRSI) + 3);
    }

    // ── MACD panel ─────────────────────────────────────────────────────────
    const validMacd = macdHist.filter(v => !isNaN(v));
    const macdAbsMax = Math.max(...validMacd.map(Math.abs), 0.001);
    const macdMin = -macdAbsMax * 1.2;
    const macdMax = macdAbsMax * 1.2;
    const pyM = (v: number) => macdTop + macdH - ((v - macdMin) / (macdMax - macdMin)) * macdH;

    drawLabel("MACD(12,26,9)", padL + 2, macdTop + 10, "hsl(210 10% 45%)");
    drawHLine(pyM(0), "hsl(210 10% 35%)", [2, 2]);

    // Histogram
    macdHist.forEach((v, i) => {
      if (isNaN(v)) return;
      const x = px(i);
      const y0 = pyM(0);
      const y1 = pyM(v);
      ctx.fillStyle = v >= 0 ? "hsl(142 76% 45% / 0.7)" : "hsl(0 72% 51% / 0.7)";
      ctx.fillRect(x - candleW / 2, Math.min(y0, y1), candleW, Math.abs(y0 - y1));
    });

    // MACD line
    drawLine(macdLine, macdTop, macdH, macdMin, macdMax, "hsl(207 100% 65%)", 1.5);
    // Signal line
    drawLine(macdSignal, macdTop, macdH, macdMin, macdMax, "hsl(35 100% 55%)", 1.5);

    // Legend
    ctx.font = "9px Inter"; ctx.textAlign = "left";
    ctx.fillStyle = "hsl(207 100% 65%)"; ctx.fillText("MACD", W - padR - 70, macdTop + 10);
    ctx.fillStyle = "hsl(35 100% 55%)"; ctx.fillText("Signal", W - padR - 35, macdTop + 10);

    // ── X-axis dates ───────────────────────────────────────────────────────
    drawXDates(ctx, bars, px, H - 4, padL, W - padR);

  }, [bars, entryPrice, stopLoss, takeProfit, trailingStop, entryTime, exitTime, height, showIndicators, bucket, effectiveTrail]);

  function drawXDates(ctx: CanvasRenderingContext2D, bars: any[], px: (i: number) => number, y: number, minX: number, maxX: number) {
    ctx.fillStyle = "hsl(210, 10%, 40%)";
    ctx.font = "9px Inter, sans-serif";
    ctx.textAlign = "center";
    const step = Math.max(1, Math.floor(bars.length / 7));
    bars.forEach((b: any, i: number) => {
      if (i % step === 0) {
        const d = new Date(b.t);
        const label = `${d.getMonth() + 1}/${d.getDate()}`;
        const x = px(i);
        if (x > minX + 10 && x < maxX - 10) ctx.fillText(label, x, y);
      }
    });
  }

  if (isLoading) return <Skeleton className="w-full rounded-lg" style={{ height }} />;
  if (!bars?.length) return (
    <div className="flex items-center justify-center text-muted-foreground text-xs rounded-lg bg-card" style={{ height }}>
      No chart data available
    </div>
  );

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height, display: "block", borderRadius: "0.5rem" }}
      data-testid={`chart-${symbol}`}
    />
  );
}
