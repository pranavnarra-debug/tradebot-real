/**
 * InteractiveStockChart — TradingView-style canvas chart
 *
 * Interactions:
 *  - Drag left/right  → pan time axis
 *  - Scroll wheel     → zoom in/out on bar count
 *  - Drag on Y-axis   → compress/expand price range
 *  - Double-click     → reset to default view
 */
import { useEffect, useRef, useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";
import { RotateCcw } from "lucide-react";

interface Props {
  symbol: string;
  timeframe?: string;
  entryPrice?: number;
  stopLoss?: number;
  trailingStop?: number;
  entryTime?: string;
  exitTime?: string;
  exitPrice?: number;
  bucket?: string;
  height?: number;
  showIndicators?: boolean;
}

// ── Indicator math ────────────────────────────────────────────────────────
function calcSMA(vals: number[], p: number) {
  return vals.map((_, i) => i < p - 1 ? NaN : vals.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p);
}
function calcEMA(vals: number[], p: number) {
  const k = 2 / (p + 1);
  return vals.reduce((acc: number[], v, i) => {
    acc.push(i === 0 ? v : v * k + acc[i - 1] * (1 - k));
    return acc;
  }, []);
}
function calcRSI(closes: number[], p = 14) {
  const result: number[] = new Array(p).fill(NaN);
  let ag = 0, al = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) ag += d; else al -= d; }
  ag /= p; al /= p;
  result.push(100 - 100 / (1 + (al === 0 ? 1e10 : ag / al)));
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (p - 1) + Math.max(d, 0)) / p;
    al = (al * (p - 1) + Math.max(-d, 0)) / p;
    result.push(100 - 100 / (1 + (al === 0 ? 1e10 : ag / al)));
  }
  return result;
}
function calcMACD(closes: number[]) {
  const fast = calcEMA(closes, 12), slow = calcEMA(closes, 26);
  const macdLine = fast.map((v, i) => v - slow[i]);
  const signal = new Array(25).fill(NaN).concat(calcEMA(macdLine.slice(25), 9));
  const hist = macdLine.map((v, i) => isNaN(signal[i]) ? NaN : v - signal[i]);
  return { macdLine, signal, hist };
}
function calcBB(closes: number[], p = 20, s = 2) {
  const mid = calcSMA(closes, p);
  const band = (sign: 1 | -1) => mid.map((m, i) => {
    if (isNaN(m)) return NaN;
    const sl = closes.slice(i - p + 1, i + 1);
    return m + sign * s * Math.sqrt(sl.reduce((a, b) => a + (b - m) ** 2, 0) / p);
  });
  return { upper: band(1), mid, lower: band(-1) };
}

// ── Viewport state ────────────────────────────────────────────────────────
interface Viewport {
  barStart: number;   // first visible bar index (float)
  barCount: number;   // how many bars visible
  priceMin: number;   // manual price min override (NaN = auto)
  priceMax: number;   // manual price max override (NaN = auto)
}

