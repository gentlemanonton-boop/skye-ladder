import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { usePool } from "./hooks/usePool";
import { useWalletRecord } from "./hooks/useWalletRecord";
import { useSolPrice } from "./hooks/useSolPrice";
import { formatUsd } from "./lib/format";
import { SwapPanel } from "./components/SwapPanel";
import { UnlockProgress } from "./components/UnlockProgress";
import { TierBreakdown } from "./components/TierBreakdown";
import { ActivityButton } from "./components/Activity";
import { ChartButton } from "./components/ChartModal";

const LOGO = "https://gateway.irys.xyz/7KOIQD6D5bArYKAyOz8xtSmDDGKV7DbMOLo4oUhOlHI";

export default function App() {
  const { pool, loading, error: poolError } = usePool();
  const { positions } = useWalletRecord();
  const solUsd = useSolPrice();

  const currentPrice = pool ? pool.wsolAmount / pool.skyeAmount : 0;
  const pricePerTokenSol = currentPrice;
  const priceUsd = pricePerTokenSol * solUsd;
  const mcSol = pricePerTokenSol * 1e9;
  const mcUsd = mcSol * solUsd;

  return (
    <div className="min-h-screen bg-surface-bg">
      <header className="sticky top-0 z-20 bg-white/70 backdrop-blur-xl border-b border-gray-200/60">
        <div className="max-w-2xl mx-auto px-4 sm:px-5 h-14 sm:h-16 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <img src={LOGO} alt="SKYE" className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl shadow-sm flex-shrink-0" />
            <div className="min-w-0">
              <h1 className="text-[14px] sm:text-[15px] font-bold text-ink-primary leading-tight">Skye Ladder</h1>
              {!loading && pool && (
                <div className="flex items-center gap-2 sm:gap-3 text-[11px] sm:text-[12px] leading-tight truncate">
                  <span className="text-ink-secondary">{formatUsd(priceUsd, 6)}</span>
                  <span className="text-ink-tertiary">MC {formatUsd(mcUsd, 0)}</span>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
            <ChartButton />
            <ActivityButton />
            <WalletMultiButton />
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 sm:px-5 pt-6 sm:pt-8 pb-16 space-y-5 sm:space-y-6">
        {loading ? (
          <div className="flex items-center justify-center py-24">
            <div className="text-ink-tertiary text-[14px]">Loading pool...</div>
          </div>
        ) : poolError ? (
          <div className="bg-surface-card rounded-2xl border border-gray-200/80 p-8 text-center space-y-3">
            <p className="text-ink-primary font-semibold">Failed to load pool</p>
            <p className="text-ink-tertiary text-[13px]">{poolError}</p>
            <button onClick={() => window.location.reload()} className="text-skye-500 text-[13px] font-semibold hover:underline">
              Retry
            </button>
          </div>
        ) : (
          <>
            <SwapPanel currentPrice={currentPrice} solUsd={solUsd} />
            <UnlockProgress positions={positions} currentPrice={currentPrice} />
            <TierBreakdown positions={positions} currentPrice={currentPrice} />
          </>
        )}
      </main>

      <footer className="border-t border-gray-200/60 py-6 text-center text-[11px] sm:text-[12px] text-ink-tertiary px-4">
        Structured sell restrictions on Solana &middot; Token-2022 Transfer Hook
      </footer>
    </div>
  );
}
