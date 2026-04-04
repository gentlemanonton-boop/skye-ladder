import { useState, useRef, useEffect } from "react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useSwap } from "../hooks/useSwap";
import { useBalances, type TokenBalance } from "../hooks/useBalances";
import { computeSwapOutput, formatTokens, rawToHuman, formatUsd } from "../lib/format";
import { getTotalSellable, getInitialBackTokens } from "../lib/unlock";
import { DECIMALS } from "../constants";
import type { PoolState } from "../hooks/usePool";
import type { Position } from "../lib/unlock";

const SKYE_LOGO = "https://gateway.irys.xyz/YkvolVl__ug43pWw3H-cYF2vLN_zE_1LRt6FjcYmkcc";
const SOL_LOGO = "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png";

interface Props {
  currentPrice: number;
  solUsd: number;
  pool: PoolState | null;
  positions: Position[];
  solBalance: number | null;
  skyeBalance: number | null;
}

export function SwapPanel({ currentPrice, solUsd, pool, positions, solBalance, skyeBalance }: Props) {
  const { publicKey } = useWallet();
  const { swap, pending, lastTx, error } = useSwap();
  const { allTokens } = useBalances();
  const [buy, setBuy] = useState(true);
  const [amount, setAmount] = useState("");
  const [showSelector, setShowSelector] = useState<"pay" | "receive" | null>(null);

  if (!pool) return null;

  const amountNum = parseFloat(amount) || 0;
  const maxSellableRaw = getTotalSellable(positions, currentPrice);
  const maxSellableHuman = rawToHuman(maxSellableRaw);
  const totalHeld = positions.reduce((s, p) => s + p.tokenBalance, 0);

  const initialBack = getInitialBackTokens(positions, currentPrice);
  const initialBackSolLamports = initialBack.tokensRaw > 0
    ? computeSwapOutput(pool.skyeAmount, pool.wsolAmount, initialBack.tokensRaw, pool.feeBps) : 0;
  const initialBackSol = initialBackSolLamports / LAMPORTS_PER_SOL;

  // Output calculations
  let outputAmount = 0;
  let outputHuman = 0;
  let priceImpactPct = 0;

  if (amountNum > 0) {
    if (buy) {
      const lamportsIn = amountNum * LAMPORTS_PER_SOL;
      outputAmount = computeSwapOutput(pool.wsolAmount, pool.skyeAmount, lamportsIn, pool.feeBps);
      outputHuman = outputAmount / 10 ** DECIMALS;
      const spotPrice = pool.wsolAmount / pool.skyeAmount;
      const effectivePrice = lamportsIn / outputAmount;
      priceImpactPct = ((effectivePrice - spotPrice) / spotPrice) * 100;
    } else {
      const rawIn = amountNum * 10 ** DECIMALS;
      outputAmount = computeSwapOutput(pool.skyeAmount, pool.wsolAmount, rawIn, pool.feeBps);
      outputHuman = outputAmount / LAMPORTS_PER_SOL;
      const spotPrice = pool.skyeAmount / pool.wsolAmount;
      const effectivePrice = rawIn / outputAmount;
      priceImpactPct = ((effectivePrice - spotPrice) / spotPrice) * 100;
    }
  }

  function fillSellPct(pct: number) {
    setAmount((Math.floor(maxSellableHuman * pct * 10000) / 10000).toString());
  }

  async function doSwap(raw: bigint, isBuy: boolean, minOut?: bigint) {
    if (!publicKey || raw <= 0n) return;
    await swap(raw, isBuy, minOut ?? 0n);
    setAmount("");
  }

  async function handleSubmit() {
    if (amountNum <= 0) return;
    const minOut = BigInt(Math.floor(outputAmount * 0.95));
    await doSwap(buy ? BigInt(Math.floor(amountNum * LAMPORTS_PER_SOL)) : BigInt(Math.floor(amountNum * 10 ** DECIMALS)), buy, minOut);
  }

  function handleFlip() {
    setBuy(!buy);
    setAmount("");
  }

  const hasPositions = positions.length > 0 && totalHeld > 0;

  // Pay / receive token info
  const payToken = buy
    ? { symbol: "SOL", logo: SOL_LOGO, balance: solBalance, balanceLabel: solBalance?.toFixed(4) ?? "..." }
    : { symbol: "SKYE", logo: SKYE_LOGO, balance: skyeBalance, balanceLabel: skyeBalance?.toLocaleString(undefined, { maximumFractionDigits: 0 }) ?? "..." };
  const receiveToken = buy
    ? { symbol: "SKYE", logo: SKYE_LOGO, balance: skyeBalance, balanceLabel: skyeBalance?.toLocaleString(undefined, { maximumFractionDigits: 0 }) ?? "..." }
    : { symbol: "SOL", logo: SOL_LOGO, balance: solBalance, balanceLabel: solBalance?.toFixed(4) ?? "..." };

  return (
    <div className="glass overflow-hidden relative">
      <div className="p-4 sm:p-5 space-y-2">
        {/* Take Initial — always visible when user has positions in profit */}
        {publicKey && hasPositions && initialBack.tokensRaw > 0 && (
          <button onClick={() => { setBuy(false); doSwap(BigInt(initialBack.tokensRaw), false); }} disabled={pending}
            className="w-full py-3.5 mb-2 rounded-xl bg-gradient-to-r from-skye-500 to-skye-600 hover:from-skye-600 hover:to-skye-700 text-white font-semibold text-[13px] sm:text-[14px] shadow-soft transition-all active:scale-[0.98] disabled:opacity-50 min-h-[48px]">
            {pending ? "Confirming..." : `Take Initial Back (${initialBackSol.toFixed(4)} SOL · ${formatUsd(initialBackSol * solUsd, 2)})`}
          </button>
        )}

        {/* PAY row */}
        <div className="bg-white/5 rounded-xl p-4">
          <div className="flex justify-between items-center mb-2">
            <span className="text-[12px] text-ink-tertiary">You pay</span>
            {publicKey && (
              <div className="flex items-center gap-2 text-[12px]">
                <span className="text-ink-faint">{payToken.balanceLabel} {payToken.symbol}</span>
                {buy && solBalance !== null && (
                  <button onClick={() => setAmount((solBalance * 0.95).toFixed(4))} className="text-skye-400 font-semibold hover:underline text-[11px]">MAX</button>
                )}
                {!buy && maxSellableRaw > 0 && (
                  <button onClick={() => fillSellPct(1)} className="text-skye-400 font-semibold hover:underline text-[11px]">MAX</button>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            <input type="number" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)}
              className="flex-1 text-[24px] sm:text-[28px] font-bold bg-transparent outline-none tabular-nums min-w-0" />
            <button
              onClick={() => setShowSelector("pay")}
              className="flex items-center gap-2 bg-white/10 hover:bg-white/15 rounded-xl px-3 py-2 transition-colors flex-shrink-0"
            >
              <img src={payToken.logo} alt={payToken.symbol} className="w-6 h-6 rounded-full" />
              <span className="text-[14px] font-semibold text-ink-primary">{payToken.symbol}</span>
              <svg className="w-3 h-3 text-ink-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
          </div>
          {amountNum > 0 && buy && (
            <div className="text-[11px] text-ink-faint mt-1 tabular-nums">{formatUsd(amountNum * solUsd, 2)}</div>
          )}
        </div>

        {/* Flip button */}
        <div className="flex justify-center -my-1 relative z-10">
          <button onClick={handleFlip}
            className="w-9 h-9 rounded-full bg-[rgba(20,20,35,0.9)] border border-white/10 flex items-center justify-center hover:bg-white/10 transition-colors">
            <svg className="w-4 h-4 text-ink-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
            </svg>
          </button>
        </div>

        {/* RECEIVE row */}
        <div className="bg-white/5 rounded-xl p-4">
          <div className="flex justify-between items-center mb-2">
            <span className="text-[12px] text-ink-tertiary">You receive</span>
            {publicKey && (
              <span className="text-[12px] text-ink-faint">{receiveToken.balanceLabel} {receiveToken.symbol}</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1 text-[24px] sm:text-[28px] font-bold tabular-nums text-ink-secondary min-w-0">
              {amountNum > 0 ? (buy ? formatTokens(outputAmount, 2) : outputHuman.toFixed(6)) : "0.00"}
            </div>
            <button
              onClick={() => setShowSelector("receive")}
              className="flex items-center gap-2 bg-white/10 hover:bg-white/15 rounded-xl px-3 py-2 transition-colors flex-shrink-0"
            >
              <img src={receiveToken.logo} alt={receiveToken.symbol} className="w-6 h-6 rounded-full" />
              <span className="text-[14px] font-semibold text-ink-primary">{receiveToken.symbol}</span>
              <svg className="w-3 h-3 text-ink-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
          </div>
          {amountNum > 0 && !buy && (
            <div className="text-[11px] text-ink-faint mt-1 tabular-nums">{formatUsd(outputHuman * solUsd, 2)}</div>
          )}
        </div>

        {/* Sell % quick buttons */}
        {!buy && publicKey && maxSellableRaw > 0 && (
          <div className="flex gap-2 pt-1">
            {[{ l: "25%", p: 0.25 }, { l: "50%", p: 0.5 }, { l: "75%", p: 0.75 }].map(({ l, p }) => (
              <button key={l} onClick={() => fillSellPct(p)}
                className="flex-1 py-2 text-[11px] font-semibold rounded-lg border border-white/10 text-ink-tertiary hover:bg-white/5 transition-all">{l}</button>
            ))}
          </div>
        )}

        {/* Price info */}
        {amountNum > 0 && (
          <div className="space-y-1 pt-1">
            <div className="flex justify-between text-[12px]">
              <span className="text-ink-faint">Rate</span>
              <span className="text-ink-tertiary tabular-nums">
                1 {buy ? "SOL" : "SKYE"} = {buy
                  ? formatTokens(computeSwapOutput(pool.wsolAmount, pool.skyeAmount, LAMPORTS_PER_SOL, pool.feeBps), 0) + " SKYE"
                  : (computeSwapOutput(pool.skyeAmount, pool.wsolAmount, 10 ** DECIMALS, pool.feeBps) / LAMPORTS_PER_SOL).toFixed(9) + " SOL"
                }
              </span>
            </div>
            <div className="flex justify-between text-[12px]">
              <span className="text-ink-faint">Price impact</span>
              <span className={`font-medium ${priceImpactPct > 5 ? "text-rose-400" : priceImpactPct > 2 ? "text-amber-400" : "text-ink-tertiary"}`}>
                {priceImpactPct.toFixed(2)}%
              </span>
            </div>
          </div>
        )}

        {priceImpactPct > 5 && (
          <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl px-3 py-2 text-[12px] text-rose-400 font-medium">
            High price impact ({priceImpactPct.toFixed(1)}%). Consider a smaller trade.
          </div>
        )}

        {/* Submit */}
        {publicKey ? (
          <button onClick={handleSubmit} disabled={pending || amountNum <= 0}
            className={`w-full py-4 rounded-xl text-[14px] sm:text-[15px] font-semibold text-white transition-all active:scale-[0.98] min-h-[52px] ${
              pending ? "bg-white/10 cursor-wait" : "bg-skye-500/90 hover:bg-skye-500"
            } disabled:opacity-40`}>
            {pending ? "Confirming..." : amountNum > 0
              ? `Swap ${amount} ${payToken.symbol} for ${buy ? formatTokens(outputAmount, 0) : outputHuman.toFixed(4)} ${receiveToken.symbol}`
              : "Enter an amount"}
          </button>
        ) : (
          <div className="text-center text-[13px] sm:text-[14px] text-ink-faint py-3">Connect wallet to trade</div>
        )}

        {lastTx && (
          <p className="text-center text-[12px] sm:text-[13px] text-emerald-400">
            Confirmed &middot; <a href={`https://solscan.io/tx/${lastTx}`} target="_blank" rel="noopener noreferrer" className="underline">View on Solscan</a>
          </p>
        )}
        {error && <p className="text-center text-[11px] sm:text-[12px] text-rose-400 break-all">{error}</p>}
      </div>

      {/* Token Selector Modal */}
      {showSelector && (
        <TokenSelector
          allTokens={allTokens}
          solBalance={solBalance}
          solUsd={solUsd}
          onSelect={(symbol) => {
            if (showSelector === "pay") {
              setBuy(symbol === "SOL");
            } else {
              setBuy(symbol === "SKYE");
            }
            setAmount("");
            setShowSelector(null);
          }}
          onClose={() => setShowSelector(null)}
          side={showSelector}
        />
      )}
    </div>
  );
}

function TokenSelector({ allTokens, solBalance, solUsd, onSelect, onClose, side }: {
  allTokens: TokenBalance[];
  solBalance: number | null;
  solUsd: number;
  onSelect: (symbol: string) => void;
  onClose: () => void;
  side: "pay" | "receive";
}) {
  const [search, setSearch] = useState("");
  const [showDust, setShowDust] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  const solUsdVal = (solBalance ?? 0) * solUsd;

  const dustCount = allTokens.filter(t => (t.usdValue ?? 0) < 10 && t.symbol !== "SKYE").length;

  // Filter: hide < $10 unless dust toggle is on, apply search
  const filtered = allTokens
    .filter(t => showDust || (t.usdValue ?? 0) >= 10)
    .filter(t => {
      if (!search) return true;
      const q = search.toLowerCase();
      return t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.mint.toLowerCase().includes(q);
    });

  return (
    <div className="absolute inset-0 z-50 bg-[rgba(5,5,15,0.95)] backdrop-blur-sm flex flex-col" ref={ref}>
      <div className="p-4 border-b border-white/5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[14px] font-bold text-ink-primary">Select {side === "pay" ? "pay" : "receive"} token</h3>
          <button onClick={onClose} className="text-ink-faint hover:text-ink-primary text-[18px]">&times;</button>
        </div>
        <input
          ref={inputRef}
          type="text"
          placeholder="Search by name or address..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full bg-white/5 rounded-xl px-3 py-2.5 text-[13px] outline-none placeholder:text-ink-faint border border-white/5 focus:border-skye-500/30"
        />
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {/* SOL always first */}
        {(!search || "sol solana".includes(search.toLowerCase())) && (
          <button onClick={() => onSelect("SOL")}
            className="w-full flex items-center justify-between px-3 py-3 rounded-xl hover:bg-white/5 transition-colors">
            <div className="flex items-center gap-3">
              <img src={SOL_LOGO} alt="SOL" className="w-8 h-8 rounded-full" />
              <div className="text-left">
                <div className="text-[13px] font-semibold text-ink-primary">SOL</div>
                <div className="text-[11px] text-ink-faint">Solana</div>
              </div>
            </div>
            <div className="text-right tabular-nums">
              <div className="text-[13px] font-semibold text-ink-primary">{solBalance?.toFixed(4) ?? "0"}</div>
              {solUsdVal > 0 && <div className="text-[11px] text-ink-faint">${solUsdVal.toFixed(2)}</div>}
            </div>
          </button>
        )}

        {/* SKYE */}
        {(!search || "skye".includes(search.toLowerCase())) && (
          <button onClick={() => onSelect("SKYE")}
            className="w-full flex items-center justify-between px-3 py-3 rounded-xl hover:bg-white/5 transition-colors">
            <div className="flex items-center gap-3">
              <img src={SKYE_LOGO} alt="SKYE" className="w-8 h-8 rounded-full" />
              <div className="text-left">
                <div className="text-[13px] font-semibold text-ink-primary">SKYE</div>
                <div className="text-[11px] text-ink-faint">Skye</div>
              </div>
            </div>
            <div className="text-right tabular-nums">
              <div className="text-[13px] font-semibold text-ink-primary">
                {filtered.find(t => t.symbol === "SKYE")?.uiAmount ?? "0"}
              </div>
              {(() => {
                const skye = filtered.find(t => t.symbol === "SKYE");
                return skye?.usdValue ? <div className="text-[11px] text-ink-faint">${skye.usdValue.toFixed(2)}</div> : null;
              })()}
            </div>
          </button>
        )}

        {/* Divider */}
        <div className="border-t border-white/5 my-1" />

        {/* Other wallet tokens */}
        {filtered.filter(t => t.symbol !== "SKYE").map(token => (
          <div key={token.mint}
            className="flex items-center justify-between px-3 py-3 rounded-xl opacity-50">
            <div className="flex items-center gap-3">
              {token.logo ? (
                <img src={token.logo} alt={token.symbol} className="w-8 h-8 rounded-full" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-[10px] font-bold text-ink-tertiary">
                  {token.symbol.slice(0, 2)}
                </div>
              )}
              <div className="text-left">
                <div className="text-[13px] font-semibold text-ink-primary">{token.symbol}</div>
                <div className="text-[11px] text-ink-faint">{token.name}</div>
              </div>
            </div>
            <div className="text-right tabular-nums">
              <div className="text-[13px] font-semibold text-ink-primary">{token.uiAmount}</div>
              {token.usdValue !== undefined && <div className="text-[11px] text-ink-faint">${token.usdValue.toFixed(2)}</div>}
            </div>
          </div>
        ))}

        {filtered.length === 0 && !search && (
          <div className="text-center text-[13px] text-ink-faint py-8">No tokens found</div>
        )}
      </div>

      {/* Dust toggle */}
      {dustCount > 0 && (
        <div className="p-3 border-t border-white/5">
          <button
            onClick={() => setShowDust(!showDust)}
            className="w-full flex items-center justify-center gap-2 py-2 text-[12px] text-ink-faint hover:text-ink-tertiary transition-colors"
          >
            <div className={`w-3.5 h-3.5 rounded border transition-colors flex items-center justify-center ${showDust ? "bg-skye-500 border-skye-500" : "border-white/20"}`}>
              {showDust && <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
            </div>
            Show dust ({dustCount} tokens &lt;$10)
          </button>
        </div>
      )}
    </div>
  );
}
