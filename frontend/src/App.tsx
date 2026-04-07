import React, { useState, useEffect } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useWallet } from "@solana/wallet-adapter-react";
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
import { TradeFlash } from "./components/TradeFlash";
import { LaunchTab } from "./components/LaunchTab";
import { DiscoverTab } from "./components/DiscoverTab";
import { WorldTab } from "./components/WorldTab";

const LOGO = "/logo.jpeg";
type Tab = "trade" | "chart" | "world" | "launch" | "discover" | "about";

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
  const { solBalance, skyeBalance } = useBalances();
  const { connected, disconnect, publicKey } = useWallet();
  const [tab, setTab] = useState<Tab>("trade");

  async function handleDisconnect() {
    try {
      const phantom = (window as any)?.phantom?.solana;
      if (phantom?.disconnect) await phantom.disconnect();
    } catch {}
    await disconnect();
    localStorage.removeItem("walletName");
  }

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
                <div className="flex items-center gap-2 sm:gap-3 text-[10px] sm:text-[11px] leading-tight truncate">
                  <img src="https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png" alt="SOL" className="w-3.5 h-3.5 rounded-full" />
                  <span className="text-ink-secondary tabular-nums">{formatUsd(solUsd, 2)}</span>
                  <span className="text-white/10">|</span>
                  <span className="text-skye-400 tabular-nums">{formatUsd(priceUsd, 8)}</span>
                  <span className="text-ink-faint">MC {formatUsd(mcUsd, 0)}</span>
                </div>
              )}
            </div>
          </div>
          {connected ? (
              <WalletMenu
                address={publicKey?.toBase58() ?? ""}
                solBalance={solBalance}
                onDisconnect={handleDisconnect}
              />
            ) : (
              <WalletMultiButton />
            )}
        </div>
      </header>

      {/* Tab bar */}
      <div className="sticky top-14 sm:top-16 z-10 glass border-b border-white/5">
        <div className="max-w-2xl mx-auto px-4 sm:px-5 flex">
          {([
            { id: "trade" as Tab, label: "Trade" },
            { id: "chart" as Tab, label: "Chart" },
            { id: "world" as Tab, label: "World" },
            { id: "launch" as Tab, label: "Launch" },
            { id: "discover" as Tab, label: "Discover" },
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
      <main className={`mx-auto px-4 sm:px-5 pt-6 sm:pt-8 pb-16 space-y-5 sm:space-y-6 ${tab === "discover" || tab === "world" ? "max-w-5xl" : "max-w-2xl"}`}>
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
                <SwapPanel currentPrice={currentPrice} solUsd={solUsd} pool={pool} positions={positions} solBalance={solBalance} skyeBalance={skyeBalance} />
                <UnlockProgress positions={positions} currentPrice={currentPrice} skyeBalance={skyeBalance} />
                <TierBreakdown positions={positions} currentPrice={currentPrice} />
              </>
            )}
            {tab === "chart" && <SafeChart><ChartTab /></SafeChart>}
            {tab === "world" && <WorldTab />}
            {tab === "launch" && <LaunchTab />}
            {tab === "discover" && <DiscoverTab />}
            {tab === "about" && <AboutTab />}
          </>
        )}
      </main>

      <TradeFlash />

      <footer className="relative z-10 border-t border-white/5 py-6 text-center px-4 space-y-2">
        <FooterCA />
      </footer>
    </div>
  );
}

function FooterCA() {
  const [copied, setCopied] = useState(false);
  const ca = "5GtUWP1x4LpKjAzGBZg9sy9TbTqjY2bvJfgfC7aUmAfF";
  function handleCopy() {
    navigator.clipboard.writeText(ca).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }
  return (
    <button onClick={handleCopy}
      className="inline-flex items-center gap-2 px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg transition-colors group">
      <span className="font-mono text-[11px] sm:text-[12px] text-white break-all">CA: {ca}</span>
      <span className={`text-[11px] font-semibold flex-shrink-0 transition-colors ${copied ? "text-emerald-400" : "text-skye-400 group-hover:text-skye-300"}`}>
        {copied ? "✓" : "Copy"}
      </span>
    </button>
  );
}

function WalletMenu({ address, solBalance, onDisconnect }: { address: string; solBalance: number | null; onDisconnect: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const short = address ? `${address.slice(0, 4)}...${address.slice(-4)}` : "";

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 bg-white/5 hover:bg-white/10 rounded-lg border border-white/10 transition-colors">
        <div className="w-2 h-2 rounded-full bg-emerald-400" />
        <span className="text-[12px] font-mono text-ink-primary">{short}</span>
        {solBalance !== null && (
          <span className="text-[11px] text-ink-faint hidden sm:inline">{solBalance.toFixed(2)} SOL</span>
        )}
        <svg className={`w-3 h-3 text-ink-faint transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-52 bg-[rgba(15,15,25,0.98)] backdrop-blur-xl border border-white/10 rounded-xl shadow-xl overflow-hidden z-50">
          {/* Copy address */}
          <button onClick={() => { navigator.clipboard.writeText(address); setOpen(false); }}
            className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors text-left">
            <svg className="w-4 h-4 text-ink-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
            <span className="text-[13px] text-ink-primary">Copy Address</span>
          </button>

          {/* Change Wallet — greyed out for future */}
          <div className="w-full flex items-center gap-3 px-4 py-3 opacity-30 cursor-not-allowed">
            <svg className="w-4 h-4 text-ink-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>
            <div>
              <span className="text-[13px] text-ink-primary block">Change Wallet</span>
              <span className="text-[10px] text-ink-faint">Coming soon</span>
            </div>
          </div>

          {/* skyefall.gg — greyed out for future */}
          <div className="w-full flex items-center gap-3 px-4 py-3 opacity-30 cursor-not-allowed">
            <svg className="w-4 h-4 text-ink-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9" /></svg>
            <div>
              <span className="text-[13px] text-ink-primary block">skyefall.gg</span>
              <span className="text-[10px] text-ink-faint">Coming soon</span>
            </div>
          </div>

          <div className="border-t border-white/5" />

          {/* Disconnect */}
          <button onClick={() => { onDisconnect(); setOpen(false); }}
            className="w-full flex items-center gap-3 px-4 py-3 hover:bg-rose-500/10 transition-colors text-left">
            <svg className="w-4 h-4 text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
            <span className="text-[13px] text-rose-400">Disconnect</span>
          </button>
        </div>
      )}
    </div>
  );
}
