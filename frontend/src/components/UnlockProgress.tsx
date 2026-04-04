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
  if (!publicKey) return null;

  // Filter out empty positions
  const activePositions = positions.filter(p => p.tokenBalance > 0);

  if (activePositions.length === 0) {
    return (
      <div className="glass p-6">
        <h2 className="text-[15px] font-bold text-ink-primary mb-3">Unlock Progress</h2>
        <div className="h-3 bg-white/5 rounded-full mb-6" />
        <p className="text-[13px] text-ink-tertiary text-center">No active positions. Buy SKYE to start.</p>
      </div>
    );
  }

  if (currentPrice === 0) return null;

  const enriched = activePositions.map((p) => enrichPosition(p, currentPrice));
  const primary = enriched.reduce((b, p) => (p.tokenBalance > b.tokenBalance ? p : b), enriched[0]);
  const fillPct = multToPercent(primary.multiplier);
  const totalSellable = enriched.reduce((s, p) => s + p.sellableTokens, 0);
  const totalBalance = enriched.reduce((s, p) => s + p.tokenBalance, 0);

  return (
    <div className="glass p-6">
      <div className="flex items-baseline justify-between mb-5">
        <h2 className="text-[15px] font-bold text-ink-primary">Unlock Progress</h2>
        <div className="text-right tabular-nums">
          <span className="text-[22px] font-bold text-skye-400">{primary.multiplier.toFixed(2)}x</span>
          <span className="text-[13px] text-ink-tertiary ml-2">{phaseLabel(primary.multiplier)}</span>
        </div>
      </div>

      <div className="flex items-baseline justify-between mb-3 text-[13px]">
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

      <div className="flex justify-between text-[13px] mt-2 pt-4 border-t border-white/5">
        <span className="text-ink-secondary">{formatTokens(totalBalance, 0)} SKYE held</span>
        <span className="font-semibold text-skye-400">{formatTokens(totalSellable, 0)} sellable</span>
      </div>
    </div>
  );
}
