import { useState } from "react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { usePool } from "../hooks/usePool";
import { useSwap } from "../hooks/useSwap";
import { useWalletRecord } from "../hooks/useWalletRecord";
import { useBalances } from "../hooks/useBalances";
import { computeSwapOutput, formatTokens, rawToHuman, formatUsd } from "../lib/format";
import { getTotalSellable, getInitialBackTokens } from "../lib/unlock";
import { DECIMALS } from "../constants";

interface Props { currentPrice: number; solUsd: number; }

export function SwapPanel({ currentPrice, solUsd }: Props) {
  const { publicKey } = useWallet();
  const { pool } = usePool();
  const { swap, pending, lastTx, error } = useSwap();
  const { positions } = useWalletRecord();
  const { solBalance, skyeBalance } = useBalances();
  const [buy, setBuy] = useState(true);
  const [amount, setAmount] = useState("");

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
  let outputLabel = "";
  let priceImpactPct = 0;

  if (amountNum > 0) {
    if (buy) {
      const lamportsIn = amountNum * LAMPORTS_PER_SOL;
      outputAmount = computeSwapOutput(pool.wsolAmount, pool.skyeAmount, lamportsIn, pool.feeBps);
      outputLabel = `${formatTokens(outputAmount, 0)} SKYE`;
      // Price impact: compare effective price vs spot price
      const spotPrice = pool.wsolAmount / pool.skyeAmount;
      const effectivePrice = lamportsIn / outputAmount;
      priceImpactPct = ((effectivePrice - spotPrice) / spotPrice) * 100;
    } else {
      const rawIn = amountNum * 10 ** DECIMALS;
      outputAmount = computeSwapOutput(pool.skyeAmount, pool.wsolAmount, rawIn, pool.feeBps);
      const outSol = outputAmount / LAMPORTS_PER_SOL;
      outputLabel = `${outSol.toFixed(6)} SOL (${formatUsd(outSol * solUsd, 2)})`;
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
    // 5% slippage tolerance
    const minOut = BigInt(Math.floor(outputAmount * 0.95));
    await doSwap(buy ? BigInt(Math.floor(amountNum * LAMPORTS_PER_SOL)) : BigInt(Math.floor(amountNum * 10 ** DECIMALS)), buy, minOut);
  }

  const hasPositions = positions.length > 0 && totalHeld > 0;
  const sellEstSol = amountNum > 0 && !buy
    ? computeSwapOutput(pool.skyeAmount, pool.wsolAmount, amountNum * 10 ** DECIMALS, pool.feeBps) / LAMPORTS_PER_SOL : 0;

  return (
    <div className="glass overflow-hidden">
      {/* Toggle */}
      <div className="flex bg-white/5 p-1 m-4 sm:m-5 mb-0 rounded-xl">
        <button onClick={() => { setBuy(true); setAmount(""); }}
          className={`flex-1 py-3 text-[14px] font-semibold rounded-lg transition-all min-h-[44px] ${buy ? "bg-white/10 text-ink-primary" : "text-ink-faint hover:text-ink-tertiary"}`}>Buy</button>
        <button onClick={() => { setBuy(false); setAmount(""); }}
          className={`flex-1 py-3 text-[14px] font-semibold rounded-lg transition-all min-h-[44px] ${!buy ? "bg-white/10 text-ink-primary" : "text-ink-faint hover:text-ink-tertiary"}`}>Sell</button>
      </div>

      <div className="p-4 sm:p-5 pt-3 sm:pt-4 space-y-4">
        {/* Take Initial — always visible when user has positions in profit */}
        {publicKey && hasPositions && initialBack.tokensRaw > 0 && (
          <button onClick={() => { setBuy(false); doSwap(BigInt(initialBack.tokensRaw), false); }} disabled={pending}
            className="w-full py-4 rounded-xl bg-gradient-to-r from-skye-500 to-skye-600 hover:from-skye-600 hover:to-skye-700 text-white font-semibold text-[14px] sm:text-[15px] shadow-soft transition-all active:scale-[0.98] disabled:opacity-50 min-h-[52px]">
            {pending ? "Confirming..." : `Take Initial Back (${initialBackSol.toFixed(4)} SOL · ${formatUsd(initialBackSol * solUsd, 2)})`}
          </button>
        )}

        {/* Balance + stats row */}
        {publicKey && (
          <div className="flex justify-between text-[12px] sm:text-[13px] text-ink-tertiary px-1">
            {buy ? (
              <>
                <span>Balance: <span className="font-semibold text-ink-secondary">{solBalance !== null ? solBalance.toFixed(4) : "..."} SOL</span></span>
                {solBalance !== null && <button onClick={() => setAmount((solBalance * 0.95).toFixed(4))} className="text-skye-400 font-semibold hover:underline">Max</button>}
              </>
            ) : (
              <>
                <span>SKYE: <span className="font-semibold text-ink-secondary">{skyeBalance !== null ? skyeBalance.toLocaleString(undefined, {maximumFractionDigits: 0}) : "..."}</span></span>
                {maxSellableRaw > 0 && <span>Available: <span className="font-semibold text-skye-400">{formatTokens(maxSellableRaw, 0)}</span></span>}
              </>
            )}
          </div>
        )}

        {/* Sell % buttons */}
        {!buy && publicKey && maxSellableRaw > 0 && (
          <div className="flex gap-2">
            {[{ l: "25%", p: 0.25 }, { l: "50%", p: 0.5 }, { l: "75%", p: 0.75 }, { l: "Max", p: 1.0 }].map(({ l, p }) => (
              <button key={l} onClick={() => fillSellPct(p)}
                className={`flex-1 py-2.5 text-[12px] font-semibold rounded-lg border transition-all min-h-[44px] ${
                  l === "Max" ? "border-skye-500/30 bg-skye-500/10 text-skye-400 hover:bg-skye-500/20" : "border-white/10 text-ink-tertiary hover:bg-white/5"
                }`}>{l}</button>
            ))}
          </div>
        )}

        {/* Input */}
        <div>
          <label className="text-[12px] sm:text-[13px] font-medium text-ink-tertiary mb-1 block">
            {buy ? "You pay" : "You sell"}
          </label>
          <div className="flex items-baseline gap-2">
            <input type="number" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)}
              className="flex-1 text-[24px] sm:text-[28px] font-bold bg-transparent outline-none tabular-nums min-w-0" />
            <div className="flex flex-col items-end flex-shrink-0">
              <span className="text-[13px] sm:text-[14px] font-semibold text-ink-tertiary">{buy ? "SOL" : "SKYE"}</span>
              {buy && amountNum > 0 && (
                <span className="text-[11px] text-ink-faint tabular-nums">({formatUsd(amountNum * solUsd, 2)})</span>
              )}
            </div>
          </div>
        </div>

        {/* Output preview / confirmation */}
        {amountNum > 0 && (
          <div className="bg-white/5 rounded-xl p-3 space-y-1.5">
            <div className="flex justify-between text-[13px]">
              <span className="text-ink-tertiary">You receive</span>
              <span className="font-semibold text-ink-primary">{outputLabel}</span>
            </div>
            <div className="flex justify-between text-[12px]">
              <span className="text-ink-faint">Price impact</span>
              <span className={`font-medium ${priceImpactPct > 5 ? "text-rose-400" : priceImpactPct > 2 ? "text-amber-400" : "text-ink-tertiary"}`}>
                {priceImpactPct.toFixed(2)}%
              </span>
            </div>
          </div>
        )}

        {/* Price impact warning */}
        {priceImpactPct > 5 && (
          <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl px-3 py-2 text-[12px] text-rose-400 font-medium">
            High price impact ({priceImpactPct.toFixed(1)}%). Consider a smaller trade.
          </div>
        )}

        {/* Submit */}
        {publicKey ? (
          <button onClick={handleSubmit} disabled={pending || amountNum <= 0}
            className={`w-full py-4 rounded-xl text-[14px] sm:text-[15px] font-semibold text-white transition-all active:scale-[0.98] min-h-[52px] ${
              pending ? "bg-white/10 cursor-wait" : buy ? "bg-skye-500/90 hover:bg-skye-500" : "bg-rose-500/90 hover:bg-rose-500"
            } disabled:opacity-40`}>
            {pending ? "Confirming..." : buy
              ? `Buy ${amountNum > 0 ? formatTokens(outputAmount, 0) + " SKYE" : "SKYE"}`
              : amountNum > 0 ? `Sell for ${sellEstSol.toFixed(4)} SOL (${formatUsd(sellEstSol * solUsd, 2)})` : "Sell SKYE"}
          </button>
        ) : (
          <div className="text-center text-[13px] sm:text-[14px] text-ink-faint py-3">Connect wallet to trade</div>
        )}

        {/* Status */}
        {lastTx && (
          <p className="text-center text-[12px] sm:text-[13px] text-emerald-400">
            Confirmed &middot; <a href={`https://solscan.io/tx/${lastTx}`} target="_blank" rel="noopener noreferrer" className="underline">View on Solscan</a>
          </p>
        )}
        {error && <p className="text-center text-[11px] sm:text-[12px] text-rose-400 break-all">{error}</p>}
      </div>
    </div>
  );
}
