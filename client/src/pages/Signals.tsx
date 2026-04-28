import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCw } from "lucide-react";

const bucketColor: Record<string, string> = {
  volatile: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  swing: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  longterm: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
};

const signalColor: Record<string, string> = {
  entry: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  exit: "bg-red-500/15 text-red-400 border-red-500/30",
  conviction_drop: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
};

function ScanPanel({ bucket }: { bucket: string }) {
  const { toast } = useToast();
  const { data, mutate, isPending } = useMutation({
    mutationFn: () => apiRequest("GET", `/api/scan/${bucket}`).then(r => r.json()),
    onError: () => toast({ title: "Scan failed", variant: "destructive" }),
  });

  return (
    <Card>
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold capitalize">{bucket} Scan</CardTitle>
          <Button size="sm" variant="outline" onClick={() => mutate()} disabled={isPending} data-testid={`button-scan-${bucket}`}>
            <RefreshCw className={`w-3 h-3 mr-1.5 ${isPending ? "animate-spin" : ""}`} />
            Scan Now
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {isPending && <div className="text-xs text-muted-foreground">Scanning universe...</div>}
        {data && !data.length && <div className="text-xs text-muted-foreground">No signals found in current conditions.</div>}
        {data && data.length > 0 && (
          <div className="space-y-2">
            {data.slice(0, 5).map((sig: any, i: number) => (
              <div key={i} className="bg-secondary/40 rounded-lg p-3 space-y-2" data-testid={`signal-${sig.symbol}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-foreground">{sig.symbol}</span>
                    <Badge variant="outline" className={bucketColor[sig.bucket]}>{sig.bucket}</Badge>
                  </div>
                  <div className="text-xs text-right tabular-nums">
                    <span className="text-foreground font-semibold">{sig.convictionScore}%</span>
                    <span className="text-muted-foreground ml-1">conviction</span>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div><span className="text-muted-foreground">Entry </span><span className="text-foreground tabular-nums">${sig.entryPrice?.toFixed(2)}</span></div>
                  <div><span className="text-muted-foreground">Stop </span><span className="text-red-400 tabular-nums">${sig.stopLoss?.toFixed(2)}</span></div>
                  <div><span className="text-muted-foreground">Target </span><span className="text-emerald-400 tabular-nums">${sig.takeProfit?.toFixed(2)}</span></div>
                </div>
                {sig.indicators && (
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {sig.indicators.rsi !== undefined && <span>RSI {sig.indicators.rsi.toFixed(1)}</span>}
                    {sig.indicators.volumeRatio !== undefined && <span>Vol {sig.indicators.volumeRatio.toFixed(1)}x</span>}
                    {sig.indicators.roc !== undefined && <span>ROC {sig.indicators.roc.toFixed(1)}%</span>}
                    {sig.indicators.rsRating !== undefined && <span>RS {sig.indicators.rsRating.toFixed(0)}</span>}
                  </div>
                )}
                <ul className="space-y-0.5">
                  {sig.reasons?.slice(0, 3).map((r: string, j: number) => (
                    <li key={j} className="text-xs text-muted-foreground flex gap-1.5">
                      <span className="text-primary flex-shrink-0">›</span>{r}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Signals() {
  const { data: signals, isLoading } = useQuery({
    queryKey: ["/api/signals"],
    queryFn: () => apiRequest("GET", "/api/signals").then(r => r.json()),
    refetchInterval: 15000,
  });

  return (
    <div className="p-5 space-y-5 max-w-7xl">
      <h1 className="text-xl font-bold text-foreground">Signals & Scanner</h1>

      {/* Manual scan panels */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <ScanPanel bucket="volatile" />
        <ScanPanel bucket="swing" />
        <ScanPanel bucket="longterm" />
      </div>

      {/* Signal log */}
      <div>
        <h2 className="text-sm font-semibold text-foreground mb-3">Signal Log</h2>
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-2">{Array(5).fill(0).map((_,i)=><Skeleton key={i} className="h-10"/>)}</div>
            ) : !signals?.length ? (
              <div className="py-10 text-center text-muted-foreground text-sm">No signals logged yet</div>
            ) : (
              <div className="divide-y divide-border">
                {signals.map((sig: any) => {
                  let details: any = {};
                  try { details = JSON.parse(sig.details || "{}"); } catch {}
                  return (
                    <div key={sig.id} className="px-4 py-3 flex items-start gap-3 hover:bg-secondary/30 transition-colors" data-testid={`log-signal-${sig.id}`}>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-sm text-foreground">{sig.symbol}</span>
                          <Badge variant="outline" className={`text-xs ${signalColor[sig.signalType] || ""}`}>{sig.signalType}</Badge>
                          <Badge variant="outline" className={`text-xs ${bucketColor[sig.bucket]}`}>{sig.bucket}</Badge>
                        </div>
                        {details.reasons && (
                          <p className="text-xs text-muted-foreground mt-0.5 truncate">{details.reasons?.slice(0, 2).join(" · ")}</p>
                        )}
                        {details.reason && (
                          <p className="text-xs text-muted-foreground mt-0.5">{details.reason}</p>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground whitespace-nowrap flex-shrink-0">
                        {new Date(sig.createdAt).toLocaleString()}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
