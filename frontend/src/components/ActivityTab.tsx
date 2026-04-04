import { useActivity } from "../hooks/useActivity";
import { useWallet } from "@solana/wallet-adapter-react";
import { formatTokens, formatSol } from "../lib/format";

function timeAgo(ts: number): string {
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function ActivityTab() {
  const { publicKey } = useWallet();
  const { trades, loading } = useActivity();

  if (!publicKey) {
    return (
      <div className="glass p-8 text-center">
        <p className="text-ink-tertiary text-[14px]">Connect wallet to see activity</p>
      </div>
    );
  }

  return (
    <div className="glass overflow-hidden">
      <div className="px-5 py-4 border-b border-white/5">
        <h2 className="text-[16px] font-bold text-ink-primary">Transaction History</h2>
      </div>
      <div className="divide-y divide-white/5">
        {loading && trades.length === 0 && (
          <p className="text-[14px] text-ink-tertiary text-center py-12">Loading trades...</p>
        )}
        {!loading && trades.length === 0 && (
          <p className="text-[14px] text-ink-tertiary text-center py-12">No SKYE trades yet</p>
        )}
        {trades.map((t) => (
          <a key={t.signature} href={`https://solscan.io/tx/${t.signature}`} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-3 px-5 py-4 hover:bg-white/5 active:bg-white/10 transition-colors">
            <div className={`w-9 h-9 rounded-full flex items-center justify-center text-white text-[13px] font-bold flex-shrink-0 ${t.type === "buy" ? "bg-skye-500" : "bg-rose-400"}`}>
              {t.type === "buy" ? "B" : "S"}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[14px] font-semibold text-ink-primary truncate">
                  {t.type === "buy" ? "Bought" : "Sold"} {formatTokens(t.skyeAmount, 0)} SKYE
                </span>
                <span className="text-[12px] text-ink-tertiary tabular-nums flex-shrink-0">
                  {t.timestamp > 0 ? timeAgo(t.timestamp) : ""}
                </span>
              </div>
              <span className="text-[13px] text-ink-tertiary">
                {t.type === "buy" ? "for" : "received"} {formatSol(t.solAmount, 4)} SOL
              </span>
            </div>
            <svg className="w-4 h-4 text-ink-faint flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        ))}
      </div>
    </div>
  );
}
