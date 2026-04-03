import { useState } from "react";
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

export function ActivityButton() {
  const { publicKey } = useWallet();
  const [open, setOpen] = useState(false);

  if (!publicKey) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-9 h-9 flex items-center justify-center rounded-xl bg-gray-100 hover:bg-gray-200 transition-colors"
        title="Activity"
      >
        <svg className="w-4 h-4 text-ink-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </button>

      {open && <ActivityModal onClose={() => setOpen(false)} />}
    </>
  );
}

function ActivityModal({ onClose }: { onClose: () => void }) {
  const { trades, loading } = useActivity();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />

      {/* Modal */}
      <div
        className="relative bg-white rounded-2xl shadow-elevated w-full max-w-md max-h-[70vh] flex flex-col overflow-hidden animate-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="text-[15px] font-bold text-ink-primary">Activity</h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 transition-colors">
            <svg className="w-4 h-4 text-ink-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="overflow-y-auto flex-1 px-2 py-2">
          {loading && trades.length === 0 && (
            <p className="text-[13px] text-ink-tertiary text-center py-8">Loading trades...</p>
          )}
          {!loading && trades.length === 0 && (
            <p className="text-[13px] text-ink-tertiary text-center py-8">No SKYE trades yet</p>
          )}
          {trades.map((t) => (
            <a
              key={t.signature}
              href={`https://solscan.io/tx/${t.signature}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-50 transition-colors"
            >
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-[12px] font-bold flex-shrink-0 ${
                t.type === "buy" ? "bg-skye-500" : "bg-rose-400"
              }`}>
                {t.type === "buy" ? "B" : "S"}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between">
                  <span className="text-[13px] font-semibold text-ink-primary">
                    {t.type === "buy" ? "+" : "-"}{formatTokens(t.skyeAmount, 0)} SKYE
                  </span>
                  <span className="text-[12px] text-ink-tertiary tabular-nums">
                    {t.timestamp > 0 ? timeAgo(t.timestamp) : ""}
                  </span>
                </div>
                <span className="text-[12px] text-ink-tertiary">
                  {t.type === "buy" ? "for" : "received"} {formatSol(t.solAmount, 4)} SOL
                </span>
              </div>
              <svg className="w-3.5 h-3.5 text-ink-faint flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
