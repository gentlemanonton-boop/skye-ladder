import React, { useState } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { usePool } from "./hooks/usePool";
import { useWalletRecord } from "./hooks/useWalletRecord";
import { useSolPrice } from "./hooks/useSolPrice";
import { formatUsd } from "./lib/format";
import { useBalances } from "./hooks/useBalances";
import { SwapPanel } from "./components/SwapPanel";
import { UnlockProgress } from "./components/UnlockProgress";
import { TierBreakdown } from "./components/TierBreakdown";
import { ActivityTab } from "./components/ActivityTab";
import { ChartTab } from "./components/ChartTab";
import { AboutTab } from "./components/AboutTab";

const LOGO = "https://gateway.irys.xyz/YkvolVl__ug43pWw3H-cYF2vLN_zE_1LRt6FjcYmkcc";
type Tab = "trade" | "chart" | "activity" | "about";

class SafeChart extends React.Component<{}, { err: boolean }> {
  state = { err: false };
  static getDerivedStateFromError() { return { err: true }; }
  render() {
    if (this.state.err) return <div className="glass p-8 text-center text-ink-tertiary text-[13px]">Chart unavailable</div>;
    return this.props.children;
  }
}

export default function App() {
  const { pool, loading, error: poolError } = usePool();
  const { positions } = useWalletRecord();
  const solUsd = useSolPrice();
  const { solBalance } = useBalances();
  const [tab, setTab] = useState<Tab>("trade");

  const currentPrice = pool ? pool.wsolAmount / pool.skyeAmount : 0;
  const priceUsd = currentPrice * solUsd;
  const mcSol = currentPrice * 1e9;
  const mcUsd = mcSol * solUsd;

  return (
    <div className="min-h-screen relative">
      {/* Header */}
      <header className="sticky top-0 z-20 glass border-b border-white/5">
        <div className="max-w-2xl mx-auto px-4 sm:px-5 h-14 sm:h-16 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <img src={LOGO} alt="SKYE" className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl shadow-lg flex-shrink-0" />
            <div className="min-w-0">
              <h1 className="text-[14px] sm:text-[15px] font-bold text-ink-primary leading-tight">Skye</h1>
              {!loading && pool && (
                <div className="flex items-center gap-2 sm:gap-3 text-[11px] sm:text-[12px] leading-tight truncate">
                  <span className="text-skye-400">{formatUsd(priceUsd, 6)}</span>
                  <span className="text-ink-tertiary">MC {formatUsd(mcUsd, 0)}</span>
                </div>
              )}
            </div>
          </div>
          {solBalance !== null && (
              <span className="text-[12px] text-ink-tertiary tabular-nums hidden sm:inline">{solBalance.toFixed(3)} SOL</span>
            )}
            <WalletMultiButton />
        </div>
      </header>

      {/* Tab bar */}
      <div className="sticky top-14 sm:top-16 z-10 glass border-b border-white/5">
        <div className="max-w-2xl mx-auto px-4 sm:px-5 flex">
          {([
            { id: "trade" as Tab, label: "Trade" },
            { id: "chart" as Tab, label: "Chart" },
            { id: "activity" as Tab, label: "Activity" },
            { id: "about" as Tab, label: "About" },
          ]).map(({ id, label }) => (
            <button key={id} onClick={() => setTab(id)}
              className={`flex-1 py-3 text-[13px] sm:text-[14px] font-semibold text-center transition-colors relative ${
                tab === id ? "text-skye-400" : "text-ink-faint hover:text-ink-tertiary"
              }`}>
              {label}
              {tab === id && <div className="absolute bottom-0 left-1/4 right-1/4 h-[2px] bg-skye-500 rounded-full" />}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <main className="max-w-2xl mx-auto px-4 sm:px-5 pt-6 sm:pt-8 pb-16 space-y-5 sm:space-y-6">
        {loading ? (
          <div className="flex items-center justify-center py-24">
            <div className="text-ink-tertiary text-[14px]">Loading pool...</div>
          </div>
        ) : poolError ? (
          <div className="glass p-8 text-center space-y-3">
            <p className="text-ink-primary font-semibold">Failed to load pool</p>
            <p className="text-ink-tertiary text-[13px]">{poolError}</p>
            <button onClick={() => window.location.reload()} className="text-skye-400 text-[13px] font-semibold hover:underline">Retry</button>
          </div>
        ) : (
          <>
            {tab === "trade" && (
              <>
                <SwapPanel currentPrice={currentPrice} solUsd={solUsd} />
                <UnlockProgress positions={positions} currentPrice={currentPrice} />
                <TierBreakdown positions={positions} currentPrice={currentPrice} />
              </>
            )}
            {tab === "chart" && <SafeChart><ChartTab /></SafeChart>}
            {tab === "activity" && <ActivityTab />}
            {tab === "about" && <AboutTab />}
          </>
        )}
      </main>

      <footer className="border-t border-white/5 py-6 text-center text-[11px] sm:text-[12px] text-ink-faint px-4">
        Structured sell restrictions on Solana &middot; Token-2022 Transfer Hook
      </footer>
    </div>
  );
}
