import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, TrendingUp, TrendingDown, Minus, RefreshCw, Save, ExternalLink } from "lucide-react";
import StockChart from "@/components/StockChart";
import InteractiveStockChart from "@/components/InteractiveStockChart";
import { apiRequest } from "@/lib/queryClient";

// ── Types ───────────────────────────────────────────────────────────────────
type Timeframe = "15Min" | "1Hour" | "1Day";

interface ResearchData {
  symbol: string;
  bucket: string;
  wouldBuy: boolean;
  convictionScore: number;
  totalScore: number;
  threshold: number;
  skipReasons: string[];
  reasons: string[];
  signals: { name: string; passed: boolean; score: number; detail: string }[];
  news: { headline: string; source: string; url?: string; sentiment: string; summary?: string; publishedAt?: string }[];
  indicators: Record<string, number>;
  currentPrice: number;
  entryPrice?: number;
  stopLoss?: number;
  trailingStop?: number;
  sentiment?: { label: string; score: number; shouldBlockEntry: boolean };
}

interface Position {
  id: number;
  symbol: string;
  bucket: string;
  entryPrice: number;
  currentPrice: number;
  stopLoss: number;
  trailingStop?: number;
  shares: number;
  entryReason: string;
  openedAt: string;
  peakPrice?: number;
  convictionScore: number;
}

