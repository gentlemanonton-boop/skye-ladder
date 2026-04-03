import { useState } from "react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { usePool } from "../hooks/usePool";
import { useSwap } from "../hooks/useSwap";
import { useWalletRecord } from "../hooks/useWalletRecord";
import { computeSwapOutput, formatTokens, rawToHuman, formatUsd } from "../lib/format";
import { getTotalSellable, getInitialBackTokens } from "../lib/unlock";
import { DECIMALS } from "../constants";

interface Props { currentPrice: number; solUsd: number; }

export function SwapPanel({ currentPrice, solUsd }: Props) {
  const { publicKey } = useWallet();
  const { pool } = usePool();
  const { swap, pending, lastTx, error } = useSwap();
  const { positions } = useWalletRecord();
  const [buy, setBuy] = useState(true);
  const [amount, setAmount] = useState("");

  if (!pool) return null;

  const amountNum = parseFloat(amount) || 0;
  const maxSellableRaw = getTotalSellable(positions, currentPrice);
  const maxSellableHuman = rawToHuman(maxSellableRaw);
  const totalHeld = positions.reduce((s, p) => s + p.tokenBalance, 0);

  const initialBack = getInitialBackTokens(positions, currentPrice);
  const initialBackHuman = rawToHuman(initialBack.tokensRaw);
  const initialBackSolLamports = initialBack.tokensRaw > 0
    ? computeSwapOutput(pool.skyeAmount, pool.wsolAmount, initialBack.tokensRaw, pool.feeBps) : 0;
  const initialBackSol = initialBackSolLamports / LAMPORTS_PER_SOL;

  let outputLabel = "";
  if (amountNum > 0) {
    if (buy) {
      const out = computeSwapOutput(pool.wsolAmount, pool.skyeAmount, amountNum * LAMPORTS_PER_SOL, pool.feeBps);
      outputLabel = `~${formatTokens(out, 0)} SKYE`;
    } else {
      const outL = computeSwapOutput(pool.skyeAmount, pool.wsolAmount, amountNum * 10 ** DECIMALS, pool.feeBps);
      const outSol = outL / LAMPORTS_PER_SOL;
      outputLabel = `~${outSol.toFixed(6)} SOL (${formatUsd(outSol * solUsd, 2)})`;
    }
  }

  function fillSellPct(pct: number) {
    setAmount((Math.floor(maxSellableHuman * pct * 10000) / 10000).toString());
  }

  async function doSwap(raw: bigint, isBuy: boolean) {
    if (!publicKey || raw <= 0n) return;
    await swap(raw, isBuy);
    setAmount("");
  }

  async function handleSubmit() {
    if (amountNum <= 0) return;
    await doSwap(buy ? BigInt(Math.floor(amountNum * LAMPORTS_PER_SOL)) : BigInt(Math.floor(amountNum * 10 ** DECIMALS)), buy);
  }

  const hasPositions = positions.length > 0 && totalHeld > 0;
  const sellEstSol = amountNum > 0 && !buy
    ? computeSwapOutput(pool.skyeAmount, pool.wsolAmount, amountNum * 10 ** DECIMALS, pool.feeBps) / LAMPORTS_PER_SOL : 0;

  return (
    <div className="bg-surface-card rounded-2xl shadow-card border border-gray-200/80 overflow-hidden">
      {/* Toggle */}
      <div className="flex bg-surface-muted p-1 m-4 sm:m-5 mb-0 rounded-xl">
        <button onClick={() => { setBuy(true); setAmount(""); }}
          className={`flex-1 py-3 text-[14px] font-semibold rounded-lg transition-all min-h-[44px] ${buy ? "bg-white text-ink-primary shadow-sm" : "text-ink-tertiary"}`}>Buy</button>
        <button onClick={() => { setBuy(false); setAmount(""); }}
          className={`flex-1 py-3 text-[14px] font-semibold rounded-lg transition-all min-h-[44px] ${!buy ? "bg-white text-ink-primary shadow-sm" : "text-ink-tertiary"}`}>Sell</button>
      </div>

      <div className="p-4 sm:p-5 pt-3 sm:pt-4 space-y-4">
        {/* Take Initial */}
        {!buy && publicKey && hasPositions && initialBack.tokensRaw > 0 && (
          <button onClick={() => doSwap(BigInt(initialBack.tokensRaw), false)} disabled={pending}
            className="w-full py-4 rounded-xl bg-gradient-to-r from-skye-500 to-skye-600 hover:from-skye-600 hover:to-skye-700 text-white font-semibold text-[14px] sm:text-[15px] shadow-soft transition-all active:scale-[0.98] disabled:opacity-50 min-h-[52px]">
            {pending ? "Confirming..." : `Take Initial Back (${initialBackSol.toFixed(4)} SOL · ${formatUsd(initialBackSol * solUsd, 2)})`}
          </button>
        )}

        {/* Sell stats */}
        {!buy && publicKey && hasPositions && (
          <div className="flex justify-between text-[12px] sm:text-[13px] text-ink-secondary px-1">
            <span>Held: <span className="font-semibold text-ink-primary">{formatTokens(totalHeld, 0)}</span></span>
            <span>Available: <span className="font-semibold text-skye-600">{formatTokens(maxSellableRaw, 0)}</span></span>
          </div>
        )}

        {/* Sell % buttons */}
        {!buy && publicKey && maxSellableRaw > 0 && (
          <div className="flex gap-2">
            {[{ l: "25%", p: 0.25 }, { l: "50%", p: 0.5 }, { l: "75%", p: 0.75 }, { l: "Max", p: 1.0 }].map(({ l, p }) => (
              <button key={l} onClick={() => fillSellPct(p)}
                className={`flex-1 py-2.5 text-[12px] font-semibold rounded-lg border transition-all min-h-[44px] ${
                  l === "Max" ? "border-skye-300 bg-skye-50 text-skye-600 hover:bg-skye-100" : "border-gray-200 text-ink-secondary hover:bg-gray-50"
                }`}>{l}</button>
            ))}
          </div>
        )}

        {/* Input */}
        <div>
          <label className="text-[12px] sm:text-[13px] font-medium text-ink-secondary mb-1 block">
            {buy ? "You pay (SOL)" : "You sell (SKYE)"}
          </label>
          <div className="flex items-baseline gap-2">
            <input type="number" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)}
              className="flex-1 text-[24px] sm:text-[28px] font-bold text-ink-primary bg-transparent outline-none placeholder:text-ink-faint tabular-nums min-w-0" />
            <div className="flex flex-col items-end flex-shrink-0">
              <span className="text-[13px] sm:text-[14px] font-semibold text-ink-tertiary">{buy ? "SOL" : "SKYE"}</span>
              {buy && amountNum > 0 && (
                <span className="text-[11px] text-ink-tertiary tabular-nums">({formatUsd(amountNum * solUsd, 2)})</span>
              )}
            </div>
          </div>
          {amountNum > 0 && <p className="text-[12px] sm:text-[13px] text-ink-tertiary mt-1">You receive {outputLabel}</p>}
        </div>

        {/* Submit */}
        {publicKey ? (
          <button onClick={handleSubmit} disabled={pending || amountNum <= 0}
            className={`w-full py-3.5 rounded-xl text-[14px] sm:text-[15px] font-semibold text-white transition-all active:scale-[0.98] min-h-[48px] ${
              pending ? "bg-gray-300 cursor-wait" : buy ? "bg-skye-500 hover:bg-skye-600" : "bg-rose-500 hover:bg-rose-600"
            } disabled:opacity-40`}>
            {pending ? "Confirming..." : buy ? "Buy SKYE" : amountNum > 0
              ? `Sell for ~${sellEstSol.toFixed(4)} SOL (${formatUsd(sellEstSol * solUsd, 2)})` : "Sell SKYE"}
          </button>
        ) : (
          <div className="text-center text-[13px] sm:text-[14px] text-ink-tertiary py-3">Connect wallet to trade</div>
        )}

        {lastTx && (
          <p className="text-center text-[12px] sm:text-[13px] text-emerald-600">
            Confirmed &middot; <a href={`https://solscan.io/tx/${lastTx}`} target="_blank" rel="noopener noreferrer" className="underline">Solscan</a>
          </p>
        )}
        {error && <p className="text-center text-[11px] sm:text-[12px] text-rose-500 break-all">{error}</p>}
      </div>
    </div>
  );
}
