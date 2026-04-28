import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Play, Square, RefreshCw, TrendingUp, TrendingDown, DollarSign, Activity, AlertTriangle } from "lucide-react";
import StockChart from "@/components/StockChart";
import EquityChart from "@/components/EquityChart";

const bucketColor: Record<string, string> = {
  volatile: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  swing: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  longterm: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
};

function PnlBadge({ value, pct }: { value: number; pct?: number }) {
  const pos = value >= 0;
  return (
    <span className={`tabular-nums font-semibold ${pos ? "text-emerald-400" : "text-red-400"}`}>
      {pos ? "+" : ""}{value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 })}
      {pct !== undefined && <span className="text-xs ml-1">({pos ? "+" : ""}{pct.toFixed(2)}%)</span>}
    </span>
  );
}

function KpiCard({ label, value, sub, icon: Icon, trend }: any) {
  return (
    <Card data-testid={`kpi-${label.toLowerCase().replace(/\s/g,"-")}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-muted-foreground mb-1">{label}</p>
            <p className="text-xl font-bold tabular-nums text-foreground">{value}</p>
            {sub && <p className={`text-xs mt-0.5 tabular-nums ${typeof trend === "number" ? (trend >= 0 ? "text-emerald-400" : "text-red-400") : "text-muted-foreground"}`}>{sub}</p>}
          </div>
          {Icon && <div className="p-2 rounded-lg bg-primary/10"><Icon className="w-4 h-4 text-primary" /></div>}
        </div>
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const { toast } = useToast();

  const { data: account, isLoading: acctLoading } = useQuery({
    queryKey: ["/api/account"],
    queryFn: () => apiRequest("GET", "/api/account").then(r => r.json()),
    refetchInterval: 15000,
  });

  const { data: botStatus } = useQuery({
    queryKey: ["/api/bot/status"],
    queryFn: () => apiRequest("GET", "/api/bot/status").then(r => r.json()),
    refetchInterval: 5000,
  });

  const { data: positions } = useQuery({
    queryKey: ["/api/positions"],
    queryFn: () => apiRequest("GET", "/api/positions").then(r => r.json()),
    refetchInterval: 15000,
  });

  const { data: trades } = useQuery({
    queryKey: ["/api/trades"],
    queryFn: () => apiRequest("GET", "/api/trades?limit=10").then(r => r.json()),
    refetchInterval: 30000,
  });

  const { data: snapshots } = useQuery({
    queryKey: ["/api/snapshots"],
    queryFn: () => apiRequest("GET", "/api/snapshots").then(r => r.json()),
    refetchInterval: 60000,
  });

  const startBot = useMutation({
    mutationFn: () => apiRequest("POST", "/api/bot/start").then(r => r.json()),
    onSuccess: (d) => { queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] }); toast({ title: "Bot started", description: d.message }); },
  });

  const stopBot = useMutation({
    mutationFn: () => apiRequest("POST", "/api/bot/stop").then(r => r.json()),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] }); toast({ title: "Bot stopped" }); },
  });

  const runNow = useMutation({
    mutationFn: () => apiRequest("POST", "/api/bot/run-now").then(r => r.json()),
    onSuccess: (d) => {
      queryClient.invalidateQueries({ queryKey: ["/api/positions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/account"] });
      toast({ title: "Cycle complete", description: d.message });
    },
  });

  const equity = account ? parseFloat(account.equity) : 0;
  const lastEquity = account ? parseFloat(account.last_equity) : 0;
  const dailyPnl = equity - lastEquity;
  const dailyPnlPct = lastEquity > 0 ? (dailyPnl / lastEquity) * 100 : 0;
  const cash = account ? parseFloat(account.cash) : 0;
  const bp = account ? parseFloat(account.buying_power) : 0;
  const openCount = positions?.length || 0;
  const totalPnl = equity - 100000; // negative means loss vs starting balance

  const bucketCounts = {
    volatile: positions?.filter((p: any) => p.bucket === "volatile").length || 0,
    swing: positions?.filter((p: any) => p.bucket === "swing").length || 0,
    longterm: positions?.filter((p: any) => p.bucket === "longterm").length || 0,
  };

  const winTrades = trades?.filter((t: any) => t.pnl > 0) || [];
  const winRate = trades?.length ? (winTrades.length / trades.length * 100).toFixed(0) : "—";
  const totalTradePnl = trades?.reduce((s: number, t: any) => s + t.pnl, 0) || 0;

  const isRunning = botStatus?.botRunning;
  const circuitBreaker = botStatus?.circuitBreakerActive;

  return (
    <div className="p-5 space-y-5 max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground">Trading Dashboard</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {account?.marketOpen ? "🟢 Market Open" : "🔴 Market Closed"} · Paper Trading
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm" variant="outline"
            onClick={() => runNow.mutate()}
            disabled={runNow.isPending}
            data-testid="button-run-now"
          >
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${runNow.isPending ? "animate-spin" : ""}`} />
            Run Now
          </Button>
          {isRunning ? (
            <Button size="sm" variant="destructive" onClick={() => stopBot.mutate()} disabled={stopBot.isPending} data-testid="button-stop-bot">
              <Square className="w-3.5 h-3.5 mr-1.5" /> Stop Bot
            </Button>
          ) : (
            <Button size="sm" onClick={() => startBot.mutate()} disabled={startBot.isPending} data-testid="button-start-bot">
              <Play className="w-3.5 h-3.5 mr-1.5" /> Start Bot
            </Button>
          )}
        </div>
      </div>

      {/* Circuit breaker warning */}
      {circuitBreaker && (
        <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-red-400 text-sm">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>Circuit breaker active — daily loss limit hit. New entries halted for 24h.</span>
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {acctLoading ? Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-24" />) : <>
          <KpiCard label="Portfolio Value" value={equity.toLocaleString("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0})} sub={`${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(0)} (${dailyPnlPct >= 0?"+":""}${dailyPnlPct.toFixed(2)}%) today`} trend={dailyPnl} icon={DollarSign} />
          <KpiCard label="Total P&L" value={`${totalPnl >= 0 ? "+" : "-"}$${Math.abs(totalPnl).toFixed(0)}`} sub="vs $100k starting" trend={totalPnl} icon={TrendingUp} />
          <KpiCard label="Open Positions" value={openCount} sub={`${bucketCounts.volatile}V · ${bucketCounts.swing}S · ${bucketCounts.longterm}L`} icon={Activity} />
          <KpiCard label="Win Rate" value={`${winRate}%`} sub={`${trades?.length || 0} closed trades · $${totalTradePnl.toFixed(0)} P&L`} trend={totalTradePnl} icon={TrendingDown} />
        </>}
      </div>

      {/* Portfolio equity chart */}
      <Card>
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-semibold">Portfolio Equity</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <EquityChart height={160} />
        </CardContent>
      </Card>

      {/* Bucket allocation bars */}
      <Card>
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-semibold">Bucket Allocation</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-2">
          {[
            { key: "volatile", label: "Volatile Momentum", target: 35, color: "bg-orange-400" },
            { key: "swing", label: "CANSLIM Swing", target: 35, color: "bg-blue-400" },
            { key: "longterm", label: "Long-Term Holds", target: 30, color: "bg-emerald-400" },
          ].map(({ key, label, target, color }) => {
            const cnt = (positions?.filter((p: any) => p.bucket === key).length || 0);
            const maxPos = key === "volatile" ? 7 : key === "swing" ? 5 : 6;
            const used = cnt / maxPos * target;
            return (
              <div key={key} className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{label}</span>
                  <span>{cnt}/{maxPos} positions · target {target}%</span>
                </div>
                <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                  <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${Math.min(100, used / target * 100)}%` }} />
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Open positions with charts */}
      <div>
        <h2 className="text-sm font-semibold text-foreground mb-3">Open Positions</h2>
        {!positions?.length ? (
          <Card><CardContent className="py-10 text-center text-muted-foreground text-sm">No open positions. Start the bot to begin scanning.</CardContent></Card>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {positions.map((pos: any) => {
              const pnl = (pos.currentPrice - pos.entryPrice) * pos.shares;
              const pnlPct = (pos.currentPrice - pos.entryPrice) / pos.entryPrice * 100;
              let reasons: string[] = [];
              try { reasons = JSON.parse(pos.entryReason || "[]"); } catch { reasons = pos.entryReason ? [pos.entryReason] : []; }
              const tf = pos.bucket === "volatile" ? "15Min" : "1Day";
              return (
                <Card key={pos.id} data-testid={`card-position-${pos.id}`}>
                  <CardHeader className="pb-2 pt-3 px-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-foreground">{pos.symbol}</span>
                        <Badge variant="outline" className={`text-xs ${bucketColor[pos.bucket]}`}>{pos.bucket}</Badge>
                        <Badge variant="outline" className={`text-xs ${pos.convictionScore >= 70 ? "text-emerald-400 border-emerald-500/30" : pos.convictionScore >= 45 ? "text-yellow-400 border-yellow-500/30" : "text-red-400 border-red-500/30"}`}>
                          {pos.convictionScore}% conviction
                        </Badge>
                      </div>
                      <PnlBadge value={pnl} pct={pnlPct} />
                    </div>
                    <div className="flex gap-3 text-xs text-muted-foreground mt-1 tabular-nums">
                      <span>{pos.shares} shares @ ${pos.entryPrice.toFixed(2)}</span>
                      <span>·</span>
                      <span>Now ${pos.currentPrice.toFixed(2)}</span>
                      <span>·</span>
                      <span>Stop ${pos.stopLoss.toFixed(2)}</span>
                    </div>
                  </CardHeader>
                  <CardContent className="px-4 pb-3 space-y-2">
                    <StockChart
                      symbol={pos.symbol}
                      timeframe={tf}
                      entryPrice={pos.entryPrice}
                      stopLoss={pos.stopLoss}
                      takeProfit={pos.takeProfit}
                      height={180}
                    />
                    {reasons.length > 0 && (
                      <div>
                        <p className="text-xs text-muted-foreground font-medium mb-1">Why the bot bought:</p>
                        <ul className="space-y-0.5">
                          {reasons.slice(0, 4).map((r: string, i: number) => (
                            <li key={i} className="text-xs text-muted-foreground flex gap-1.5">
                              <span className="text-primary mt-0.5 flex-shrink-0">›</span>
                              <span>{r}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Recent trades */}
      {trades?.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-foreground mb-3">Recent Trades</h2>
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border">
                    {["Symbol","Bucket","Shares","Entry","Exit","P&L","Reason"].map(h => (
                      <th key={h} className="text-left text-muted-foreground font-medium px-4 py-2.5">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {trades.slice(0, 8).map((t: any) => (
                    <tr key={t.id} className="border-b border-border/50 hover:bg-secondary/50 transition-colors">
                      <td className="px-4 py-2.5 font-semibold text-foreground">{t.symbol}</td>
                      <td className="px-4 py-2.5"><Badge variant="outline" className={`text-xs ${bucketColor[t.bucket]}`}>{t.bucket}</Badge></td>
                      <td className="px-4 py-2.5 tabular-nums">{t.shares}</td>
                      <td className="px-4 py-2.5 tabular-nums">${t.entryPrice.toFixed(2)}</td>
                      <td className="px-4 py-2.5 tabular-nums">${t.exitPrice.toFixed(2)}</td>
                      <td className="px-4 py-2.5"><PnlBadge value={t.pnl} pct={t.pnlPct} /></td>
                      <td className="px-4 py-2.5 text-muted-foreground max-w-32 truncate">{t.closeReason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Bot status */}
      {botStatus?.lastRunStatus && (
        <Card>
          <CardContent className="px-4 py-3">
            <p className="text-xs text-muted-foreground font-medium mb-1">Last bot cycle</p>
            <p className="text-xs text-foreground">{botStatus.lastRunStatus}</p>
            {botStatus.lastRunAt && <p className="text-xs text-muted-foreground mt-0.5">{new Date(botStatus.lastRunAt).toLocaleString()}</p>}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
