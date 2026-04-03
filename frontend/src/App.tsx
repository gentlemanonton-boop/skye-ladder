import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { usePool } from "./hooks/usePool";
import { useWalletRecord } from "./hooks/useWalletRecord";
import { formatUsd } from "./lib/format";
import { SwapPanel } from "./components/SwapPanel";
import { UnlockProgress } from "./components/UnlockProgress";
import { TierBreakdown } from "./components/TierBreakdown";
import { ActivityButton } from "./components/Activity";

const SOL_USD = 80;
const LOGO = "https://gateway.irys.xyz/7KOIQD6D5bArYKAyOz8xtSmDDGKV7DbMOLo4oUhOlHI";

export default function App() {
  const { pool, loading } = usePool();
  const { positions } = useWalletRecord();

  const currentPrice = pool ? pool.wsolAmount / pool.skyeAmount : 0;
  const priceUsd = currentPrice * SOL_USD;
  const mcSol = currentPrice * 1e9;
  const mcUsd = mcSol * SOL_USD;

  return (
    <div className="min-h-screen bg-surface-bg">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-white/70 backdrop-blur-xl border-b border-gray-200/60">
        <div className="max-w-2xl mx-auto px-5 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={LOGO} alt="SKYE" className="w-9 h-9 rounded-xl shadow-sm" />
            <div>
              <h1 className="text-[15px] font-bold text-ink-primary leading-tight">Skye Ladder</h1>
              {!loading && pool && (
                <div className="flex items-center gap-3 text-[12px] leading-tight">
                  <span className="text-ink-secondary">{formatUsd(priceUsd, 6)}</span>
                  <span className="text-ink-tertiary">MC {formatUsd(mcUsd, 0)}</span>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <ActivityButton />
            <WalletMultiButton />
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="max-w-2xl mx-auto px-5 pt-8 pb-16 space-y-6">
        {loading ? (
          <div className="flex items-center justify-center py-24">
            <div className="text-ink-tertiary text-[14px]">Loading pool...</div>
          </div>
        ) : (
          <>
            <SwapPanel currentPrice={currentPrice} solUsd={SOL_USD} />
            <UnlockProgress positions={positions} currentPrice={currentPrice} />
            {/* Tiers always visible — no wallet required */}
            <TierBreakdown positions={positions} currentPrice={currentPrice} />
          </>
        )}
      </main>

      <footer className="border-t border-gray-200/60 py-6 text-center text-[12px] text-ink-tertiary">
        Structured sell restrictions on Solana &middot; Token-2022 Transfer Hook
      </footer>
    </div>
  );
}
