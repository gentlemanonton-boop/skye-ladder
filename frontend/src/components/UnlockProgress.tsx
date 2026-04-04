import { useState } from "react";
import { enrichPosition, type Position } from "../lib/unlock";
import { formatPercent, formatTokens } from "../lib/format";
import { useWallet } from "@solana/wallet-adapter-react";

interface Props {
  positions: Position[];
  currentPrice: number;
}

const MILESTONES = [
  { x: 1, label: "1x", pct: 0 },
  { x: 2, label: "2x", pct: 13.33 },
  { x: 5, label: "5x", pct: 33.33 },
  { x: 10, label: "10x", pct: 60 },
  { x: 15, label: "15x", pct: 100 },
];

function multToPercent(mult: number): number {
  if (mult <= 1) return 0;
  if (mult >= 15) return 100;
  for (let i = 1; i < MILESTONES.length; i++) {
    const prev = MILESTONES[i - 1];
    const curr = MILESTONES[i];
    if (mult <= curr.x) {
      return prev.pct + ((mult - prev.x) / (curr.x - prev.x)) * (curr.pct - prev.pct);
    }
  }
  return 100;
}

function phaseLabel(mult: number): string {
  if (mult <= 1) return "Underwater";
  if (mult < 2) return "Phase 1";
  if (mult < 5) return "Phase 2";
  if (mult < 10) return "Phase 3";
  if (mult < 15) return "Phase 4";
  return "Phase 5";
}

export function UnlockProgress({ positions, currentPrice }: Props) {
  const { publicKey } = useWallet();
  const [collapsed, setCollapsed] = useState(true);
  if (!publicKey) return null;

  const activePositions = positions.filter(p => p.tokenBalance > 0);

  if (activePositions.length === 0) return null;
  if (currentPrice === 0) return null;

  const enriched = activePositions.map((p) => enrichPosition(p, currentPrice));
  const primary = enriched.reduce((b, p) => (p.tokenBalance > b.tokenBalance ? p : b), enriched[0]);
  const fillPct = multToPercent(primary.multiplier);
  const totalSellable = enriched.reduce((s, p) => s + p.sellableTokens, 0);
  const totalBalance = enriched.reduce((s, p) => s + p.tokenBalance, 0);

  return (
    <div className="glass overflow-hidden">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full p-4 sm:p-5 flex items-center justify-between"
      >
        <div className="flex items-center gap-3">
          <h2 className="text-[14px] sm:text-[15px] font-bold text-ink-primary">Unlock Progress</h2>
          <span className="text-[13px] font-semibold text-skye-400 tabular-nums">{primary.multiplier.toFixed(2)}x</span>
          <span className="text-[12px] text-ink-tertiary">{phaseLabel(primary.multiplier)}</span>
        </div>
        <svg className={`w-4 h-4 text-ink-faint transition-transform duration-200 ${collapsed ? "" : "rotate-180"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      <div className={`transition-all duration-300 ease-out overflow-hidden ${collapsed ? "max-h-0" : "max-h-[400px]"}`}>
        <div className="px-4 sm:px-5 pb-4 sm:pb-5 space-y-3">
          <div className="flex items-baseline justify-between text-[13px]">
            <span className="text-ink-secondary">{formatPercent(primary.effectiveBps)} unlocked</span>
            <span className="font-semibold text-skye-400">{formatTokens(totalSellable, 0)} available</span>
          </div>

          <div className="relative">
            <div className="h-3 bg-white/5 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-700 ease-out"
                style={{ width: `${Math.max(fillPct, 2)}%`, background: "linear-gradient(90deg, #86efac, #22c55e, #16a34a)" }}
              />
            </div>
            <div
              className="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-white border-[3px] border-skye-500 shadow-soft transition-all duration-700"
              style={{ left: `calc(${Math.max(fillPct, 2)}% - 8px)` }}
            />
          </div>

          <div className="relative h-7 mt-1">
            {MILESTONES.map((m) => (
              <div key={m.label} className="absolute -translate-x-1/2 flex flex-col items-center" style={{ left: `${m.pct}%` }}>
                <div className={`w-px h-2.5 ${fillPct >= m.pct ? "bg-skye-400" : "bg-white/10"}`} />
                <span className={`text-[11px] font-semibold mt-0.5 tabular-nums ${fillPct >= m.pct ? "text-skye-400" : "text-ink-faint"}`}>
                  {m.label}
                </span>
              </div>
            ))}
          </div>

          <div className="flex justify-between text-[13px] pt-3 border-t border-white/5">
            <span className="text-ink-secondary">{formatTokens(totalBalance, 0)} SKYE held</span>
            <span className="font-semibold text-skye-400">{formatTokens(totalSellable, 0)} sellable</span>
          </div>
        </div>
      </div>
    </div>
  );
}
