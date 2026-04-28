import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";

interface Props {
  height?: number;
}

export default function EquityChart({ height = 160 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const { data: snapshots, isLoading } = useQuery({
    queryKey: ["/api/snapshots"],
    queryFn: () => apiRequest("GET", "/api/snapshots").then(r => r.json()),
    refetchInterval: 60000,
  });

  useEffect(() => {
    if (!snapshots?.length || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const W = canvas.offsetWidth;
    const H = height;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    const pad = { top: 16, right: 12, bottom: 24, left: 62 };
    const chartW = W - pad.left - pad.right;
    const chartH = H - pad.top - pad.bottom;

    const values = snapshots.map((s: any) => s.totalValue);
    const timestamps = snapshots.map((s: any) => s.recordedAt);
    const n = values.length;

    const minV = Math.min(...values) * 0.9995;
    const maxV = Math.max(...values) * 1.0005;

    const px = (i: number) => pad.left + (i / (n - 1)) * chartW;
    const py = (v: number) => pad.top + ((maxV - v) / (maxV - minV)) * chartH;

    // Background
    ctx.fillStyle = "hsl(220, 18%, 7%)";
    ctx.fillRect(0, 0, W, H);

    // Grid
    for (let i = 0; i <= 4; i++) {
      const v = minV + (maxV - minV) * (i / 4);
      const y = py(v);
      ctx.strokeStyle = "hsl(220, 15%, 13%)";
      ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
      ctx.fillStyle = "hsl(210, 10%, 45%)";
      ctx.font = "9px Inter, sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(`$${v >= 1000 ? (v/1000).toFixed(1)+"k" : v.toFixed(0)}`, pad.left - 3, y + 3);
    }

    const isPositive = values[n - 1] >= values[0];
    const lineColor = isPositive ? "hsl(142, 76%, 45%)" : "hsl(0, 72%, 51%)";

    // Bucket value area fills
    const volatileVals = snapshots.map((s: any) => s.volatileBucketValue);
    const swingVals = snapshots.map((s: any) => s.swingBucketValue);
    const longtermVals = snapshots.map((s: any) => s.longtermBucketValue);

    const drawAreaFill = (vals: number[], color: string, baseVal: number) => {
      if (vals.every(v => v === 0)) return;
      ctx.beginPath();
      ctx.moveTo(px(0), py(baseVal));
      vals.forEach((v, i) => ctx.lineTo(px(i), py(baseVal + v)));
      ctx.lineTo(px(n - 1), py(baseVal));
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    };

    const cashBase = snapshots[0]?.cashValue || 0;
    drawAreaFill(longtermVals, "hsl(142 76% 45% / 0.12)", cashBase);
    drawAreaFill(swingVals, "hsl(207 100% 55% / 0.12)", cashBase);
    drawAreaFill(volatileVals, "hsl(35 100% 55% / 0.12)", cashBase);

    // Gradient fill under equity line
    const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + chartH);
    gradient.addColorStop(0, isPositive ? "hsl(142 76% 45% / 0.2)" : "hsl(0 72% 51% / 0.15)");
    gradient.addColorStop(1, "transparent");

    ctx.beginPath();
    ctx.moveTo(px(0), py(values[0]));
    values.forEach((v, i) => { if (i > 0) ctx.lineTo(px(i), py(v)); });
    ctx.lineTo(px(n - 1), pad.top + chartH);
    ctx.lineTo(px(0), pad.top + chartH);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // Equity line
    ctx.beginPath();
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    values.forEach((v, i) => {
      if (i === 0) ctx.moveTo(px(i), py(v)); else ctx.lineTo(px(i), py(v));
    });
    ctx.stroke();

    // Starting line ($100k)
    const startY = py(100000);
    if (startY > pad.top && startY < pad.top + chartH) {
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "hsl(210 10% 35%)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.left, startY); ctx.lineTo(W - pad.right, startY); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "hsl(210 10% 45%)";
      ctx.font = "8px Inter"; ctx.textAlign = "left";
      ctx.fillText("$100k start", pad.left + 2, startY - 2);
    }

    // Current value dot
    ctx.beginPath();
    ctx.arc(px(n - 1), py(values[n - 1]), 4, 0, Math.PI * 2);
    ctx.fillStyle = lineColor;
    ctx.fill();

    // Current value label
    ctx.fillStyle = lineColor;
    ctx.font = "bold 10px Inter";
    ctx.textAlign = "right";
    ctx.fillText(`$${values[n-1].toLocaleString("en-US", { maximumFractionDigits: 0 })}`, W - pad.right - 6, py(values[n-1]) - 6);

    // X-axis timestamps
    ctx.fillStyle = "hsl(210, 10%, 40%)";
    ctx.font = "9px Inter";
    ctx.textAlign = "center";
    const step = Math.max(1, Math.floor(n / 6));
    timestamps.forEach((t: string, i: number) => {
      if (i % step === 0) {
        const d = new Date(t);
        const label = `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,"0")}`;
        const x = px(i);
        if (x > pad.left + 10 && x < W - pad.right - 10) ctx.fillText(label, x, H - 4);
      }
    });

    // Legend
    ctx.font = "9px Inter"; ctx.textAlign = "left";
    const leg = [["Volatile", "hsl(35 100% 55%)"], ["Swing", "hsl(207 100% 55%)"], ["Long-term", "hsl(142 76% 45%)"]];
    let lx = pad.left + 4;
    leg.forEach(([label, color]) => {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(lx + 3, pad.top + 10, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "hsl(210 10% 55%)";
      ctx.fillText(label, lx + 9, pad.top + 13);
      lx += ctx.measureText(label).width + 20;
    });

  }, [snapshots, height]);

  if (isLoading) return <Skeleton className="w-full rounded-lg" style={{ height }} />;
  if (!snapshots?.length) return (
    <div className="flex items-center justify-center text-muted-foreground text-xs rounded-lg bg-card border border-border" style={{ height }}>
      No portfolio history yet — start the bot to begin tracking
    </div>
  );

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height, display: "block", borderRadius: "0.5rem" }}
      data-testid="equity-chart"
    />
  );
}
