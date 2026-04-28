import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { BarChart2, Layers, History, Zap, Activity, Circle, Search } from "lucide-react";

const nav = [
  { href: "/", label: "Dashboard", icon: BarChart2 },
  { href: "/positions", label: "Positions", icon: Layers },
  { href: "/trades", label: "Trade History", icon: History },
  { href: "/signals", label: "Signals Log", icon: Zap },
  { href: "/research", label: "Research", icon: Search },
];

const bucketColors: Record<string, string> = {
  volatile: "text-orange-400",
  swing: "text-blue-400",
  longterm: "text-emerald-400",
};

export default function Sidebar() {
  const [location] = useLocation();
  const { data: botStatus } = useQuery({
    queryKey: ["/api/bot/status"],
    queryFn: () => apiRequest("GET", "/api/bot/status").then(r => r.json()),
    refetchInterval: 5000,
  });
  const { data: account } = useQuery({
    queryKey: ["/api/account"],
    queryFn: () => apiRequest("GET", "/api/account").then(r => r.json()),
    refetchInterval: 10000,
  });

  const equity = account ? parseFloat(account.equity).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }) : "—";
  const pnl = account ? parseFloat(account.equity) - parseFloat(account.last_equity) : 0;
  const pnlPct = account ? (pnl / parseFloat(account.last_equity) * 100) : 0;
  const isRunning = botStatus?.botRunning;

  return (
    <aside className="w-56 flex-shrink-0 flex flex-col border-r border-border bg-card h-screen">
      {/* Logo */}
      <div className="px-4 py-5 border-b border-border">
        <div className="flex items-center gap-2">
          <svg aria-label="TradeBot" viewBox="0 0 32 32" width="28" height="28" fill="none">
            <rect x="2" y="2" width="28" height="28" rx="6" fill="hsl(207 100% 55% / 0.15)" stroke="hsl(207 100% 55%)" strokeWidth="1.5"/>
            <polyline points="6,20 11,13 16,17 21,9 26,14" stroke="hsl(207 100% 55%)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
            <circle cx="26" cy="14" r="2.5" fill="hsl(207 100% 55%)"/>
          </svg>
          <span className="font-semibold text-sm text-foreground tracking-wide">TradeBot</span>
        </div>
      </div>

      {/* Account summary */}
      <div className="px-4 py-3 border-b border-border">
        <p className="text-xs text-muted-foreground mb-0.5">Portfolio Value</p>
        <p className="text-base font-bold tabular-nums text-foreground">{equity}</p>
        <p className={`text-xs tabular-nums mt-0.5 ${pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
          {pnl >= 0 ? "+" : ""}{pnl.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}
          {" "}({pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%) today
        </p>
      </div>

      {/* Bot status */}
      <div className="px-4 py-2.5 border-b border-border">
        <div className="flex items-center gap-2">
          <Circle className={`w-2 h-2 fill-current ${isRunning ? "text-emerald-400" : "text-muted-foreground"}`} />
          <span className={`text-xs font-medium ${isRunning ? "text-emerald-400" : "text-muted-foreground"}`}>
            {isRunning ? "Bot Running" : "Bot Paused"}
          </span>
        </div>
        {botStatus?.lastRunAt && (
          <p className="text-xs text-muted-foreground mt-0.5 pl-4">
            Last: {new Date(botStatus.lastRunAt).toLocaleTimeString()}
          </p>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-3 space-y-0.5">
        {nav.map(({ href, label, icon: Icon }) => {
          const active = location === href;
          return (
            <Link key={href} href={href}>
              <a className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                active
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary"
              }`}>
                <Icon className="w-4 h-4 flex-shrink-0" />
                {label}
              </a>
            </Link>
          );
        })}
      </nav>

      {/* Bucket legend */}
      <div className="px-4 py-3 border-t border-border text-xs text-muted-foreground space-y-1.5">
        <p className="font-medium text-foreground mb-1">Buckets</p>
        {[["volatile","Volatile (35%)","text-orange-400"],["swing","Swing (35%)","text-blue-400"],["longterm","Long-term (30%)","text-emerald-400"]].map(([k,l,c]) => (
          <div key={k} className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full bg-current ${c}`} />
            <span>{l}</span>
          </div>
        ))}
      </div>

      {/* Paper trading badge */}
      <div className="px-4 py-2 border-t border-border">
        <span className="inline-flex items-center gap-1 text-xs bg-yellow-500/10 text-yellow-400 border border-yellow-500/20 rounded px-2 py-0.5 font-medium">
          <Activity className="w-3 h-3" />
          Paper Trading
        </span>
      </div>
    </aside>
  );
}
