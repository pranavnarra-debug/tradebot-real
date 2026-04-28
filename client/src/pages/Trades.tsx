import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronDown, ChevronUp, BarChart2 } from "lucide-react";
import StockChart from "@/components/StockChart";

const bucketColor: Record<string, string> = {
  volatile: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  swing:    "bg-blue-500/15 text-blue-400 border-blue-500/30",
  longterm: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
};

const bucketTimeframe: Record<string, string> = {
  volatile: "15Min",
  swing:    "1Day",
  longterm: "1Day",
};

export default function Trades() {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data: trades, isLoading } = useQuery({
    queryKey: ["/api/trades"],
    queryFn: () => apiRequest("GET", "/api/trades?limit=200").then(r => r.json()),
    refetchInterval: 30000,
  });

  if (isLoading) return (
    <div className="p-5 space-y-2">
      {Array(5).fill(0).map((_, i) => <Skeleton key={i} className="h-12" />)}
    </div>
  );

  const wins   = trades?.filter((t: any) => t.pnl > 0)  || [];
  const losses = trades?.filter((t: any) => t.pnl <= 0) || [];
  const totalPnl = trades?.reduce((s: number, t: any) => s + t.pnl, 0) || 0;
  const avgWin  = wins.length   ? wins.reduce((s: number, t: any)   => s + t.pnlPct, 0) / wins.length   : 0;
  const avgLoss = losses.length ? losses.reduce((s: number, t: any) => s + t.pnlPct, 0) / losses.length : 0;

  return (
    <div className="p-5 space-y-5 max-w-7xl">
      <h1 className="text-xl font-bold text-foreground">Trade History</h1>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          ["Total P&L",  `${totalPnl >= 0 ? "+" : ""}$${Math.abs(totalPnl).toFixed(2)}`, totalPnl >= 0 ? "text-emerald-400" : "text-red-400"],
          ["Win Rate",   trades?.length ? `${(wins.length / trades.length * 100).toFixed(0)}%` : "—", "text-foreground"],
          ["Avg Win",    `+${avgWin.toFixed(2)}%`,  "text-emerald-400"],
          ["Avg Loss",   `${avgLoss.toFixed(2)}%`,  "text-red-400"],
        ].map(([l, v, c]) => (
          <Card key={l}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{l}</p>
              <p className={`text-xl font-bold tabular-nums mt-0.5 ${c}`}>{v}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Trades table */}
      <Card>
        <CardContent className="p-0">
          {!trades?.length ? (
            <div className="py-16 text-center text-muted-foreground text-sm">No closed trades yet</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border">
                    {["", "Symbol", "Bucket", "Shares", "Entry", "Exit", "P&L", "P&L %", "Duration", "Close Reason", "Opened"].map(h => (
                      <th key={h} className="text-left text-muted-foreground font-medium px-4 py-3 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t: any) => {
                    const isExpanded = expandedId === t.id;
                    const tf = bucketTimeframe[t.bucket] || "1Day";
                    return (
                      <>
                        {/* Main row */}
                        <tr
                          key={t.id}
                          className={`border-b border-border/50 hover:bg-secondary/40 transition-colors cursor-pointer ${isExpanded ? "bg-secondary/30" : ""}`}
                          onClick={() => setExpandedId(isExpanded ? null : t.id)}
                          data-testid={`row-trade-${t.id}`}
                        >
                          {/* Expand toggle */}
                          <td className="px-3 py-2.5 text-muted-foreground">
                            {isExpanded
                              ? <ChevronUp className="w-3.5 h-3.5" />
                              : <ChevronDown className="w-3.5 h-3.5" />}
                          </td>
                          <td className="px-4 py-2.5 font-semibold text-foreground">
                            <span className="flex items-center gap-1.5">
                              <BarChart2 className="w-3 h-3 text-muted-foreground" />
                              {t.symbol}
                            </span>
                          </td>
                          <td className="px-4 py-2.5">
                            <Badge variant="outline" className={`text-xs ${bucketColor[t.bucket]}`}>{t.bucket}</Badge>
                          </td>
                          <td className="px-4 py-2.5 tabular-nums">{t.shares}</td>
                          <td className="px-4 py-2.5 tabular-nums">${t.entryPrice.toFixed(2)}</td>
                          <td className="px-4 py-2.5 tabular-nums">${t.exitPrice.toFixed(2)}</td>
                          <td className={`px-4 py-2.5 tabular-nums font-semibold ${t.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                            {t.pnl >= 0 ? "+" : ""}
                            {t.pnl.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 })}
                          </td>
                          <td className={`px-4 py-2.5 tabular-nums ${t.pnlPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                            {t.pnlPct >= 0 ? "+" : ""}{t.pnlPct.toFixed(2)}%
                          </td>
                          <td className="px-4 py-2.5 text-muted-foreground tabular-nums">
                            {t.durationHours < 24 ? `${t.durationHours.toFixed(1)}h` : `${(t.durationHours / 24).toFixed(1)}d`}
                          </td>
                          <td className="px-4 py-2.5 text-muted-foreground max-w-40 truncate">{t.closeReason}</td>
                          <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">
                            {new Date(t.openedAt).toLocaleDateString()}
                          </td>
                        </tr>

                        {/* Expanded chart row */}
                        {isExpanded && (
                          <tr key={`chart-${t.id}`} className="border-b border-border/50 bg-card/50">
                            <td colSpan={11} className="px-4 py-4">
                              <div className="space-y-2">
                                {/* Trade summary header */}
                                <div className="flex items-center gap-4 text-xs text-muted-foreground pb-1">
                                  <span className="font-semibold text-foreground text-sm">{t.symbol} — Indicator Replay</span>
                                  <span className="text-xs bg-secondary px-2 py-0.5 rounded">{tf} bars</span>
                                  <span>
                                    Entry: <span className="text-blue-400 font-mono">${t.entryPrice.toFixed(2)}</span>
                                  </span>
                                  <span>
                                    Exit: <span className={`font-mono ${t.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>${t.exitPrice.toFixed(2)}</span>
                                  </span>
                                  <span>
                                    Result: <span className={`font-semibold ${t.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                                      {t.pnl >= 0 ? "+" : ""}{t.pnlPct.toFixed(2)}%
                                    </span>
                                  </span>
                                  <span className="ml-auto text-muted-foreground/60 italic">
                                    Click row again to collapse
                                  </span>
                                </div>

                                {/* The full chart with all indicators + entry/exit arrows */}
                                <StockChart
                                  symbol={t.symbol}
                                  timeframe={tf}
                                  entryPrice={t.entryPrice}
                                  exitPrice={t.exitPrice}
                                  stopLoss={t.stopLoss ?? undefined}
                                  takeProfit={t.takeProfit ?? undefined}
                                  entryTime={t.openedAt}
                                  exitTime={t.closedAt}
                                  bucket={t.bucket}
                                  height={460}
                                  showIndicators={true}
                                />

                                {/* Close reason footer */}
                                {t.closeReason && (
                                  <div className="flex items-center gap-2 pt-1">
                                    <span className="text-xs text-muted-foreground">Close reason:</span>
                                    <span className="text-xs text-foreground/80 bg-secondary px-2 py-0.5 rounded font-mono">{t.closeReason}</span>
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground text-center pb-2">
        Click any trade row to see the full indicator chart with entry & exit markers
      </p>
    </div>
  );
}
