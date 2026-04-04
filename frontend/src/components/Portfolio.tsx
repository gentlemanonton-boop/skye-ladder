import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletRecord } from "../hooks/useWalletRecord";
import { useBalances } from "../hooks/useBalances";
import { usePool } from "../hooks/usePool";
import { enrichPosition, type Position } from "../lib/unlock";
import { formatTokens, formatUsd, rawToHuman, computeSwapOutput } from "../lib/format";

interface Props { currentPrice: number; solUsd: number; }

export function Portfolio({ currentPrice, solUsd }: Props) {
  const { publicKey } = useWallet();
  const { positions } = useWalletRecord();
  const { skyeBalance } = useBalances();
  const { pool } = usePool();

  if (!publicKey || !pool) return null;

  const activePositions = positions.filter(p => p.tokenBalance > 0);
  if (activePositions.length === 0 && (skyeBalance === null || skyeBalance === 0)) return null;

  const enriched = activePositions.map(p => enrichPosition(p, currentPrice));
  const totalTokens = enriched.reduce((s, p) => s + p.tokenBalance, 0);
  const totalSellable = enriched.reduce((s, p) => s + p.sellableTokens, 0);
  const totalCostSol = enriched.reduce((s, p) => s + p.initialSol, 0);

  // Current value in SOL (what you'd get if you sold everything sellable)
  const valueSolLamports = totalTokens > 0
    ? computeSwapOutput(pool.skyeAmount, pool.wsolAmount, totalTokens, pool.feeBps) : 0;
  const valueSol = valueSolLamports / LAMPORTS_PER_SOL;
  const valueUsd = valueSol * solUsd;

  // Cost basis
  const costSol = totalCostSol / LAMPORTS_PER_SOL;

  // P&L
  const pnlSol = valueSol - costSol;
  const pnlPct = costSol > 0 ? ((valueSol - costSol) / costSol) * 100 : 0;
  const isProfit = pnlSol >= 0;

  return (
    <div className="glass overflow-hidden">
      <div className="p-4 sm:p-5">
        <h2 className="text-[14px] sm:text-[15px] font-bold text-ink-primary mb-4">Holdings</h2>

        <div className="grid grid-cols-2 gap-3">
          <div className="bg-white/5 rounded-xl p-3">
            <div className="text-[11px] text-ink-tertiary mb-1">Balance</div>
            <div className="text-[16px] font-bold text-ink-primary tabular-nums">
              {formatTokens(totalTokens, 0)}
            </div>
            <div className="text-[11px] text-ink-faint">SKYE</div>
          </div>

          <div className="bg-white/5 rounded-xl p-3">
            <div className="text-[11px] text-ink-tertiary mb-1">Value</div>
            <div className="text-[16px] font-bold text-ink-primary tabular-nums">
              {valueSol.toFixed(4)} SOL
            </div>
            <div className="text-[11px] text-ink-faint">{formatUsd(valueUsd, 2)}</div>
          </div>

          <div className="bg-white/5 rounded-xl p-3">
            <div className="text-[11px] text-ink-tertiary mb-1">Cost Basis</div>
            <div className="text-[16px] font-bold text-ink-primary tabular-nums">
              {costSol.toFixed(4)} SOL
            </div>
            <div className="text-[11px] text-ink-faint">{formatUsd(costSol * solUsd, 2)}</div>
          </div>

          <div className="bg-white/5 rounded-xl p-3">
            <div className="text-[11px] text-ink-tertiary mb-1">P&L</div>
            <div className={`text-[16px] font-bold tabular-nums ${isProfit ? "text-emerald-400" : "text-rose-400"}`}>
              {isProfit ? "+" : ""}{pnlSol.toFixed(4)} SOL
            </div>
            <div className={`text-[11px] ${isProfit ? "text-emerald-400/70" : "text-rose-400/70"}`}>
              {isProfit ? "+" : ""}{pnlPct.toFixed(1)}%
            </div>
          </div>
        </div>

        {/* Position breakdown */}
        {enriched.length > 0 && (
          <div className="mt-4 pt-3 border-t border-white/5 space-y-2">
            <div className="text-[12px] text-ink-tertiary font-medium">Positions ({enriched.length})</div>
            {enriched.map((pos, i) => (
              <div key={i} className="flex items-center justify-between text-[12px] bg-white/3 rounded-lg px-3 py-2">
                <div className="flex items-center gap-2">
                  <div className={`w-1.5 h-1.5 rounded-full ${pos.multiplier >= 15 ? "bg-emerald-400" : pos.multiplier >= 1 ? "bg-skye-400" : "bg-rose-400"}`} />
                  <span className="text-ink-secondary font-medium tabular-nums">{pos.multiplier.toFixed(2)}x</span>
                  <span className="text-ink-faint">{pos.phase}</span>
                </div>
                <div className="text-right tabular-nums">
                  <span className="text-ink-primary font-medium">{formatTokens(pos.tokenBalance, 0)}</span>
                  <span className="text-ink-faint ml-2">({(pos.effectiveBps / 100).toFixed(1)}% unlocked)</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Sellable summary */}
        {totalSellable > 0 && (
          <div className="mt-3 flex justify-between items-center text-[13px] pt-3 border-t border-white/5">
            <span className="text-ink-tertiary">Sellable now</span>
            <span className="font-semibold text-skye-400">{formatTokens(totalSellable, 0)} SKYE</span>
          </div>
        )}
      </div>
    </div>
  );
}
