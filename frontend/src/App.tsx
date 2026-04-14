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
import { FloatingMemes } from "./components/FloatingMemes";
const LOGO = "/logo.jpeg";
type Tab = "trade" | "chart" | "launch" | "discover" | "about";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "trade", label: "Trade", icon: "M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" },
  { id: "chart", label: "Chart", icon: "M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" },
  { id: "launch", label: "Create", icon: "M12 4v16m8-8H4" },
  { id: "discover", label: "Discover", icon: "M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" },
  { id: "about", label: "About", icon: "M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
];

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

  // Clear the disconnect flag when user reconnects
  useEffect(() => {
    if (connected) localStorage.removeItem("wallet_disconnected");
  }, [connected]);

  async function handleDisconnect() {
    try {
      const phantom = (window as any)?.phantom?.solana;
      if (phantom?.disconnect) await phantom.disconnect();
    } catch {}
    await disconnect();
    localStorage.removeItem("walletName");
    localStorage.setItem("wallet_disconnected", "1");
  }

  const currentPrice = pool ? pool.wsolAmount / pool.skyeAmount : 0;
  const priceUsd = currentPrice * solUsd;
  const mcSol = currentPrice * 1e9;
  const mcUsd = mcSol * solUsd;

  return (
    <div className="min-h-screen relative">
      {/* ─── Background layers ─── */}
      <div className="reactive-grid">
        <div className="reactive-grid-inner" />
      </div>
      <div className="light-beam" />
      <div className="vignette" />
      <div className="particles" aria-hidden="true">
        {Array.from({ length: 20 }).map((_, i) => (
          <div
            key={i}
            className="particle"
            style={{
              left: `${(i * 5.3 + 2) % 100}%`,
              animationDuration: `${8 + (i % 7) * 2.5}s`,
              animationDelay: `${(i * 1.3) % 10}s`,
              // @ts-ignore
              '--drift': `${(i % 2 === 0 ? 1 : -1) * (10 + i % 15)}px`,
            } as React.CSSProperties}
          />
        ))}
      </div>

      {/* ─── Floating Memes ─── */}
      <FloatingMemes />

      {/* ─── Header ─── */}
      <header className="sticky top-0 z-20 frost" style={{ borderRadius: 0 }}>
        <div className="max-w-2xl mx-auto px-5 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3.5 min-w-0">
            <div className="relative">
              <img src={LOGO} alt="SKYE" className="w-10 h-10 rounded-2xl flex-shrink-0 ring-1 ring-white/10" />
              <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-skye-400 border-2 border-surface-0 breathe" />
            </div>
            <div className="min-w-0">
              <h1 className="text-[16px] sm:text-[17px] font-semibold text-white leading-tight tracking-tighter">Skye</h1>
              {!loading && pool && (
                <div className="flex items-center gap-2.5 text-[11px] leading-tight truncate mt-0.5">
                  <span className="text-ink-tertiary tabular-nums">{formatUsd(solUsd, 2)}</span>
                  <span className="text-ink-ghost">·</span>
                  <span className="text-skye-400 tabular-nums font-semibold">{formatUsd(priceUsd, 8)}</span>
                  <span className="text-ink-ghost">·</span>
                  <span className="text-ink-faint tabular-nums">MC <span className="text-ink-tertiary">{formatUsd(mcUsd, 0)}</span></span>
                </div>
              )}
            </div>
          </div>
          {connected ? (
            <WalletMenu address={publicKey?.toBase58() ?? ""} solBalance={solBalance} onDisconnect={handleDisconnect} />
          ) : (
            <WalletMultiButton />
          )}
        </div>
        <div className="h-px bg-gradient-to-r from-transparent via-skye-500/20 to-transparent" />
      </header>

      {/* ─── Tab Bar with icons ─── */}
      <div className="sticky top-16 z-10 py-3" style={{ background: "rgba(9,9,11,0.7)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)" }}>
        <div className="max-w-2xl mx-auto px-5 sm:px-6">
          <div className="flex bg-surface-1/80 rounded-2xl p-1.5 border border-white/[0.04] gap-1">
            {TABS.map(({ id, label, icon }) => (
              <button key={id} onClick={() => setTab(id)}
                className={`flex-1 py-2.5 text-[12px] sm:text-[13px] font-medium text-center rounded-xl transition-all duration-300 relative flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 ${
                  tab === id
                    ? "bg-surface-2 text-white shadow-lg shadow-black/20"
                    : "text-ink-faint hover:text-ink-secondary hover:bg-white/[0.02]"
                }`}>
                <svg className={`w-3.5 h-3.5 ${tab === id ? "text-skye-400" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={icon} />
                </svg>
                <span className="hidden sm:inline">{label}</span>
                {tab === id && <div className="absolute -bottom-0.5 left-1/4 right-1/4 h-[2px] rounded-full bg-gradient-to-r from-skye-500/0 via-skye-400 to-skye-500/0" />}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ─── Content ─── */}
      <main className="mx-auto px-5 sm:px-6 pt-6 sm:pt-8 pb-20 space-y-5 sm:space-y-6 max-w-6xl">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-32 gap-5">
            <div className="relative w-10 h-10">
              <div className="absolute inset-0 rounded-full border-2 border-skye-500/20 border-t-skye-400 animate-spin" />
              <div className="absolute inset-2 rounded-full border-2 border-purple-500/10 border-b-purple-400/50 animate-spin" style={{ animationDirection: "reverse", animationDuration: "1.5s" }} />
            </div>
            <span className="text-ink-faint text-[13px] shimmer-text">Loading pool...</span>
          </div>
        ) : poolError ? (
          <div className="glass p-12 text-center space-y-5">
            <div className="w-12 h-12 mx-auto rounded-2xl bg-rose-500/10 flex items-center justify-center">
              <svg className="w-6 h-6 text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" /></svg>
            </div>
            <p className="text-white font-semibold text-[18px] tracking-tight">Failed to load pool</p>
            <p className="text-ink-tertiary text-[14px] max-w-xs mx-auto">{poolError}</p>
            <button onClick={() => window.location.reload()} className="btn-glow inline-flex px-6 py-2.5 rounded-full bg-surface-2 text-white text-[14px] font-medium border border-white/[0.08]">Retry</button>
          </div>
        ) : (
          <div key={tab} className="tab-content space-y-5 sm:space-y-6">
            {tab === "trade" && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                <div className="gradient-border self-start lg:sticky lg:top-32">
                  <SwapPanel currentPrice={currentPrice} solUsd={solUsd} pool={pool} positions={positions} solBalance={solBalance} skyeBalance={skyeBalance} />
                </div>
                <div className="space-y-5">
                  <UnlockProgress positions={positions} currentPrice={currentPrice} skyeBalance={skyeBalance} />
                  <TierBreakdown positions={positions} currentPrice={currentPrice} />
                </div>
              </div>
            )}
            {tab === "chart" && <SafeChart><ChartTab /></SafeChart>}
            {tab === "launch" && <LaunchTab />}
            {tab === "discover" && <DiscoverTab />}
            {tab === "about" && <AboutTab />}
          </div>
        )}
      </main>

      <TradeFlash />

      {/* ─── Footer ─── */}
      <footer className="relative z-10 py-10 text-center px-5 space-y-5">
        <div className="h-px bg-gradient-to-r from-transparent via-skye-500/15 to-transparent" />
        <FooterCA />
        <div className="flex items-center justify-center gap-2 mt-4">
          <div className="pixel-bar w-8" />
          <span className="font-pixel text-[6px] text-ink-ghost tracking-[0.3em]">SKYE</span>
          <div className="pixel-bar w-8" />
        </div>
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
      className="btn-glow inline-flex items-center gap-3 px-5 py-3 bg-surface-1 border border-white/[0.06] rounded-full transition-all duration-300 group">
      <span className="font-mono text-[11px] sm:text-[12px] text-ink-tertiary break-all">CA: {ca}</span>
      <span className={`text-[11px] font-semibold flex-shrink-0 transition-all duration-300 ${copied ? "text-skye-400 scale-110" : "text-ink-faint group-hover:text-skye-400"}`}>
        {copied ? "Copied!" : "Copy"}
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
        className="flex items-center gap-2.5 px-4 py-2.5 bg-surface-1 hover:bg-surface-2 rounded-full border border-white/[0.06] hover:border-skye-500/20 transition-all duration-300 group">
        <div className="w-2 h-2 rounded-full bg-skye-400 group-hover:shadow-[0_0_8px_rgba(16,185,129,0.5)] transition-shadow" />
        <span className="text-[12px] font-mono text-white">{short}</span>
        {solBalance !== null && (
          <span className="text-[11px] text-ink-faint hidden sm:inline tabular-nums">{solBalance.toFixed(2)} SOL</span>
        )}
        <svg className={`w-3.5 h-3.5 text-ink-faint transition-all duration-300 ${open ? "rotate-180 text-skye-400" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2.5 w-56 glass-elevated overflow-hidden z-50 animate-scale-in">
          <div className="p-1.5 space-y-0.5">
            <button onClick={() => { navigator.clipboard.writeText(address); setOpen(false); }}
              className="w-full flex items-center gap-3 px-3.5 py-3 rounded-xl hover:bg-white/[0.04] transition-all duration-200 text-left">
              <svg className="w-4 h-4 text-ink-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
              <span className="text-[13px] text-ink-secondary">Copy Address</span>
            </button>
            <button onClick={() => { onDisconnect(); setOpen(false); }}
              className="w-full flex items-center gap-3 px-3.5 py-3 rounded-xl hover:bg-rose-500/[0.06] transition-all duration-200 text-left">
              <svg className="w-4 h-4 text-rose-400/70" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
              <span className="text-[13px] text-rose-400/70">Disconnect</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
