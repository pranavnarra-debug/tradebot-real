import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import Dashboard from "@/pages/Dashboard";
import Positions from "@/pages/Positions";
import Trades from "@/pages/Trades";
import Signals from "@/pages/Signals";
import Research from "@/pages/Research";
import StockDetail from "@/pages/StockDetail";
import NotFound from "@/pages/not-found";
import Sidebar from "@/components/Sidebar";

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="dark flex h-screen bg-background overflow-hidden">
        <Router hook={useHashLocation}>
          <Sidebar />
          <main className="flex-1 overflow-y-auto overscroll-contain">
            <Switch>
              <Route path="/" component={Dashboard} />
              <Route path="/positions" component={Positions} />
              <Route path="/trades" component={Trades} />
              <Route path="/signals" component={Signals} />
              <Route path="/research" component={Research} />
              <Route path="/stock/:symbol" component={StockDetail} />
              <Route component={NotFound} />
            </Switch>
          </main>
        </Router>
      </div>
      <Toaster />
    </QueryClientProvider>
  );
}
