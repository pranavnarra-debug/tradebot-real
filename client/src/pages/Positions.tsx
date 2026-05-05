import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { X, Maximize2 } from "lucide-react";
import StockChart from "@/components/StockChart";

const bucketColor: Record<string, string> = {
  volatile: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  swing: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  longterm: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
};

function Positions() {
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const { data: account } = useQuery({
    queryKey: ["/api/account"],
    queryFn: () => apiRequest("GET", "/api/account").then(r => r.json()),
    refetchInterval: 60000,
  });
  const marketOpen = account?.marketOpen ?? false;

  const { data: positions, isLoading } = useQuery({
    queryKey: ["/api/positions"],
    queryFn: () => apiRequest("GET", "/api/positions").then(r => r.json()),
    refetchInterval: 30000,
  });

  const closePosition = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/positions/${id}`).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/positions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trades"] });
      toast({ title: "Position closed", description: "Market sell order placed" });
    },
    onError: () => toast({ title: "Error", description: "Failed to close position", variant: "destructive" }),
  });

  if (isLoading) return (
    <div className="p-5 space-y-3">
      <Skeleton className="h-8 w-48" />
      {Array(3).fill(0).map((_, i) => <Skeleton key={i} className="h-64" />)}
    </div>
  );

  return (
    <div className="p-5 space-y-5 max-w-7xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground">Open Positions</h1>
          <p className="text-xs text-muted-foreground mt-0.5">{positions?.length || 0} active positions</p>
        </div>
      </div>

      {!positions?.length ? (
        <Card><CardContent className="py-16 text-center text-muted-foreground">No open positions</CardContent></Card>
      ) : positions.map((pos: any) => {
        const pnl = (pos.currentPrice - pos.entryPrice) * pos.shares;
        const pnlPct = (pos.currentPrice - pos.entryPrice) / pos.entryPrice * 100;
        let reasons: string[] = [];
        try { reasons = JSON.parse(pos.entryReason || "[]"); } catch { reasons = pos.entryReason ? [pos.entryReason] : []; }
        const tf = pos.bucket === "volatile" ? "15Min" : "1Day";
        const heldDays = ((Date.now() - new Date(pos.openedAt).getTime()) / 86400000).toFixed(1);

        return (
          <Card key={pos.id} data-testid={`card-pos-detail-${pos.id}`}>
            <CardHeader className="pb-2 pt-4 px-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-lg font-bold text-foreground">{pos.symbol}</span>
                  <Badge variant="outline" className={bucketColor[pos.bucket]}>{pos.bucket}</Badge>
                  <Badge variant="outline" className={`text-xs ${pos.convictionScore >= 70 ? "text-emerald-400 border-emerald-500/30" : pos.convictionScore >= 45 ? "text-yellow-400 border-yellow-500/30" : "text-red-400 border-red-500/30"}`}>
                    Conviction {pos.convictionScore}%
                  </Badge>
                  <span className="text-xs text-muted-foreground">Held {heldDays}d</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div className="flex items-center gap-1.5">
                      <p className={`font-bold tabular-nums ${pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {pnl >= 0 ? "+" : ""}{pnl.toLocaleString("en-US",{style:"currency",currency:"USD",minimumFractionDigits:2})}
                      </p>
                      {!marketOpen && <Badge variant="outline" className="text-[10px] px-1 py-0 text-yellow-400 border-yellow-500/30">AH</Badge>}
                    </div>
                    <p className={`text-xs tabular-nums ${pnlPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%
                    </p>
                  </div>
                  <Button
                    variant="ghost" size="icon"
                    className="text-muted-foreground hover:text-foreground h-8 w-8"
                    onClick={() => navigate(`/stock/${pos.symbol}`)}
                    title="Full screen"
                  >
                    <Maximize2 className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost" size="icon"
                    className="text-muted-foreground hover:text-red-400 h-8 w-8"
                    onClick={() => closePosition.mutate(pos.id)}
                    disabled={closePosition.isPending}
                    data-testid={`button-close-${pos.id}`}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {/* Position stats */}
              <div className="grid grid-cols-4 gap-3 mt-3">
                {[
                  ["Shares", pos.shares],
                  ["Entry", `$${pos.entryPrice.toFixed(2)}`],
                  ["Current", `$${pos.currentPrice.toFixed(2)}`],
                  ["Value", `$${(pos.currentPrice * pos.shares).toLocaleString("en-US",{maximumFractionDigits:0})}`],
                  ["Stop Loss", `$${pos.stopLoss.toFixed(2)}`],
                  ["Trail At", pos.trailingStop && pos.trailingStop > 1 ? `$${pos.trailingStop.toFixed(2)}` : `$${(pos.entryPrice * (pos.bucket === "volatile" ? 1.08 : 1.10)).toFixed(2)}`],
                  ["Strategy", pos.strategy],
                  ["Peak", `$${(pos.peakPrice || pos.entryPrice).toFixed(2)}`],
                ].map(([label, val]) => (
                  <div key={label} className="bg-secondary/40 rounded-lg p-2.5">
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className="text-sm font-semibold text-foreground tabular-nums mt-0.5">{val}</p>
                  </div>
                ))}
              </div>
            </CardHeader>

            <CardContent className="px-5 pb-5 space-y-4">
              {/* Chart */}
              <div>
                <p className="text-xs text-muted-foreground font-medium mb-2">Price Chart · {tf}</p>
                <StockChart
                  symbol={pos.symbol}
                  timeframe={tf}
                  entryPrice={pos.entryPrice}
                  stopLoss={pos.stopLoss}
                  trailingStop={pos.trailingStop && pos.trailingStop > 1 ? pos.trailingStop : undefined}
                  height={300}
                />
              </div>

              {/* Entry reasons */}
              <div>
                <p className="text-xs text-muted-foreground font-medium mb-2">Entry signals — why the bot bought</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
                  {reasons.map((r: string, i: number) => (
                    <div key={i} className="flex items-start gap-2 bg-primary/5 border border-primary/10 rounded px-2.5 py-1.5">
                      <span className="text-primary font-bold text-sm leading-none mt-0.5">✓</span>
                      <span className="text-xs text-foreground">{r}</span>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

export default Positions;
