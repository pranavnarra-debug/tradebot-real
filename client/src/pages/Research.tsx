import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Search, CheckCircle2, XCircle, AlertCircle,
  TrendingUp, TrendingDown, Minus, ExternalLink,
  Clock, ShoppingCart, Loader2, Maximize2
} from "lucide-react";
import StockChart from "@/components/StockChart";

// ── Types ──────────────────────────────────────────────────────────────────
type Timeframe = "15Min" | "1Hour" | "1Day";
type Bucket = "volatile" | "swing" | "unknown";

// ── Constants ──────────────────────────────────────────────────────────────
const TF_LABELS: Record<Timeframe, string> = { "15Min": "15 Min", "1Hour": "1 Hour", "1Day": "Daily" };

const bucketColor: Record<string, string> = {
  volatile: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  swing:    "bg-blue-500/15 text-blue-400 border-blue-500/30",
  unknown:  "bg-secondary text-muted-foreground border-border",
};

const sentimentColor: Record<string, string> = {
  strongly_positive:   "text-emerald-400",
  moderately_positive: "text-emerald-400",
  mildly_positive:     "text-emerald-400/70",
  neutral:             "text-muted-foreground",
  mildly_negative:     "text-red-400/70",
  moderately_negative: "text-red-400",
  strongly_negative:   "text-red-500",
};

const sentimentBg: Record<string, string> = {
  strongly_positive:   "bg-emerald-500/10 border-emerald-500/20",
  moderately_positive: "bg-emerald-500/10 border-emerald-500/20",
  mildly_positive:     "bg-emerald-500/5 border-emerald-500/10",
  neutral:             "bg-secondary border-border",
  mildly_negative:     "bg-red-500/5 border-red-500/10",
  moderately_negative: "bg-red-500/10 border-red-500/20",
  strongly_negative:   "bg-red-500/15 border-red-500/30",
};

const sentimentLabel: Record<string, string> = {
  strongly_positive:   "Strongly Positive",
  moderately_positive: "Moderately Positive",
  mildly_positive:     "Mildly Positive",
  neutral:             "Neutral",
  mildly_negative:     "Mildly Negative",
  moderately_negative: "Moderately Negative",
  strongly_negative:   "Strongly Negative",
};

