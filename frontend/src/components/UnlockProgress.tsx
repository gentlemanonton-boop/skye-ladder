import { useState } from "react";
import { enrichPosition, type Position } from "../lib/unlock";
import { formatPercent, formatTokens } from "../lib/format";
import { useWallet } from "@solana/wallet-adapter-react";
import { DECIMALS } from "../constants";

interface Props {
  positions: Position[];
  currentPrice: number;
  skyeBalance: number | null;
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

export function UnlockProgress({ positions, currentPrice, skyeBalance }: Props) {
  const { publicKey } = useWallet();
  const [collapsed, setCollapsed] = useState(true);
  if (!publicKey) return null;
  if (currentPrice === 0) return null;

  // Enrich all positions (corrupt ones get sanitized to underwater)
  const enriched = positions
    .filter(p => p.tokenBalance > 0)
    .map(p => enrichPosition(p, currentPrice));

  const heldHuman = skyeBalance ?? 0;
  const heldRaw = heldHuman * 10 ** DECIMALS;
  if (heldHuman <= 0 && enriched.length === 0) return null;

  // Primary = highest non-underwater position (shows real progress on the bar)
  // If all underwater, use the first one
  const nonUnderwater = enriched.filter(p => p.multiplier > 1.01);
  const primary = nonUnderwater.length > 0
    ? nonUnderwater.reduce((b, p) => (p.multiplier > b.multiplier ? p : b), nonUnderwater[0])
    : enriched.length > 0 ? enriched[0] : null;

  const mult = primary?.multiplier ?? 0;
  const fillPct = multToPercent(mult);
  const effectiveBps = primary?.effectiveBps ?? 0;

  // Total sellable from ALL positions (including sanitized), capped at wallet balance
  const totalSellableFromPositions = enriched.reduce((s, p) => s + p.sellableTokens, 0);
  const totalSellable = enriched.length > 0 ? Math.min(totalSellableFromPositions, heldRaw) : 0;

  return (
    <div className="glass scan-line overflow-hidden">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full p-4 sm:p-5 flex items-center justify-between transition-all duration-200"
      >
        <div className="flex items-center gap-3">
          <h2 className="text-[16px] font-bold text-white tracking-tighter">Unlock Progress</h2>
          {enriched.length > 0 && (
            <>
              <span className="text-gradient text-[13px] font-semibold tabular-nums">{mult.toFixed(2)}x</span>
              <span className="text-[12px] text-ink-tertiary">{phaseLabel(mult)}</span>
            </>
          )}
        </div>
        <div className="hover:bg-surface-2 rounded-lg p-1 transition-all duration-250">
          <svg className={`w-4 h-4 text-ink-faint transition-all duration-300 ${collapsed ? "" : "rotate-180"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      <div className={`transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] overflow-hidden ${collapsed ? "max-h-0" : "max-h-[400px]"}`}>
        <div className="px-4 sm:px-5 pb-4 sm:pb-5 space-y-3">
          <div className="flex items-baseline justify-between text-[14px]">
            <span className="text-ink-secondary">{formatPercent(effectiveBps)} unlocked</span>
            <span className="font-semibold text-[15px] text-skye-400">{formatTokens(totalSellable, 0)} sellable</span>
          </div>

          {/* Progress bar */}
          <div className="relative">
            <div className="h-2.5 bg-surface-2 rounded-full overflow-visible shadow-[inset_0_1px_3px_rgba(0,0,0,0.35)]">
              <div
                className="progress-fill h-full rounded-full transition-all duration-700 ease-out"
                style={{ width: `${Math.max(fillPct, 2)}%` }}
              />
            </div>
            <div
              className="breathe absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-white ring-2 ring-skye-500 shadow-glow-sm transition-all duration-700"
              style={{ left: `calc(${Math.max(fillPct, 2)}% - 8px)` }}
            />
          </div>

          <div className="relative h-7 mt-1">
            {MILESTONES.map((m) => {
              const reached = fillPct >= m.pct;
              return (
                <div key={m.label} className="absolute -translate-x-1/2 flex flex-col items-center" style={{ left: `${m.pct}%` }}>
                  <div className={`w-px h-2.5 ${reached ? "bg-skye-400" : "bg-white/10"}`} />
                  <span className={`text-[10px] mt-0.5 tabular-nums ${reached ? "text-skye-400 font-bold" : "text-ink-faint font-medium"}`}>
                    {m.label}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="flex justify-between text-[14px] pt-3 border-t border-white/[0.06]">
            <span className="text-ink-secondary text-[15px]"><span className="font-semibold text-white">{heldHuman.toLocaleString(undefined, {maximumFractionDigits: 0})}</span> SKYE held</span>
            <span className="font-semibold text-[15px] text-skye-400">{formatTokens(totalSellable, 0)} sellable</span>
          </div>

          {/* Position breakdown */}
          {enriched.length > 0 && (
            <div className="space-y-1">
              {enriched.map((pos, i) => (
                <div key={i} className="flex items-center justify-between text-[11px] bg-surface-2 rounded-xl px-4 py-2.5 border border-white/[0.06] hover:-translate-y-0.5 transition-all duration-300">
                  <div className="flex items-center gap-2">
                    <div className={`w-1.5 h-1.5 rounded-full ${pos.multiplier >= 15 ? "bg-emerald-400" : pos.multiplier >= 1 ? "bg-skye-400" : "bg-rose-400"}`} />
                    <span className="text-ink-secondary tabular-nums">{pos.multiplier.toFixed(2)}x</span>
                    <span className="text-ink-faint">{pos.phase}</span>
                  </div>
                  <span className="text-ink-tertiary tabular-nums">{formatTokens(pos.tokenBalance, 0)} ({(pos.effectiveBps / 100).toFixed(1)}%)</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
