import { useState } from "react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletRecord } from "../hooks/useWalletRecord";
import { useBalances, type TokenBalance } from "../hooks/useBalances";
import { usePool } from "../hooks/usePool";
import { enrichPosition } from "../lib/unlock";
import { formatTokens, formatUsd, computeSwapOutput } from "../lib/format";

interface Props { currentPrice: number; solUsd: number; }

export function Portfolio({ currentPrice, solUsd }: Props) {
  const { publicKey } = useWallet();
  const { positions } = useWalletRecord();
  const { solBalance, allTokens } = useBalances();
  const { pool } = usePool();
  const [showAll, setShowAll] = useState(false);

  if (!publicKey) return null;

  const activePositions = positions.filter(p => p.tokenBalance > 0);
  const enriched = activePositions.map(p => enrichPosition(p, currentPrice));
  const totalTokens = enriched.reduce((s, p) => s + p.tokenBalance, 0);
  const totalSellable = enriched.reduce((s, p) => s + p.sellableTokens, 0);
  const totalCostSol = enriched.reduce((s, p) => s + p.initialSol, 0);

  // Current value in SOL
  const valueSolLamports = totalTokens > 0 && pool
    ? computeSwapOutput(pool.skyeAmount, pool.wsolAmount, totalTokens, pool.feeBps) : 0;
  const valueSol = valueSolLamports / LAMPORTS_PER_SOL;
  const valueUsd = valueSol * solUsd;
  const costSol = totalCostSol / LAMPORTS_PER_SOL;
  const pnlSol = valueSol - costSol;
  const pnlPct = costSol > 0 ? ((valueSol - costSol) / costSol) * 100 : 0;
  const isProfit = pnlSol >= 0;

  const hasSkye = totalTokens > 0;
  const hasOtherTokens = allTokens.length > 0;

  if (!hasSkye && !hasOtherTokens && solBalance === null) return null;

  return (
    <div className="glass overflow-hidden">
      <div className="p-4 sm:p-5">
        <h2 className="text-[14px] sm:text-[15px] font-bold text-ink-primary mb-4">Holdings</h2>

        {/* SOL Balance — always show */}
        <div className="flex items-center justify-between py-2.5 border-b border-white/5">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-purple-500 to-cyan-400 flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0">S</div>
            <div>
              <div className="text-[13px] font-semibold text-ink-primary">SOL</div>
              <div className="text-[11px] text-ink-faint">Solana</div>
            </div>
          </div>
          <div className="text-right tabular-nums">
            <div className="text-[13px] font-semibold text-ink-primary">{solBalance !== null ? solBalance.toFixed(4) : "..."}</div>
            {solBalance !== null && <div className="text-[11px] text-ink-faint">{formatUsd(solBalance * solUsd, 2)}</div>}
          </div>
        </div>

        {/* SKYE Position Summary */}
        {hasSkye && pool && (
          <div className="flex items-center justify-between py-2.5 border-b border-white/5">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-skye-500 to-skye-700 flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0">SK</div>
              <div>
                <div className="text-[13px] font-semibold text-ink-primary">SKYE</div>
                <div className="text-[11px] text-ink-faint">{enriched.length} position{enriched.length !== 1 ? "s" : ""}</div>
              </div>
            </div>
            <div className="text-right tabular-nums">
              <div className="text-[13px] font-semibold text-ink-primary">{formatTokens(totalTokens, 0)}</div>
              <div className="text-[11px] text-ink-faint">{valueSol.toFixed(4)} SOL</div>
            </div>
          </div>
        )}

        {/* SKYE P&L Card */}
        {hasSkye && pool && (
          <div className="mt-3 grid grid-cols-3 gap-2">
            <div className="bg-white/5 rounded-lg p-2.5 text-center">
              <div className="text-[10px] text-ink-tertiary mb-0.5">Value</div>
              <div className="text-[13px] font-bold text-ink-primary tabular-nums">{valueSol.toFixed(4)}</div>
              <div className="text-[10px] text-ink-faint">{formatUsd(valueUsd, 2)}</div>
            </div>
            <div className="bg-white/5 rounded-lg p-2.5 text-center">
              <div className="text-[10px] text-ink-tertiary mb-0.5">Cost</div>
              <div className="text-[13px] font-bold text-ink-primary tabular-nums">{costSol.toFixed(4)}</div>
              <div className="text-[10px] text-ink-faint">{formatUsd(costSol * solUsd, 2)}</div>
            </div>
            <div className="bg-white/5 rounded-lg p-2.5 text-center">
              <div className="text-[10px] text-ink-tertiary mb-0.5">P&L</div>
              <div className={`text-[13px] font-bold tabular-nums ${isProfit ? "text-emerald-400" : "text-rose-400"}`}>
                {isProfit ? "+" : ""}{pnlSol.toFixed(4)}
              </div>
              <div className={`text-[10px] ${isProfit ? "text-emerald-400/70" : "text-rose-400/70"}`}>
                {isProfit ? "+" : ""}{pnlPct.toFixed(1)}%
              </div>
            </div>
          </div>
        )}

        {/* SKYE Positions Detail */}
        {hasSkye && enriched.length > 0 && (
          <div className="mt-3 space-y-1.5">
            {enriched.map((pos, i) => (
              <div key={i} className="flex items-center justify-between text-[12px] bg-white/3 rounded-lg px-3 py-2">
                <div className="flex items-center gap-2">
                  <div className={`w-1.5 h-1.5 rounded-full ${pos.multiplier >= 15 ? "bg-emerald-400" : pos.multiplier >= 1 ? "bg-skye-400" : "bg-rose-400"}`} />
                  <span className="text-ink-secondary font-medium tabular-nums">{pos.multiplier.toFixed(2)}x</span>
                  <span className="text-ink-faint">{pos.phase}</span>
                </div>
                <div className="text-right tabular-nums">
                  <span className="text-ink-primary font-medium">{formatTokens(pos.tokenBalance, 0)}</span>
                  <span className="text-ink-faint ml-2">({(pos.effectiveBps / 100).toFixed(1)}%)</span>
                </div>
              </div>
            ))}
            {totalSellable > 0 && (
              <div className="flex justify-between items-center text-[12px] pt-2 border-t border-white/5">
                <span className="text-ink-tertiary">Sellable now</span>
                <span className="font-semibold text-skye-400">{formatTokens(totalSellable, 0)} SKYE</span>
              </div>
            )}
          </div>
        )}

        {/* Other Tokens */}
        {hasOtherTokens && (
          <div className="mt-3 pt-3 border-t border-white/5">
            {(showAll ? allTokens : allTokens.slice(0, 3)).map((token) => (
              <TokenRow key={token.mint} token={token} />
            ))}
            {allTokens.length > 3 && (
              <button
                onClick={() => setShowAll(!showAll)}
                className="w-full py-2 text-[12px] text-skye-400 font-semibold hover:underline"
              >
                {showAll ? "Show less" : `Show all (${allTokens.length} tokens)`}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TokenRow({ token }: { token: TokenBalance }) {
  // Skip SKYE in the generic list (it's shown above with positions)
  const skyeMint = "5GtUWP1x4LpKjAzGBZg9sy9TbTqjY2bvJfgfC7aUmAfF";
  if (token.mint === skyeMint) return null;

  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex items-center gap-2.5">
        {token.logo ? (
          <img src={token.logo} alt={token.symbol} className="w-7 h-7 rounded-full flex-shrink-0" />
        ) : (
          <div className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center text-[9px] font-bold text-ink-tertiary flex-shrink-0">
            {token.symbol.slice(0, 2)}
          </div>
        )}
        <div>
          <div className="text-[13px] font-semibold text-ink-primary">{token.symbol}</div>
          {token.isToken2022 && <div className="text-[10px] text-ink-faint">Token-2022</div>}
          {token.isNative && <div className="text-[10px] text-ink-faint">Wrapped SOL</div>}
        </div>
      </div>
      <div className="text-right tabular-nums">
        <div className="text-[13px] font-semibold text-ink-primary">{token.uiAmount}</div>
        <div className="text-[10px] text-ink-faint font-mono">{token.mint.slice(0, 4)}...{token.mint.slice(-4)}</div>
      </div>
    </div>
  );
}