// ── Score bar ─────────────────────────────────────────────────────────────
function ScoreBar({ score, threshold }: { score: number; threshold: number }) {
  const pct = Math.min(100, (score / Math.max(threshold, 1)) * 100);
  const over = score >= threshold;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">Signal Score</span>
        <span className={`font-bold tabular-nums ${over ? "text-emerald-400" : "text-red-400"}`}>
          {score} / {threshold} needed
        </span>
      </div>
      <div className="h-2 bg-secondary rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${over ? "bg-emerald-500" : "bg-red-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────
function Research() {
  const [, navigate] = useLocation();
  const [input, setInput]           = useState("");
  const [symbol, setSymbol]         = useState("");
  const [timeframe, setTimeframe]   = useState<Timeframe>("1Day");
  const [bucket, setBucket]         = useState<"volatile" | "swing" | "auto">("auto");
  const [tradeResult, setTradeResult] = useState<any>(null);

  // When bucket changes, auto-set timeframe
  function handleBucketChange(b: typeof bucket) {
    setBucket(b);
    if (b === "volatile") setTimeframe("15Min");
    else if (b === "swing") setTimeframe("1Day");
  }

  // Effective bucket to send to API (if auto, let server decide)
  const effectiveBucket = bucket === "auto" ? undefined : bucket;

  // Research query
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["/api/research", symbol, bucket],
    queryFn: () => apiRequest("GET", `/api/research/${symbol}${effectiveBucket ? `?bucket=${effectiveBucket}` : ""}`).then(r => r.json()),
    enabled: !!symbol,
    retry: false,
  });

  // Scan & Trade mutation
  const tradeMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", `/api/research/${symbol}/trade`, {
        bucket: data?.bucket !== "unknown" ? data?.bucket : undefined,
        timeframe,
      }).then(r => r.json()),
    onSuccess: (result) => {
      setTradeResult(result);
      if (result.traded) {
        queryClient.invalidateQueries({ queryKey: ["/api/positions"] });
        queryClient.invalidateQueries({ queryKey: ["/api/signals"] });
      }
    },
  });

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const ticker = input.trim().toUpperCase();
    if (ticker) {
      setSymbol(ticker);
      setTradeResult(null);
      // Auto-set timeframe based on known bucket
    }
  }

  // Set sensible default timeframe when data loads
  const displayTf: Timeframe = timeframe;

  return (
    <div className="p-5 space-y-5 max-w-6xl">
      <div>
        <h1 className="text-xl font-bold text-foreground">Stock Research</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          See exactly why the bot would or wouldn't trade any stock. Optionally force it to scan and buy if conditions are met.
        </p>
      </div>

      {/* Search + controls */}
      <div className="flex flex-wrap gap-3 items-end">
        <form onSubmit={handleSearch} className="flex gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <input
              value={input}
              onChange={e => setInput(e.target.value.toUpperCase())}
              placeholder="Ticker (e.g. TSLA, F, NVDA)"
              className="bg-secondary border border-border rounded-md pl-8 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary w-56"
              data-testid="input-research-symbol"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <button
            type="submit"
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            data-testid="button-research-search"
          >
            Analyze
          </button>
        </form>

        {/* Bucket selector */}
        <div className="flex items-center gap-1 bg-secondary rounded-md p-1 border border-border">
          {(["auto", "volatile", "swing"] as const).map(b => (
            <button
              key={b}
              onClick={() => handleBucketChange(b)}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                bucket === b
                  ? b === "volatile" ? "bg-orange-500/30 text-orange-300"
                  : b === "swing"    ? "bg-blue-500/30 text-blue-300"
                  : "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              data-testid={`button-bucket-${b}`}
            >
              {b === "auto" ? "Auto" : b.charAt(0).toUpperCase() + b.slice(1)}
            </button>
          ))}
        </div>

        {/* Timeframe selector */}
        <div className="flex items-center gap-1 bg-secondary rounded-md p-1 border border-border">
          {(["15Min", "1Hour", "1Day"] as Timeframe[]).map(tf => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                timeframe === tf
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              data-testid={`button-tf-${tf}`}
            >
              {TF_LABELS[tf]}
            </button>
          ))}
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-64" />
          <Skeleton className="h-48" />
        </div>
      )}

      {/* Error */}
      {isError && (
        <Card className="border-red-500/30 bg-red-500/5">
          <CardContent className="p-4 flex items-center gap-3">
            <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
            <p className="text-sm text-red-400">
              {(error as any)?.message || `No data found for "${symbol}". Check the ticker symbol.`}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {data && !isLoading && (
        <div className="space-y-4">

          {/* Header card */}
          <Card>
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="space-y-1">
                  <div className="flex items-center gap-3 flex-wrap">
                    <h2 className="text-2xl font-bold text-foreground">{data.symbol}</h2>
                    <Badge variant="outline" className={`text-xs ${bucketColor[data.bucket]}`}>
                      {data.bucket === "unknown" ? "Not in bot universe" : `${data.bucket} bucket`}
                    </Badge>
                    {data.coolingActive && (
                      <Badge variant="outline" className="text-xs bg-yellow-500/10 text-yellow-400 border-yellow-500/20">
                        <Clock className="w-3 h-3 mr-1" /> News Cooling
                      </Badge>
                    )}
                  </div>
                  <p className="text-2xl font-bold tabular-nums text-foreground">
                    ${data.currentPrice.toFixed(2)}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => navigate(`/stock/${data.symbol}`)}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-secondary/40 hover:bg-secondary text-xs text-muted-foreground hover:text-foreground transition-colors"
                    title="Open full screen view"
                  >
                    <Maximize2 className="w-3.5 h-3.5" />
                    Full Screen
                  </button>
                </div>

                {/* Buy/Skip verdict */}
                <div className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${data.wouldBuy ? "bg-emerald-500/10 border-emerald-500/30" : "bg-red-500/10 border-red-500/30"}`}>
                  {data.wouldBuy
                    ? <CheckCircle2 className="w-5 h-5 text-emerald-400 flex-shrink-0" />
                    : <XCircle className="w-5 h-5 text-red-400 flex-shrink-0" />}
                  <div>
                    <p className={`text-sm font-semibold ${data.wouldBuy ? "text-emerald-400" : "text-red-400"}`}>
                      {data.wouldBuy ? "Bot Would BUY" : "Bot Would SKIP"}
                    </p>
                    {data.wouldBuy && (
                      <p className="text-xs text-muted-foreground">Conviction: {data.convictionScore} · Score: {data.totalScore}/{data.threshold}</p>
                    )}
                  </div>
                </div>
              </div>

              {/* Score bar */}
              <div className="mt-4">
                <ScoreBar score={data.totalScore} threshold={data.threshold} />
              </div>

              {/* Skip reasons */}
              {!data.wouldBuy && data.skipReasons.length > 0 && (
                <div className="mt-3 space-y-1">
                  {data.skipReasons.map((r: string, i: number) => (
                    <div key={i} className="flex items-start gap-2 text-xs text-red-400/80">
                      <XCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                      <span>{r}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Scan & Trade button */}
              <div className="mt-4 pt-4 border-t border-border">
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    onClick={() => { setTradeResult(null); tradeMutation.mutate(); }}
                    disabled={tradeMutation.isPending}
                    className="flex items-center gap-2 px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
                    data-testid="button-scan-trade"
                  >
                    {tradeMutation.isPending
                      ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Scanning...</>
                      : <><ShoppingCart className="w-3.5 h-3.5" /> Scan &amp; Trade if Valid</>}
                  </button>
                  <p className="text-xs text-muted-foreground">
                    Runs the full bot scan on {data.symbol} right now — buys immediately if all conditions are met
                  </p>
                </div>

                {/* Trade result */}
                {tradeResult && (
                  <div className={`mt-3 p-3 rounded-lg border text-sm ${
                    tradeResult.traded
                      ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                      : "bg-red-500/10 border-red-500/30 text-red-400"
                  }`}>
                    {tradeResult.traded ? (
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 font-semibold">
                          <CheckCircle2 className="w-4 h-4" />
                          {tradeResult.message}
                        </div>
                        <div className="flex gap-4 text-xs text-emerald-400/80 font-mono">
                          <span>Stop: ${tradeResult.stopLoss?.toFixed(2)}</span>
                          <span>Trail At: ${tradeResult.trailingActivatePrice?.toFixed(2)}</span>
                          <span>Conviction: {tradeResult.convictionScore}</span>
                        </div>
                        <div className="text-xs text-emerald-400/60 mt-1">
                          Reasons: {tradeResult.reasons?.join(" · ")}
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start gap-2">
                        <XCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                        <div>
                          <span className="font-semibold">Not traded — </span>
                          <span className="text-xs">{tradeResult.reason}</span>
                          {tradeResult.score !== undefined && (
                            <p className="text-xs text-red-400/60 mt-0.5">
                              Score: {tradeResult.score}/{tradeResult.threshold} · Signals: {tradeResult.reasons?.join(", ") || "none"}
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Chart with selected timeframe */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                Price Chart + Indicators
                <span className="text-xs text-muted-foreground font-normal">· {TF_LABELS[displayTf]} bars</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3 pt-0">
              <StockChart
                symbol={data.symbol}
                timeframe={displayTf}
                bucket={data.bucket === "unknown" ? "swing" : data.bucket}
                height={440}
                showIndicators={true}
              />
            </CardContent>
          </Card>

          {/* Signal breakdown */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Signal Breakdown</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-border/50">
                {data.signals.map((sig: any, i: number) => (
                  <div key={i} className="flex items-start gap-3 px-4 py-3">
                    <div className="mt-0.5 flex-shrink-0">
                      {sig.passed
                        ? <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        : <XCircle className="w-4 h-4 text-red-400" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-semibold ${sig.passed ? "text-foreground" : "text-muted-foreground"}`}>
                          {sig.name}
                        </span>
                        {sig.score > 0 && (
                          <span className="text-xs text-emerald-400 tabular-nums">+{sig.score} pts</span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{sig.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Key indicators grid */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Live Indicator Values</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-2">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  ["RSI (14)", data.indicators.rsi?.toFixed(1), data.indicators.rsi > 70 ? "text-red-400" : data.indicators.rsi < 30 ? "text-emerald-400" : "text-foreground"],
                  ["MACD Histogram", data.indicators.macdHistogram?.toFixed(4), data.indicators.macdHistogram > 0 ? "text-emerald-400" : "text-red-400"],
                  ["Volume Ratio", `${data.indicators.volumeRatio?.toFixed(2)}x`, data.indicators.volumeRatio > 1.5 ? "text-emerald-400" : "text-muted-foreground"],
                  ["ROC Momentum", `${data.indicators.roc?.toFixed(2)}%`, data.indicators.roc > 0 ? "text-emerald-400" : "text-red-400"],
                  ["EMA 9", `$${data.indicators.ema9?.toFixed(2)}`, "text-blue-400"],
                  ["EMA 21", `$${data.indicators.ema21?.toFixed(2)}`, "text-purple-400"],
                  ["SMA 50", `$${data.indicators.sma50?.toFixed(2)}`, "text-amber-400"],
                  data.indicators.sma200 ? ["SMA 200", `$${data.indicators.sma200?.toFixed(2)}`, "text-orange-400"] : null,
                  ["BB Upper", `$${data.indicators.bbUpper?.toFixed(2)}`, "text-muted-foreground"],
                  ["BB Lower", `$${data.indicators.bbLower?.toFixed(2)}`, "text-muted-foreground"],
                  data.indicators.rsRating ? ["RS Rating", data.indicators.rsRating?.toFixed(0), data.indicators.rsRating > 65 ? "text-emerald-400" : "text-muted-foreground"] : null,
                ].filter(Boolean).map(([label, value, color]: any) => (
                  <div key={label} className="bg-secondary/50 rounded-md p-3">
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className={`text-sm font-bold tabular-nums mt-0.5 ${color}`}>{value}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* News */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <CardTitle className="text-sm">Recent News (72h)</CardTitle>
                <div className={`text-xs px-2 py-0.5 rounded border ${sentimentBg[data.newsSentiment.label]}`}>
                  <span className={sentimentColor[data.newsSentiment.label]}>
                    {sentimentLabel[data.newsSentiment.label]} · Score {data.newsSentiment.score > 0 ? "+" : ""}{data.newsSentiment.score}
                  </span>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {data.news.length === 0 ? (
                <p className="text-xs text-muted-foreground px-4 py-6 text-center">No recent news found</p>
              ) : (
                <div className="divide-y divide-border/50">
                  {data.news.map((item: any, i: number) => (
                    <div key={i} className="px-4 py-3">
                      <div className="flex items-start gap-2">
                        <div className="mt-0.5 flex-shrink-0">
                          {item.sentiment === "strongly_positive" || item.sentiment === "moderately_positive"
                            ? <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
                            : item.sentiment === "strongly_negative" || item.sentiment === "moderately_negative"
                            ? <TrendingDown className="w-3.5 h-3.5 text-red-400" />
                            : <Minus className="w-3.5 h-3.5 text-muted-foreground" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-xs font-medium text-foreground leading-snug">{item.headline}</p>
                            {item.url && (
                              <a href={item.url} target="_blank" rel="noopener noreferrer"
                                className="flex-shrink-0 text-muted-foreground hover:text-primary transition-colors">
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                            <span className="text-xs text-muted-foreground">{item.source}</span>
                            <span className="text-xs text-muted-foreground">·</span>
                            <span className="text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleDateString()}</span>
                            <span className={`text-xs ${sentimentColor[item.sentiment]}`}>{sentimentLabel[item.sentiment]}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Cooling notice */}
          {data.coolingActive && data.coolingUntil && (
            <Card className="border-yellow-500/30 bg-yellow-500/5">
              <CardContent className="p-4 flex items-center gap-3">
                <Clock className="w-4 h-4 text-yellow-400 flex-shrink-0" />
                <p className="text-xs text-yellow-400">
                  News cooling period active — bot will not open new positions in {data.symbol} until{" "}
                  {new Date(data.coolingUntil).toLocaleString()}
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Empty state */}
      {!symbol && !isLoading && (
        <div className="py-20 text-center text-muted-foreground">
          <Search className="w-8 h-8 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Search any US stock ticker to see the bot's full analysis</p>
          <p className="text-xs mt-1 opacity-60">Try TSLA, NVDA, AAPL, F, GME, SPY...</p>
        </div>
      )}
    </div>
  );
}

export default Research;