export default function InteractiveStockChart({
  symbol, timeframe = "1Day", entryPrice, stopLoss, trailingStop,
  entryTime, exitTime, bucket = "swing",
  height = 520, showIndicators = true,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const { data: bars, isLoading } = useQuery({
    queryKey: ["/api/chart", symbol, timeframe],
    queryFn: () => apiRequest("GET", `/api/chart/${symbol}?timeframe=${timeframe}&limit=300`).then(r => r.json()),
    refetchInterval: 60_000,
  });

  // ── Viewport state (kept in ref for performance, also in state to trigger redraws) ──
  const vpRef = useRef<Viewport>({ barStart: 0, barCount: 100, priceMin: NaN, priceMax: NaN });
  const [vpVersion, setVpVersion] = useState(0); // bumped to force redraw

  const resetView = useCallback(() => {
    if (!bars?.length) return;
    vpRef.current = { barStart: Math.max(0, bars.length - 100), barCount: Math.min(100, bars.length), priceMin: NaN, priceMax: NaN };
    setVpVersion(v => v + 1);
  }, [bars]);

  // Reset whenever bars/timeframe changes
  useEffect(() => { resetView(); }, [resetView]);

  // ── Drag state ────────────────────────────────────────────────────────
  const dragRef = useRef<{
    type: "pan" | "yZoom" | null;
    startX: number;
    startY: number;
    startBarStart: number;
    startBarCount: number;
    startPriceMin: number;
    startPriceMax: number;
    priceRange: number;
  }>({ type: null, startX: 0, startY: 0, startBarStart: 0, startBarCount: 0, startPriceMin: 0, startPriceMax: 0, priceRange: 0 });

  // ── Mouse handlers ─────────────────────────────────────────────────────
  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!bars?.length) return;
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const padL = 58;

    const vp = vpRef.current;
    dragRef.current = {
      type: x < padL ? "yZoom" : "pan",
      startX: e.clientX,
      startY: e.clientY,
      startBarStart: vp.barStart,
      startBarCount: vp.barCount,
      startPriceMin: vp.priceMin,
      startPriceMax: vp.priceMax,
      priceRange: vp.priceMax - vp.priceMin,
    };
    e.preventDefault();
  }, [bars]);

  const onMouseMove = useCallback((e: MouseEvent) => {
    const drag = dragRef.current;
    if (!drag.type || !bars?.length) return;

    const vp = vpRef.current;
    const canvas = canvasRef.current!;
    const W = canvas.offsetWidth;
    const padL = 58, padR = 12;
    const chartW = W - padL - padR;
    const barsPerPx = vp.barCount / chartW;

    if (drag.type === "pan") {
      const dx = e.clientX - drag.startX;
      const delta = dx * barsPerPx;
      const newStart = Math.max(0, Math.min(bars.length - vp.barCount, drag.startBarStart - delta));
      vpRef.current = { ...vp, barStart: newStart };
    } else if (drag.type === "yZoom") {
      // Dragging up on Y-axis = zoom in (narrow range), down = zoom out (wider range)
      const dy = e.clientY - drag.startY;
      const scaleFactor = 1 + dy * 0.005;
      const center = (drag.startPriceMin + drag.startPriceMax) / 2;
      const half = (drag.priceRange / 2) * Math.max(0.1, scaleFactor);
      vpRef.current = { ...vp, priceMin: center - half, priceMax: center + half };
    }

    setVpVersion(v => v + 1);
  }, [bars]);

  const onMouseUp = useCallback(() => {
    dragRef.current.type = null;
  }, []);

  const onWheel = useCallback((e: WheelEvent) => {
    if (!bars?.length) return;
    e.preventDefault();
    const vp = vpRef.current;
    const zoomFactor = e.deltaY > 0 ? 1.15 : 0.87; // scroll down = zoom out, up = zoom in
    const newCount = Math.max(10, Math.min(bars.length, Math.round(vp.barCount * zoomFactor)));

    // Zoom around center of visible window
    const center = vp.barStart + vp.barCount / 2;
    const newStart = Math.max(0, Math.min(bars.length - newCount, center - newCount / 2));
    vpRef.current = { ...vp, barStart: newStart, barCount: newCount };
    setVpVersion(v => v + 1);
  }, [bars]);

  // Attach wheel listener (non-passive so we can preventDefault)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [onWheel, onMouseMove, onMouseUp]);

  // ── Render ─────────────────────────────────────────────────────────────
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

    // ── Viewport ─────────────────────────────────────────────────────────
    const vp = vpRef.current;
    const startIdx = Math.max(0, Math.floor(vp.barStart));
    const endIdx = Math.min(bars.length - 1, Math.ceil(vp.barStart + vp.barCount));
    const visibleBars = bars.slice(startIdx, endIdx + 1);
    const n = visibleBars.length;
    if (n < 2) return;

    const allCloses = bars.map((b: any) => b.c);
    const visCloses = visibleBars.map((b: any) => b.c);
    const visOpens = visibleBars.map((b: any) => b.o);
    const visHighs = visibleBars.map((b: any) => b.h);
    const visLows = visibleBars.map((b: any) => b.l);
    const visVols = visibleBars.map((b: any) => b.v);

    // Indicators computed on full bars, then sliced to visible window
    const allEma9 = calcEMA(allCloses, 9).slice(startIdx, endIdx + 1);
    const allEma21 = calcEMA(allCloses, 21).slice(startIdx, endIdx + 1);
    const allSma50 = calcSMA(allCloses, 50).slice(startIdx, endIdx + 1);
    const allSma200 = calcSMA(allCloses, 200).slice(startIdx, endIdx + 1);
    const allBB = calcBB(allCloses, 20, 2);
    const visBBupper = allBB.upper.slice(startIdx, endIdx + 1);
    const visBBlower = allBB.lower.slice(startIdx, endIdx + 1);
    const visBBmid = allBB.mid.slice(startIdx, endIdx + 1);
    const allRsi = calcRSI(allCloses, 14).slice(startIdx, endIdx + 1);
    const allMacd = calcMACD(allCloses);
    const visMacdLine = allMacd.macdLine.slice(startIdx, endIdx + 1);
    const visMacdSig = allMacd.signal.slice(startIdx, endIdx + 1);
    const visMacdHist = allMacd.hist.slice(startIdx, endIdx + 1);
    const allAvgVol = calcSMA(bars.map((b: any) => b.v), 20).slice(startIdx, endIdx + 1);
    const maxVol = Math.max(...visVols, 1);

    // Layout
    const isVolatile = bucket === "volatile";
    const showSMA200 = !isVolatile && bars.length >= 200;
    const priceH = showIndicators ? H * 0.52 : H * 0.82;
    const volH = H * 0.10;
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

    // ── Helpers ────────────────────────────────────────────────────────
    const px = (i: number) => padL + (i / (n - 1)) * chartW;

    const drawLine = (vals: number[], top: number, panH: number, min: number, max: number, color: string, lw = 1.5) => {
      ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineJoin = "round";
      let started = false;
      vals.forEach((v, i) => {
        if (isNaN(v)) { started = false; return; }
        const y = top + panH - ((v - min) / (max - min)) * panH;
        if (!started) { ctx.moveTo(px(i), y); started = true; } else ctx.lineTo(px(i), y);
      });
      ctx.stroke();
    };

    const drawHLine = (y: number, color: string, dash: number[] = [], label = "", lw = 1) => {
      ctx.save(); ctx.setLineDash(dash); ctx.strokeStyle = color; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.setLineDash([]);
      if (label) { ctx.fillStyle = color; ctx.font = "bold 9px Inter, sans-serif"; ctx.textAlign = "left"; ctx.fillText(label, padL + 2, y - 3); }
      ctx.restore();
    };

    const drawYAxis = (top: number, panH: number, min: number, max: number, steps = 5, prefix = "", decimals = 2) => {
      ctx.fillStyle = "hsl(210, 10%, 45%)"; ctx.font = "9px Inter, sans-serif"; ctx.textAlign = "right";
      for (let i = 0; i <= steps; i++) {
        const v = min + (max - min) * (i / steps);
        const y = top + panH - ((v - min) / (max - min)) * panH;
        ctx.fillText(`${prefix}${v.toFixed(decimals)}`, padL - 3, y + 3);
        ctx.strokeStyle = "hsl(220, 15%, 13%)"; ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      }
    };

    // Y-axis drag hint
    ctx.fillStyle = "hsl(210 10% 30%)";
    ctx.fillRect(0, priceTop, padL - 2, priceH);
    ctx.fillStyle = "hsl(210 10% 50%)";
    ctx.font = "8px Inter";
    ctx.textAlign = "center";
    ctx.fillText("↕ drag", padL / 2, priceTop + priceH / 2);

    // ── Price panel ────────────────────────────────────────────────────
    const effectiveTrail = trailingStop && trailingStop > 1 ? trailingStop : undefined;
    let priceMin: number, priceMax: number;
    if (!isNaN(vp.priceMin) && !isNaN(vp.priceMax)) {
      priceMin = vp.priceMin;
      priceMax = vp.priceMax;
    } else {
      const pVals = [...visHighs, ...visLows];
      if (entryPrice) pVals.push(entryPrice, stopLoss || entryPrice);
      if (effectiveTrail) pVals.push(effectiveTrail);
      priceMin = Math.min(...pVals) * 0.997;
      priceMax = Math.max(...pVals) * 1.003;
      // Sync back so Y-drag has a starting point
      vpRef.current = { ...vp, priceMin, priceMax };
    }
    const pyP = (v: number) => priceTop + priceH - ((v - priceMin) / (priceMax - priceMin)) * priceH;

    drawYAxis(priceTop, priceH, priceMin, priceMax, 5, "$", priceMin > 100 ? 0 : 2);

    // BB fill
    ctx.beginPath();
    visBBupper.forEach((v, i) => { if (!isNaN(v)) { if (i === 0 || isNaN(visBBupper[i-1])) ctx.moveTo(px(i), pyP(v)); else ctx.lineTo(px(i), pyP(v)); } });
    visBBlower.slice().reverse().forEach((v, i) => { const ri = n - 1 - i; if (!isNaN(v)) ctx.lineTo(px(ri), pyP(v)); });
    ctx.closePath(); ctx.fillStyle = "hsl(207 100% 55% / 0.06)"; ctx.fill();

    drawLine(visBBupper, priceTop, priceH, priceMin, priceMax, "hsl(207 100% 55% / 0.35)", 1);
    drawLine(visBBlower, priceTop, priceH, priceMin, priceMax, "hsl(207 100% 55% / 0.35)", 1);
    drawLine(visBBmid,   priceTop, priceH, priceMin, priceMax, "hsl(207 100% 55% / 0.2)", 1);

    if (!isVolatile) {
      if (showSMA200) drawLine(allSma200, priceTop, priceH, priceMin, priceMax, "hsl(280 80% 60% / 0.7)", 1.5);
      drawLine(allSma50, priceTop, priceH, priceMin, priceMax, "hsl(35 100% 55% / 0.8)", 1.5);
    }
    drawLine(allEma21, priceTop, priceH, priceMin, priceMax, "hsl(142 76% 50% / 0.8)", 1.5);
    drawLine(allEma9,  priceTop, priceH, priceMin, priceMax, "hsl(207 100% 65% / 0.9)", 1.5);

    // Candles
    const candleW = Math.max(2, chartW / n - 1.5);
    visibleBars.forEach((b: any, i: number) => {
      const x = px(i);
      const isUp = b.c >= b.o;
      const col = isUp ? "hsl(142, 76%, 45%)" : "hsl(0, 72%, 51%)";
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, pyP(b.h)); ctx.lineTo(x, pyP(b.l)); ctx.stroke();
      const bodyTop = pyP(Math.max(b.o, b.c));
      const bodyH = Math.max(1, Math.abs(pyP(b.o) - pyP(b.c)));
      ctx.fillStyle = col; ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);
    });

    // Overlay lines
    if (entryPrice) drawHLine(pyP(entryPrice), "hsl(207 100% 65%)", [4, 3], `Entry $${entryPrice.toFixed(2)}`);
    if (stopLoss)   drawHLine(pyP(stopLoss),   "hsl(0 72% 60%)",   [3, 3], `Stop $${stopLoss.toFixed(2)}`);
    if (effectiveTrail) drawHLine(pyP(effectiveTrail), "hsl(38 92% 50%)", [4, 4], `Trail activates $${effectiveTrail.toFixed(2)}`);

    // BUY / SELL arrows
    const drawArrow = (timeStr: string, isEntry: boolean) => {
      const absIdx = bars.findIndex((b: any) => b.t >= timeStr);
      if (absIdx < startIdx || absIdx > endIdx) return;
      const visI = absIdx - startIdx;
      const x = px(visI);
      const b = visibleBars[visI];
      if (!b) return;
      if (isEntry) {
        const y = pyP(visLows[visI]) + 14;
        ctx.fillStyle = "hsl(142 76% 55%)";
        ctx.beginPath(); ctx.moveTo(x, y - 10); ctx.lineTo(x - 5, y); ctx.lineTo(x + 5, y); ctx.closePath(); ctx.fill();
        ctx.font = "bold 8px Inter"; ctx.textAlign = "center"; ctx.fillStyle = "hsl(142 76% 55%)";
        ctx.fillText("BUY", x, y + 9);
      } else {
        const y = pyP(visHighs[visI]) - 14;
        ctx.fillStyle = "hsl(0 72% 60%)";
        ctx.beginPath(); ctx.moveTo(x, y + 10); ctx.lineTo(x - 5, y); ctx.lineTo(x + 5, y); ctx.closePath(); ctx.fill();
        ctx.font = "bold 8px Inter"; ctx.textAlign = "center"; ctx.fillStyle = "hsl(0 72% 60%)";
        ctx.fillText("SELL", x, y - 3);
      }
    };
    if (entryTime) drawArrow(entryTime, true);
    if (exitTime)  drawArrow(exitTime,  false);

    // Symbol label + legend
    ctx.fillStyle = "hsl(210 20% 80%)"; ctx.font = "bold 10px Inter"; ctx.textAlign = "left";
    ctx.fillText(symbol, padL + 4, priceTop + 14);

    const legends = isVolatile
      ? [["EMA9","hsl(207 100% 65%)"],["EMA21","hsl(142 76% 50%)"],["BB","hsl(207 100% 55% / 0.5)"]]
      : showSMA200
        ? [["EMA9","hsl(207 100% 65%)"],["EMA21","hsl(142 76% 50%)"],["SMA50","hsl(35 100% 55%)"],["SMA200","hsl(280 80% 60%)"],["BB","hsl(207 100% 55% / 0.5)"]]
        : [["EMA9","hsl(207 100% 65%)"],["EMA21","hsl(142 76% 50%)"],["SMA50","hsl(35 100% 55%)"],["BB","hsl(207 100% 55% / 0.5)"]];
    let lx = W - padR;
    ctx.font = "9px Inter";
    legends.slice().reverse().forEach(([label, color]) => {
      const tw = ctx.measureText(label).width + 14;
      lx -= tw;
      ctx.fillStyle = color as string; ctx.beginPath(); ctx.arc(lx + 4, priceTop + 10, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "hsl(210 10% 60%)"; ctx.textAlign = "left"; ctx.fillText(label, lx + 10, priceTop + 13);
    });

    // ── Volume panel ────────────────────────────────────────────────────
    ctx.fillStyle = "hsl(210 10% 45%)"; ctx.font = "9px Inter"; ctx.textAlign = "left";
    ctx.fillText("VOL", padL + 2, volTop + 10);
    visibleBars.forEach((b: any, i: number) => {
      const x = px(i);
      const vh = (b.v / maxVol) * volH;
      ctx.fillStyle = b.c >= b.o ? "hsl(142 76% 45% / 0.5)" : "hsl(0 72% 51% / 0.5)";
      ctx.fillRect(x - candleW / 2, volTop + volH - vh, candleW, vh);
    });
    const validAvg = allAvgVol.filter(v => !isNaN(v));
    if (validAvg.length) {
      drawLine(allAvgVol.map(v => (v / maxVol) * volH), volTop + volH, volH, 0, volH, "hsl(207 100% 65% / 0.6)", 1);
    }

    if (!showIndicators) {
      drawXDates(ctx, visibleBars, px, H - 8, padL, W - padR);
      return;
    }

    // ── RSI panel ───────────────────────────────────────────────────────
    const pyR = (v: number) => rsiTop + rsiH - ((v - 0) / 100) * rsiH;
    ctx.fillStyle = "hsl(210 10% 45%)"; ctx.font = "9px Inter"; ctx.textAlign = "left";
    ctx.fillText("RSI(14)", padL + 2, rsiTop + 10);
    ctx.fillStyle = "hsl(0 72% 51% / 0.08)"; ctx.fillRect(padL, pyR(70), chartW, pyR(100) - pyR(70));
    ctx.fillStyle = "hsl(142 76% 45% / 0.08)"; ctx.fillRect(padL, pyR(30), chartW, pyR(0) - pyR(30));
    drawHLine(pyR(70), "hsl(0 72% 51% / 0.4)", [2, 2], "70");
    drawHLine(pyR(50), "hsl(210 10% 40% / 0.5)", [2, 2], "50");
    drawHLine(pyR(30), "hsl(142 76% 45% / 0.4)", [2, 2], "30");

    ctx.beginPath(); ctx.lineWidth = 1.5; ctx.lineJoin = "round";
    let rsiStarted = false;
    allRsi.forEach((v, i) => {
      if (isNaN(v)) { rsiStarted = false; return; }
      const y = pyR(v);
      const color = v > 70 ? "hsl(0 72% 60%)" : v < 30 ? "hsl(142 76% 55%)" : "hsl(207 100% 65%)";
      if (!rsiStarted || (i > 0 && isNaN(allRsi[i-1]))) { ctx.stroke(); ctx.beginPath(); ctx.strokeStyle = color; ctx.moveTo(px(i), y); rsiStarted = true; }
      else ctx.lineTo(px(i), y);
    });
    ctx.stroke();

    const curRSI = allRsi[n - 1];
    if (!isNaN(curRSI)) {
      const rsiColor = curRSI > 70 ? "hsl(0 72% 60%)" : curRSI < 30 ? "hsl(142 76% 55%)" : "hsl(207 100% 65%)";
      ctx.fillStyle = rsiColor; ctx.font = "bold 9px Inter"; ctx.textAlign = "right";
      ctx.fillText(curRSI.toFixed(1), W - padR - 2, pyR(curRSI) + 3);
    }

    // ── MACD panel ──────────────────────────────────────────────────────
    const validH = visMacdHist.filter(v => !isNaN(v));
    const macdAbsMax = Math.max(...validH.map(Math.abs), 0.001);
    const macdMin = -macdAbsMax * 1.2, macdMax = macdAbsMax * 1.2;
    const pyM = (v: number) => macdTop + macdH - ((v - macdMin) / (macdMax - macdMin)) * macdH;

    ctx.fillStyle = "hsl(210 10% 45%)"; ctx.font = "9px Inter"; ctx.textAlign = "left";
    ctx.fillText("MACD(12,26,9)", padL + 2, macdTop + 10);
    drawHLine(pyM(0), "hsl(210 10% 35%)", [2, 2]);

    visMacdHist.forEach((v, i) => {
      if (isNaN(v)) return;
      const x = px(i), y0 = pyM(0), y1 = pyM(v);
      ctx.fillStyle = v >= 0 ? "hsl(142 76% 45% / 0.7)" : "hsl(0 72% 51% / 0.7)";
      ctx.fillRect(x - candleW / 2, Math.min(y0, y1), candleW, Math.abs(y0 - y1));
    });
    drawLine(visMacdLine, macdTop, macdH, macdMin, macdMax, "hsl(207 100% 65%)", 1.5);
    drawLine(visMacdSig,  macdTop, macdH, macdMin, macdMax, "hsl(35 100% 55%)", 1.5);
    ctx.font = "9px Inter"; ctx.textAlign = "left";
    ctx.fillStyle = "hsl(207 100% 65%)"; ctx.fillText("MACD", W - padR - 70, macdTop + 10);
    ctx.fillStyle = "hsl(35 100% 55%)";  ctx.fillText("Signal", W - padR - 35, macdTop + 10);

    // ── X-axis dates ─────────────────────────────────────────────────────
    drawXDates(ctx, visibleBars, px, H - 4, padL, W - padR);

    // ── Crosshair hint text ───────────────────────────────────────────────
    ctx.fillStyle = "hsl(210 10% 30%)"; ctx.font = "8px Inter"; ctx.textAlign = "right";
    ctx.fillText("scroll = zoom · drag = pan · drag Y-axis = scale · dbl-click = reset", W - padR - 2, H - 2);

  }, [bars, vpVersion, entryPrice, stopLoss, trailingStop, entryTime, exitTime, height, showIndicators, bucket]);

  function drawXDates(ctx: CanvasRenderingContext2D, visibleBars: any[], px: (i: number) => number, y: number, minX: number, maxX: number) {
    ctx.fillStyle = "hsl(210, 10%, 40%)"; ctx.font = "9px Inter, sans-serif"; ctx.textAlign = "center";
    const step = Math.max(1, Math.floor(visibleBars.length / 7));
    visibleBars.forEach((b: any, i: number) => {
      if (i % step !== 0) return;
      const d = new Date(b.t);
      const label = `${d.getMonth() + 1}/${d.getDate()}`;
      const x = px(i);
      if (x > minX + 10 && x < maxX - 10) ctx.fillText(label, x, y);
    });
  }

  if (isLoading) return <Skeleton className="w-full rounded-lg" style={{ height }} />;
  if (!bars?.length) return (
    <div className="flex items-center justify-center text-muted-foreground text-xs rounded-lg bg-card" style={{ height }}>
      No chart data available
    </div>
  );

  return (
    <div className="relative w-full select-none" style={{ height }}>
      <canvas
        ref={canvasRef}
        onMouseDown={onMouseDown}
        onDoubleClick={resetView}
        style={{ width: "100%", height, display: "block", borderRadius: "0.5rem", cursor: "crosshair" }}
        data-testid={`ichart-${symbol}`}
      />
      {/* Reset button */}
      <button
        onClick={resetView}
        className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground bg-black/40 hover:bg-black/60 border border-border/40 hover:text-foreground transition-colors backdrop-blur-sm"
        title="Reset view (double-click chart)"
      >
        <RotateCcw className="w-3 h-3" />
        Reset
      </button>
    </div>
  );
}