interface Trade {
  id: number;
  symbol: string;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  entryReason: string;
  closeReason: string;
  openedAt: string;
  closedAt: string;
  bucket: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function pct(val: number) {
  const sign = val >= 0 ? "+" : "";
  return `${sign}${val.toFixed(2)}%`;
}

function fmtPrice(n: number | undefined) {
  if (n === undefined || n === null || n >= 9000) return "—";
  return `$${n.toFixed(2)}`;
}

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function sentimentColor(s: string) {
  if (s === "positive" || s === "bullish") return "text-emerald-400";
  if (s === "negative" || s === "bearish") return "text-red-400";
  return "text-muted-foreground";
}

// ── Component ────────────────────────────────────────────────────────────────
export default function StockDetail() {
  const { symbol: rawSymbol } = useParams<{ symbol: string }>();
  const symbol = (rawSymbol || "").toUpperCase();
  const [, navigate] = useLocation();
  const qc = useQueryClient();

  const [timeframe, setTimeframe] = useState<Timeframe>("1Day");
  const [notes, setNotes] = useState("");
  const [notesSaved, setNotesSaved] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notesLoaded = useRef(false);

  // ── Data fetching ──────────────────────────────────────────────────────────
  const { data: research, isLoading: resLoading, refetch: refetchResearch } = useQuery<ResearchData>({
    queryKey: ["/api/research", symbol],
    queryFn: () => apiRequest("GET", `/api/research/${symbol}`).then(r => r.json()),
    enabled: !!symbol,
    refetchInterval: 60_000,
    retry: false,
  });

  const { data: positions } = useQuery<Position[]>({
    queryKey: ["/api/positions"],
    queryFn: () => apiRequest("GET", "/api/positions").then(r => r.json()),
  });

  const { data: trades } = useQuery<Trade[]>({
    queryKey: ["/api/trades"],
    queryFn: () => apiRequest("GET", "/api/trades").then(r => r.json()),
  });

  const { data: savedNotes } = useQuery({
    queryKey: ["/api/notes", symbol],
    queryFn: () => apiRequest("GET", `/api/notes/${symbol}`).then(r => r.json()),
    enabled: !!symbol,
  });

  // Populate notes from DB on first load
  useEffect(() => {
    if (savedNotes && !notesLoaded.current) {
      setNotes(savedNotes.content || "");
      notesLoaded.current = true;
    }
  }, [savedNotes]);

  const saveNotesMutation = useMutation({
    mutationFn: (content: string) =>
      apiRequest("POST", `/api/notes/${symbol}`, { content }).then(r => r.json()),
    onSuccess: () => {
      setNotesSaved(true);
      setTimeout(() => setNotesSaved(false), 2000);
      qc.invalidateQueries({ queryKey: ["/api/notes", symbol] });
    },
  });

  // Auto-save notes with 1s debounce
  const handleNotesChange = useCallback((val: string) => {
    setNotes(val);
    setNotesSaved(false);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveNotesMutation.mutate(val);
    }, 1000);
  }, [saveNotesMutation]);

  // Derived: open position for this symbol
  const openPosition = positions?.find(p => p.symbol === symbol && p.id);
  // Trade history for this symbol (most recent 10)
  const symbolTrades = trades?.filter(t => t.symbol === symbol).slice(0, 10) ?? [];

  const price = research?.currentPrice;
  const changeFromEntry = openPosition
    ? ((openPosition.currentPrice - openPosition.entryPrice) / openPosition.entryPrice) * 100
    : null;

  // Auto-set timeframe to bucket default
  useEffect(() => {
    if (research?.bucket === "volatile") setTimeframe("15Min");
    else setTimeframe("1Day");
  }, [research?.bucket]);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* ── Top bar ── */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border bg-background/80 backdrop-blur sticky top-0 z-10">
        <button
          onClick={() => navigate(-1 as any)}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
        <div className="h-4 w-px bg-border" />
        <div className="flex items-center gap-3">
          <span className="text-xl font-bold tracking-tight">{symbol}</span>
          {price !== undefined && (
            <span className="text-lg font-mono text-foreground">${price.toFixed(2)}</span>
          )}
          {changeFromEntry !== null && (
            <span className={`text-sm font-mono font-medium ${changeFromEntry >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {pct(changeFromEntry)} from entry
            </span>
          )}
          {research?.bucket && research.bucket !== "unknown" && (
            <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${
              research.bucket === "volatile"
                ? "bg-orange-500/15 text-orange-400 border-orange-500/30"
                : "bg-blue-500/15 text-blue-400 border-blue-500/30"
            }`}>
              {research.bucket}
            </span>
          )}
          {openPosition && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 font-medium">
              Open Position
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => refetchResearch()}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded border border-border hover:border-foreground/30"
          >
            <RefreshCw className="w-3 h-3" />
            Refresh
          </button>
          {/* Timeframe */}
          <div className="flex gap-1 bg-secondary rounded-md p-0.5 border border-border">
            {(["15Min", "1Hour", "1Day"] as Timeframe[]).map(tf => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  timeframe === tf ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {tf === "15Min" ? "15m" : tf === "1Hour" ? "1h" : "1D"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Main layout: chart + right panel ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Left: Chart + Indicators + Trade History ── */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5 min-w-0">

          {/* Chart */}
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-4 pt-3 pb-1 flex items-center justify-between">
              <span className="text-sm font-semibold text-foreground">Chart</span>
              <span className="text-xs text-muted-foreground">
                {openPosition ? `Entry $${openPosition.entryPrice.toFixed(2)}` : "No open position"}
              </span>
            </div>
            {resLoading ? (
              <div className="h-[520px] flex items-center justify-center text-muted-foreground text-sm">
                Loading chart data…
              </div>
            ) : (
              <InteractiveStockChart
                symbol={symbol}
                timeframe={timeframe}
                entryPrice={openPosition?.entryPrice}
                stopLoss={openPosition?.stopLoss}
                trailingStop={openPosition?.trailingStop && openPosition.trailingStop > 1 ? openPosition.trailingStop : undefined}
                bucket={research?.bucket}
                height={520}
              />
            )}
          </div>

          {/* Technical Indicators */}
          {research?.indicators && (
            <div className="bg-card border border-border rounded-xl p-4">
              <h3 className="text-sm font-semibold text-foreground mb-3">Technical Indicators</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {Object.entries(research.indicators).map(([key, val]) => {
                  const label = key
                    .replace(/([A-Z])/g, " $1")
                    .replace(/^./, s => s.toUpperCase())
                    .replace("Rsi", "RSI").replace("Macd", "MACD").replace("Sma", "SMA").replace("Ema", "EMA");
                  let color = "text-foreground";
                  if (key === "rsi") {
                    color = val > 70 ? "text-red-400" : val < 30 ? "text-emerald-400" : "text-foreground";
                  } else if (key === "macdHist") {
                    color = val > 0 ? "text-emerald-400" : "text-red-400";
                  } else if (key === "volumeRatio") {
                    color = val > 1.5 ? "text-emerald-400" : val < 0.8 ? "text-red-400" : "text-foreground";
                  } else if (key === "roc") {
                    color = val > 0 ? "text-emerald-400" : "text-red-400";
                  }
                  return (
                    <div key={key} className="bg-secondary/50 rounded-lg p-3 text-center">
                      <div className="text-xs text-muted-foreground mb-1">{label}</div>
                      <div className={`text-sm font-mono font-semibold ${color}`}>
                        {typeof val === "number" ? val.toFixed(2) : val}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Signal breakdown */}
          {research?.signals && research.signals.length > 0 && (
            <div className="bg-card border border-border rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-foreground">Signal Breakdown</h3>
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-mono font-semibold px-2 py-0.5 rounded ${research.wouldBuy ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"}`}>
                    Score {research.totalScore ?? "—"}/{research.threshold ?? "—"}
                  </span>
                  <span className={`text-xs font-semibold ${research.wouldBuy ? "text-emerald-400" : "text-red-400"}`}>
                    {research.wouldBuy ? "Bot would BUY" : "Bot would SKIP"}
                  </span>
                </div>
              </div>
              <div className="space-y-1.5">
                {research.signals.map((sig, i) => (
                  <div key={i} className={`flex items-start gap-2.5 p-2 rounded-lg text-xs ${sig.passed ? "bg-emerald-500/8" : "bg-secondary/40"}`}>
                    <span className={`mt-0.5 w-4 h-4 rounded-full flex-shrink-0 flex items-center justify-center ${sig.passed ? "bg-emerald-500/20 text-emerald-400" : "bg-muted text-muted-foreground"}`}>
                      {sig.passed ? "✓" : "✗"}
                    </span>
                    <div className="flex-1 min-w-0">
                      <span className={`font-medium ${sig.passed ? "text-foreground" : "text-muted-foreground"}`}>{sig.name}</span>
                      {sig.detail && <span className="text-muted-foreground ml-2">{sig.detail}</span>}
                    </div>
                    <span className={`font-mono text-xs flex-shrink-0 ${sig.score > 0 && sig.passed ? "text-emerald-400" : "text-muted-foreground"}`}>
                      {sig.score > 0 && sig.passed ? `+${sig.score}` : ""}
                    </span>
                  </div>
                ))}
              </div>
              {research.skipReasons && research.skipReasons.length > 0 && (
                <div className="mt-3 pt-3 border-t border-border">
                  <div className="text-xs text-muted-foreground font-medium mb-1.5">Why skipped:</div>
                  {research.skipReasons.map((r, i) => (
                    <div key={i} className="text-xs text-red-400/80 flex items-center gap-1.5">
                      <span className="w-1 h-1 rounded-full bg-red-400/60 flex-shrink-0" />
                      {r}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Open position detail */}
          {openPosition && (
            <div className="bg-card border border-emerald-500/30 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-emerald-400 mb-3">Open Position</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                {[
                  ["Shares", openPosition.shares.toString()],
                  ["Entry", `$${openPosition.entryPrice.toFixed(2)}`],
                  ["Current", `$${openPosition.currentPrice.toFixed(2)}`],
                  ["P&L", pct(((openPosition.currentPrice - openPosition.entryPrice) / openPosition.entryPrice) * 100)],
                  ["Stop", `$${openPosition.stopLoss.toFixed(2)}`],
                  ["Trail At", openPosition.trailingStop && openPosition.trailingStop > 1 ? `$${openPosition.trailingStop.toFixed(2)}` : `$${(openPosition.entryPrice * (openPosition.bucket === "volatile" ? 1.08 : 1.10)).toFixed(2)}`],
                  ["Conviction", `${openPosition.convictionScore}`],
                  ["Opened", relativeTime(openPosition.openedAt)],
                ].map(([label, val]) => (
                  <div key={label} className="bg-secondary/40 rounded-lg p-2.5">
                    <div className="text-xs text-muted-foreground">{label}</div>
                    <div className={`text-sm font-mono font-semibold mt-0.5 ${
                      label === "P&L"
                        ? parseFloat(val.replace("+","")) >= 0 ? "text-emerald-400" : "text-red-400"
                        : "text-foreground"
                    }`}>{val}</div>
                  </div>
                ))}
              </div>
              {openPosition.entryReason && (
                <div className="bg-secondary/30 rounded-lg p-3">
                  <div className="text-xs text-muted-foreground mb-2 font-medium">Signals at entry</div>
                  <div className="space-y-1">
                    {(() => {
                      try {
                        const reasons = JSON.parse(openPosition.entryReason) as string[];
                        return reasons.map((r, i) => (
                          <div key={i} className="flex items-start gap-2 text-xs">
                            <span className="w-4 h-4 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center flex-shrink-0 mt-0.5 text-[10px]">✓</span>
                            <span className="text-foreground/90 leading-relaxed">{r}</span>
                          </div>
                        ));
                      } catch {
                        return <span className="text-xs text-foreground/80">{openPosition.entryReason}</span>;
                      }
                    })()}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Trade history for this symbol */}
          {symbolTrades.length > 0 && (
            <div className="bg-card border border-border rounded-xl p-4">
              <h3 className="text-sm font-semibold text-foreground mb-3">Trade History</h3>
              <div className="space-y-2">
                {symbolTrades.map(t => (
                  <div key={t.id} className="bg-secondary/40 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        {t.pnl >= 0
                          ? <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
                          : <TrendingDown className="w-3.5 h-3.5 text-red-400" />}
                        <span className={`text-sm font-mono font-semibold ${t.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)} ({pct(t.pnlPct)})
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground">{relativeTime(t.closedAt)}</span>
                    </div>
                    <div className="flex gap-4 text-xs text-muted-foreground font-mono">
                      <span>Entry ${t.entryPrice.toFixed(2)}</span>
                      <span>Exit ${t.exitPrice.toFixed(2)}</span>
                      <span className="capitalize">{t.bucket}</span>
                    </div>
                    {t.closeReason && (
                      <div className="mt-1.5 text-xs text-muted-foreground">
                        <span className="text-foreground/60">Exit: </span>{t.closeReason}
                      </div>
                    )}
                    {t.entryReason && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        <span className="text-foreground/60">Entry: </span>
                        {(() => {
                          try { return (JSON.parse(t.entryReason) as string[]).join(" · "); }
                          catch { return t.entryReason; }
                        })()}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Right panel: News + Notes ── */}
        <div className="w-80 xl:w-96 border-l border-border overflow-y-auto flex flex-col bg-card/30">

          {/* News */}
          <div className="p-4 border-b border-border flex-shrink-0">
            <h3 className="text-sm font-semibold text-foreground mb-3">
              News
              {research?.sentiment && (
                <span className={`ml-2 text-xs font-normal ${sentimentColor(research.sentiment.label)}`}>
                  · {research.sentiment.label}
                </span>
              )}
            </h3>
            {resLoading ? (
              <div className="text-xs text-muted-foreground">Loading news…</div>
            ) : research?.news && research.news.length > 0 ? (
              <div className="space-y-3">
                {research.news.map((item, i) => (
                  <div key={i} className="group">
                    <div className="flex items-start gap-2">
                      {item.sentiment === "positive" || item.sentiment === "bullish"
                        ? <TrendingUp className="w-3 h-3 text-emerald-400 flex-shrink-0 mt-0.5" />
                        : item.sentiment === "negative" || item.sentiment === "bearish"
                        ? <TrendingDown className="w-3 h-3 text-red-400 flex-shrink-0 mt-0.5" />
                        : <Minus className="w-3 h-3 text-muted-foreground flex-shrink-0 mt-0.5" />}
                      <div className="flex-1 min-w-0">
                        {item.url ? (
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-foreground hover:text-primary transition-colors leading-relaxed line-clamp-3 flex gap-1 items-start"
                          >
                            {item.headline}
                            <ExternalLink className="w-2.5 h-2.5 flex-shrink-0 mt-0.5 opacity-60" />
                          </a>
                        ) : (
                          <p className="text-xs text-foreground leading-relaxed line-clamp-3">{item.headline}</p>
                        )}
                        {item.summary && (
                          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{item.summary}</p>
                        )}
                        <div className="flex items-center gap-1.5 mt-1">
                          <span className="text-xs text-muted-foreground/70">{item.source}</span>
                          {item.publishedAt && (
                            <span className="text-xs text-muted-foreground/50">· {relativeTime(item.publishedAt)}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    {i < research.news.length - 1 && <div className="border-b border-border/40 mt-3" />}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">No recent news found.</div>
            )}
          </div>

          {/* Notes — persistent, auto-saved */}
          <div className="flex-1 flex flex-col p-4 min-h-0">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-foreground">Notes</h3>
              <div className="flex items-center gap-1.5">
                {saveNotesMutation.isPending && (
                  <span className="text-xs text-muted-foreground">Saving…</span>
                )}
                {notesSaved && (
                  <span className="text-xs text-emerald-400 flex items-center gap-1">
                    <Save className="w-3 h-3" /> Saved
                  </span>
                )}
              </div>
            </div>
            <textarea
              value={notes}
              onChange={e => handleNotesChange(e.target.value)}
              placeholder={`Your thoughts on ${symbol}…\n\nTrend analysis, support/resistance levels, catalysts, risk notes — anything you want to track.`}
              className="flex-1 min-h-[200px] resize-none bg-secondary/40 border border-border rounded-lg p-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50 font-mono leading-relaxed"
            />
            {savedNotes?.updatedAt && (
              <div className="text-xs text-muted-foreground/50 mt-1.5">
                Last saved {relativeTime(savedNotes.updatedAt)}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
