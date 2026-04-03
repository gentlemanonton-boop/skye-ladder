import { useState } from "react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { usePool } from "../hooks/usePool";
import { useSwap } from "../hooks/useSwap";
import { useWalletRecord } from "../hooks/useWalletRecord";
import {
  computeSwapOutput,
  formatTokens,
  formatSol,
  rawToHuman,
  formatUsd,
} from "../lib/format";
import { getTotalSellable, getInitialBackTokens, enrichPosition } from "../lib/unlock";
import { DECIMALS } from "../constants";

interface Props {
  currentPrice: number;
  solUsd: number;
}

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

  // Initial-back calculation
  const initialBack = getInitialBackTokens(positions, currentPrice);
  const initialBackHuman = rawToHuman(initialBack.tokensRaw);
  // Estimate SOL received for selling that many tokens
  const initialBackSol = initialBack.tokensRaw > 0
    ? computeSwapOutput(pool.skyeAmount, pool.wsolAmount, initialBack.tokensRaw, pool.feeBps)
    : 0;
  const initialBackUsd = (initialBackSol / LAMPORTS_PER_SOL) * solUsd;

  // Output estimate
  let outputLabel = "";
  if (amountNum > 0) {
    if (buy) {
      const out = computeSwapOutput(pool.wsolAmount, pool.skyeAmount, amountNum * LAMPORTS_PER_SOL, pool.feeBps);
      outputLabel = `~${formatTokens(out, 0)} SKYE`;
    } else {
      const outLamports = computeSwapOutput(pool.skyeAmount, pool.wsolAmount, amountNum * 10 ** DECIMALS, pool.feeBps);
      const outSol = outLamports / LAMPORTS_PER_SOL;
      outputLabel = `~${outSol.toFixed(6)} SOL (${formatUsd(outSol * solUsd, 2)})`;
    }
  }

  function fillSellPct(pct: number) {
    setAmount((Math.floor(maxSellableHuman * pct * 10000) / 10000).toString());
  }

  async function doSwap(rawAmount: bigint, isBuy: boolean) {
    if (!publicKey || rawAmount <= 0n) return;
    await swap(rawAmount, isBuy);
    setAmount("");
  }

  async function handleSubmit() {
    if (amountNum <= 0) return;
    if (buy) {
      await doSwap(BigInt(Math.floor(amountNum * LAMPORTS_PER_SOL)), true);
    } else {
      await doSwap(BigInt(Math.floor(amountNum * 10 ** DECIMALS)), false);
    }
  }

  async function handleTakeInitial() {
    if (initialBack.tokensRaw <= 0) return;
    await doSwap(BigInt(initialBack.tokensRaw), false);
  }

  const hasPositions = positions.length > 0 && totalHeld > 0;

  return (
    <div className="bg-surface-card rounded-2xl shadow-card border border-gray-200/80 overflow-hidden">
      {/* Buy/Sell toggle */}
      <div className="flex bg-surface-muted p-1 m-5 mb-0 rounded-xl">
        <button
          onClick={() => { setBuy(true); setAmount(""); }}
          className={`flex-1 py-2.5 text-[14px] font-semibold rounded-lg transition-all ${
            buy ? "bg-white text-ink-primary shadow-sm" : "text-ink-tertiary"
          }`}
        >Buy</button>
        <button
          onClick={() => { setBuy(false); setAmount(""); }}
          className={`flex-1 py-2.5 text-[14px] font-semibold rounded-lg transition-all ${
            !buy ? "bg-white text-ink-primary shadow-sm" : "text-ink-tertiary"
          }`}
        >Sell</button>
      </div>

      <div className="p-5 pt-4 space-y-4">
        {/* ── SELL: Take Initial Back hero button ── */}
        {!buy && publicKey && hasPositions && initialBack.tokensRaw > 0 && (
          <button
            onClick={handleTakeInitial}
            disabled={pending}
            className="w-full py-4 rounded-xl bg-gradient-to-r from-skye-500 to-skye-600 hover:from-skye-600 hover:to-skye-700 text-white font-semibold text-[15px] shadow-soft transition-all active:scale-[0.98] disabled:opacity-50"
          >
            {pending ? "Confirming..." : `Take Initial Back (${formatUsd(initialBackUsd, 2)} · ${formatTokens(initialBack.tokensRaw, 0)} SKYE)`}
          </button>
        )}

        {/* ── SELL: stats row ── */}
        {!buy && publicKey && hasPositions && (
          <div className="flex justify-between text-[13px] text-ink-secondary px-1">
            <span>Held: <span className="font-semibold text-ink-primary">{formatTokens(totalHeld, 0)}</span></span>
            <span>Available: <span className="font-semibold text-skye-600">{formatTokens(maxSellableRaw, 0)}</span></span>
          </div>
        )}

        {/* ── SELL: quick buttons ── */}
        {!buy && publicKey && maxSellableRaw > 0 && (
          <div className="flex gap-2">
            {[
              { label: "25%", pct: 0.25 },
              { label: "50%", pct: 0.5 },
              { label: "75%", pct: 0.75 },
              { label: "Max", pct: 1.0 },
            ].map(({ label, pct }) => (
              <button
                key={label}
                onClick={() => fillSellPct(pct)}
                className={`flex-1 py-2 text-[12px] font-semibold rounded-lg border transition-all ${
                  label === "Max"
                    ? "border-skye-300 bg-skye-50 text-skye-600 hover:bg-skye-100"
                    : "border-gray-200 text-ink-secondary hover:bg-gray-50 hover:border-gray-300"
                }`}
              >{label}</button>
            ))}
          </div>
        )}

        {/* ── Input ── */}
        <div>
          <label className="text-[13px] font-medium text-ink-secondary mb-1 block">
            {buy ? "You pay (SOL)" : "You sell (SKYE)"}
          </label>
          <div className="flex items-baseline gap-2">
            <input
              type="number"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="flex-1 text-[28px] font-bold text-ink-primary bg-transparent outline-none placeholder:text-ink-faint tabular-nums"
            />
            <span className="text-[14px] font-semibold text-ink-tertiary">{buy ? "SOL" : "SKYE"}</span>
          </div>
          {amountNum > 0 && (
            <p className="text-[13px] text-ink-tertiary mt-1">You receive {outputLabel}</p>
          )}
        </div>

        {/* ── Submit ── */}
        {publicKey ? (
          <button
            onClick={handleSubmit}
            disabled={pending || amountNum <= 0}
            className={`w-full py-3.5 rounded-xl text-[15px] font-semibold text-white transition-all active:scale-[0.98] ${
              pending ? "bg-gray-300 cursor-wait"
                : buy ? "bg-skye-500 hover:bg-skye-600" : "bg-rose-500 hover:bg-rose-600"
            } disabled:opacity-40`}
          >
            {pending ? "Confirming..." : buy ? "Buy SKYE" : amountNum > 0
              ? `Sell for ~${formatUsd(computeSwapOutput(pool.skyeAmount, pool.wsolAmount, amountNum * 10 ** DECIMALS, pool.feeBps) / LAMPORTS_PER_SOL * solUsd, 2)}`
              : "Sell SKYE"}
          </button>
        ) : (
          <div className="text-center text-[14px] text-ink-tertiary py-3">Connect wallet to trade</div>
        )}

        {/* Status */}
        {lastTx && (
          <p className="text-center text-[13px] text-emerald-600">
            Confirmed &middot;{" "}
            <a href={`https://solscan.io/tx/${lastTx}`} target="_blank" rel="noopener noreferrer" className="underline">
              View on Solscan
            </a>
          </p>
        )}
        {error && <p className="text-center text-[12px] text-rose-500 break-all">{error}</p>}
      </div>
    </div>
  );
}
