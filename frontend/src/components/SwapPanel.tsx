import { useState, useRef, useEffect, useCallback } from "react";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useSwap } from "../hooks/useSwap";
import { useBalances, type TokenBalance } from "../hooks/useBalances";
import { computeSwapOutput, formatTokens, rawToHuman, formatUsd } from "../lib/format";
import { getTotalSellable, getInitialBackTokens } from "../lib/unlock";
import { SKYE_MINT, DECIMALS } from "../constants";
import { getJupiterQuote, executeJupiterSwap, type JupiterQuote } from "../lib/jupiter";
import type { PoolState } from "../hooks/usePool";
import type { Position } from "../lib/unlock";

const SKYE_LOGO = "/logo.jpeg";
const SOL_LOGO = "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png";
const USDC_LOGO = "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png";
const USDT_LOGO = "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.png";

interface SelectedToken {
  mint: string;
  symbol: string;
  name: string;
  logo: string;
  decimals: number;
}

const SOL_TOKEN: SelectedToken = { mint: NATIVE_MINT.toBase58(), symbol: "SOL", name: "Solana", logo: SOL_LOGO, decimals: 9 };
const SKYE_TOKEN: SelectedToken = { mint: SKYE_MINT.toBase58(), symbol: "SKYE", name: "Skye", logo: SKYE_LOGO, decimals: DECIMALS };
const USDC_TOKEN: SelectedToken = { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", name: "USD Coin", logo: USDC_LOGO, decimals: 6 };
const USDT_TOKEN: SelectedToken = { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", symbol: "USDT", name: "Tether", logo: USDT_LOGO, decimals: 6 };

const COMMON_TOKENS = [SOL_TOKEN, SKYE_TOKEN, USDC_TOKEN, USDT_TOKEN];

type SwapRoute = "curve_buy" | "curve_sell" | "jup_then_curve" | "curve_then_jup" | "jupiter";

function getRoute(payMint: string, receiveMint: string): SwapRoute {
  const skye = SKYE_MINT.toBase58();
  const sol = NATIVE_MINT.toBase58();
  if (payMint === sol && receiveMint === skye) return "curve_buy";
  if (payMint === skye && receiveMint === sol) return "curve_sell";
  if (receiveMint === skye) return "jup_then_curve";
  if (payMint === skye) return "curve_then_jup";
  return "jupiter";
}

interface Props {
  currentPrice: number;
  solUsd: number;
  pool: PoolState | null;
  positions: Position[];
  solBalance: number | null;
  skyeBalance: number | null;
}

export function SwapPanel({ currentPrice, solUsd, pool, positions, solBalance, skyeBalance }: Props) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, signTransaction } = useWallet();
  const { swap, pending: curvePending, lastTx: curveLastTx, error: curveError } = useSwap();
  const { allTokens } = useBalances();

  const [payToken, setPayToken] = useState<SelectedToken>(SOL_TOKEN);
  const [receiveToken, setReceiveToken] = useState<SelectedToken>(SKYE_TOKEN);
  const [amount, setAmount] = useState("");
  const [showSelector, setShowSelector] = useState<"pay" | "receive" | null>(null);

  // Jupiter quote state
  const [jupQuote, setJupQuote] = useState<JupiterQuote | null>(null);
  const [quoteDecimals, setQuoteDecimals] = useState(9); // verified decimals for current quote
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [jupPending, setJupPending] = useState(false);
  const [jupError, setJupError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [routeLabel, setRouteLabel] = useState("");

  const amountNum = parseFloat(amount) || 0;
  const route = getRoute(payToken.mint, receiveToken.mint);

  // Curve-specific calculations
  const isCurveBuy = route === "curve_buy";
  const isCurveSell = route === "curve_sell";
  const maxSellableRaw = getTotalSellable(positions, currentPrice);
  const maxSellableHuman = rawToHuman(maxSellableRaw);
  const totalHeld = positions.reduce((s, p) => s + p.tokenBalance, 0);
  const hasPositions = positions.length > 0 && totalHeld > 0;

  const initialBack = getInitialBackTokens(positions, currentPrice);
  const initialBackSolLamports = initialBack.tokensRaw > 0 && pool
    ? computeSwapOutput(pool.skyeAmount, pool.wsolAmount, initialBack.tokensRaw, pool.feeBps) : 0;
  const initialBackSol = initialBackSolLamports / LAMPORTS_PER_SOL;

  // Output calculation
  let outputRaw = 0;
  let outputHuman = 0;
  let priceImpactPct = 0;

  if (amountNum > 0 && pool) {
    if (isCurveBuy) {
      const lamportsIn = amountNum * LAMPORTS_PER_SOL;
      outputRaw = computeSwapOutput(pool.wsolAmount, pool.skyeAmount, lamportsIn, pool.feeBps);
      outputHuman = outputRaw / 10 ** DECIMALS;
      const spotPrice = pool.wsolAmount / pool.skyeAmount;
      const effectivePrice = lamportsIn / outputRaw;
      priceImpactPct = ((effectivePrice - spotPrice) / spotPrice) * 100;
    } else if (isCurveSell) {
      const rawIn = amountNum * 10 ** DECIMALS;
      outputRaw = computeSwapOutput(pool.skyeAmount, pool.wsolAmount, rawIn, pool.feeBps);
      outputHuman = outputRaw / LAMPORTS_PER_SOL;
      const spotPrice = pool.skyeAmount / pool.wsolAmount;
      const effectivePrice = rawIn / outputRaw;
      priceImpactPct = ((effectivePrice - spotPrice) / spotPrice) * 100;
    } else if (jupQuote) {
      outputRaw = parseInt(jupQuote.outAmount);
      outputHuman = outputRaw / 10 ** quoteDecimals;
      priceImpactPct = parseFloat(jupQuote.priceImpactPct) * 100;
    }
  }

  // Fetch Jupiter quotes when needed (debounced)
  useEffect(() => {
    if (amountNum <= 0 || isCurveBuy || isCurveSell || !pool) {
      setJupQuote(null);
      setRouteLabel("");
      if (isCurveBuy) setQuoteDecimals(DECIMALS);
      if (isCurveSell) setQuoteDecimals(9); // SOL
      return;
    }

    setQuoteLoading(true);
    const timer = setTimeout(async () => {
      try {
        // Verify receive token decimals from on-chain
        let verifiedDec = receiveToken.decimals;
        if (!COMMON_TOKENS.find(t => t.mint === receiveToken.mint)) {
          try {
            const info = await connection.getAccountInfo(new PublicKey(receiveToken.mint));
            if (info && info.data.length >= 45) verifiedDec = info.data[44];
          } catch {}
        }
        setQuoteDecimals(verifiedDec);
        if (route === "jup_then_curve") {
          // X → SOL via Jupiter, then SOL → SKYE via curve
          const rawIn = Math.floor(amountNum * 10 ** payToken.decimals);
          const quote = await getJupiterQuote(payToken.mint, NATIVE_MINT.toBase58(), rawIn);
          if (quote) {
            const solOut = parseInt(quote.outAmount);
            const skyeOut = computeSwapOutput(pool.wsolAmount, pool.skyeAmount, solOut, pool.feeBps);
            // Create a synthetic quote with final SKYE output
            setJupQuote({ ...quote, outAmount: Math.floor(skyeOut).toString() });
            setRouteLabel(`${payToken.symbol} → SOL → SKYE`);
          } else {
            setJupQuote(null);
          }
        } else if (route === "curve_then_jup") {
          // SKYE → SOL via curve, then SOL → X via Jupiter
          const rawIn = amountNum * 10 ** DECIMALS;
          const solOut = computeSwapOutput(pool.skyeAmount, pool.wsolAmount, rawIn, pool.feeBps);
          const quote = await getJupiterQuote(NATIVE_MINT.toBase58(), receiveToken.mint, Math.floor(solOut));
          if (quote) {
            setJupQuote(quote);
            setRouteLabel(`SKYE → SOL → ${receiveToken.symbol}`);
          } else {
            setJupQuote(null);
          }
        } else {
          // Direct Jupiter route
          const rawIn = Math.floor(amountNum * 10 ** payToken.decimals);
          const quote = await getJupiterQuote(payToken.mint, receiveToken.mint, rawIn);
          setJupQuote(quote);
          setRouteLabel(`via Jupiter`);
        }
      } catch {
        setJupQuote(null);
      }
      setQuoteLoading(false);
    }, 500);

    return () => clearTimeout(timer);
  }, [amountNum, route, payToken.mint, payToken.decimals, receiveToken.mint, receiveToken.decimals, pool]);

  // Get balance for current pay token
  function getPayBalance(): number | null {
    if (payToken.mint === NATIVE_MINT.toBase58()) return solBalance;
    if (payToken.mint === SKYE_MINT.toBase58()) return skyeBalance;
    const found = allTokens.find(t => t.mint === payToken.mint);
    return found ? found.balance / 10 ** found.decimals : null;
  }

  function getReceiveBalance(): number | null {
    if (receiveToken.mint === NATIVE_MINT.toBase58()) return solBalance;
    if (receiveToken.mint === SKYE_MINT.toBase58()) return skyeBalance;
    const found = allTokens.find(t => t.mint === receiveToken.mint);
    return found ? found.balance / 10 ** found.decimals : null;
  }

  function handleFlip() {
    const temp = payToken;
    setPayToken(receiveToken);
    setReceiveToken(temp);
    setAmount("");
    setJupQuote(null);
  }

  function handleMax() {
    const bal = getPayBalance();
    if (bal === null) return;
    if (payToken.mint === NATIVE_MINT.toBase58()) {
      setAmount((bal * 0.95).toFixed(4)); // leave gas
    } else if (payToken.mint === SKYE_MINT.toBase58()) {
      setAmount((maxSellableHuman).toString());
    } else {
      // Floor down slightly to avoid rounding above actual balance
      const dp = payToken.decimals > 6 ? 4 : 2;
      const floored = Math.floor(bal * 10 ** dp) / 10 ** dp;
      setAmount(floored.toFixed(dp));
    }
  }

  async function handleSubmit() {
    if (!publicKey || !sendTransaction || !signTransaction || amountNum <= 0) return;
    setJupError(null);
    setLastTx(null);

    try {
      if (isCurveBuy) {
        const minOut = BigInt(Math.floor(outputRaw * 0.95));
        await swap(BigInt(Math.floor(amountNum * LAMPORTS_PER_SOL)), true, minOut);
      } else if (isCurveSell) {
        const minOut = BigInt(Math.floor(outputRaw * 0.95));
        await swap(BigInt(Math.floor(amountNum * 10 ** DECIMALS)), false, minOut);
      } else if (route === "jup_then_curve" && jupQuote) {
        setJupPending(true);
        // Step 1: Jupiter swap (X → SOL)
        const rawIn = Math.floor(amountNum * 10 ** payToken.decimals);
        const jupQ = await getJupiterQuote(payToken.mint, NATIVE_MINT.toBase58(), rawIn, 500);
        if (!jupQ) throw new Error("Failed to get Jupiter quote");
        const sig1 = await executeJupiterSwap(jupQ, publicKey.toBase58(), connection, signTransaction!);
        setLastTx(sig1);

        // Step 2: Curve buy (SOL → SKYE)
        const solAmount = parseInt(jupQ.outAmount);
        await swap(BigInt(solAmount), true, 0n);
      } else if (route === "curve_then_jup" && jupQuote) {
        setJupPending(true);
        // Step 1: Curve sell (SKYE → SOL)
        const rawIn = Math.floor(amountNum * 10 ** DECIMALS);
        const solOut = computeSwapOutput(pool!.skyeAmount, pool!.wsolAmount, rawIn, pool!.feeBps);
        await swap(BigInt(rawIn), false, 0n);

        // Step 2: Jupiter swap (SOL → X)
        const jupQ = await getJupiterQuote(NATIVE_MINT.toBase58(), receiveToken.mint, Math.floor(solOut), 300);
        if (!jupQ) throw new Error("Failed to get Jupiter quote");
        await executeJupiterSwap(jupQ, publicKey.toBase58(), connection, signTransaction!);
      } else if (route === "jupiter") {
        setJupPending(true);
        // Re-fetch fresh quote right before executing to avoid stale slippage
        const rawIn = Math.floor(amountNum * 10 ** payToken.decimals);
        const freshQuote = await getJupiterQuote(payToken.mint, receiveToken.mint, rawIn, 500);
        if (!freshQuote) throw new Error("Failed to get Jupiter quote");
        const sig = await executeJupiterSwap(freshQuote, publicKey.toBase58(), connection, signTransaction!);
        setLastTx(sig);
      }
      setAmount("");
    } catch (e: any) {
      let msg = "Swap failed";
      if (e?.message?.includes("User rejected")) msg = "Transaction cancelled.";
      else if (e?.message?.includes("insufficient")) msg = "Insufficient balance.";
      else if (e?.message) msg = e.message.slice(0, 120);
      setJupError(msg);
    }
    setJupPending(false);
  }

  async function handleInitialBack() {
    if (!publicKey || initialBack.tokensRaw <= 0) return;
    await swap(BigInt(initialBack.tokensRaw), false, 0n);
    setAmount("");
  }

  const pending = curvePending || jupPending;
  const error = curveError || jupError;
  const confirmedTx = curveLastTx || lastTx;
  const payBal = getPayBalance();
  const receiveBal = getReceiveBalance();
  const needsJupQuote = !isCurveBuy && !isCurveSell;
  const isQuoteReady = !needsJupQuote || (jupQuote !== null);

  if (!pool) return null;

  return (
    <div className="glass overflow-hidden relative">
      <div className="p-4 sm:p-5 space-y-2">
        {/* Take Initial Back */}
        {publicKey && hasPositions && initialBack.tokensRaw > 0 && (
          <button onClick={handleInitialBack} disabled={pending}
            className="w-full py-3.5 mb-2 rounded-xl bg-gradient-to-r from-skye-500 to-skye-600 hover:from-skye-600 hover:to-skye-700 text-white font-semibold text-[13px] sm:text-[14px] shadow-soft transition-all active:scale-[0.98] disabled:opacity-50 min-h-[48px]">
            {pending ? "Confirming..." : `Take Initial Back (${initialBackSol.toFixed(4)} SOL · ${formatUsd(initialBackSol * solUsd, 2)})`}
          </button>
        )}

        {/* PAY row */}
        <div className="bg-white/5 rounded-xl p-4">
          <div className="flex justify-between items-center mb-2">
            <span className="text-[12px] text-ink-tertiary">You pay</span>
            {publicKey && payBal !== null && (
              <div className="flex items-center gap-2 text-[12px]">
                <span className="text-ink-faint">{payBal < 1000 ? payBal.toFixed(4) : payBal.toLocaleString(undefined, {maximumFractionDigits: 2})} {payToken.symbol}</span>
                <button onClick={handleMax} className="text-skye-400 font-semibold hover:underline text-[11px]">MAX</button>
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            <input type="number" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)}
              className="flex-1 text-[24px] sm:text-[28px] font-bold bg-transparent outline-none tabular-nums min-w-0" />
            <TokenButton token={payToken} onClick={() => setShowSelector("pay")} />
          </div>
          {payToken.mint === NATIVE_MINT.toBase58() && (
            <div className="flex items-center gap-2 mt-2">
              {[0.5, 1, 2, 5].map(v => (
                <button key={v} onClick={() => setAmount(v.toString())}
                  className={`flex-1 py-1.5 text-[11px] font-semibold rounded-lg border transition-all ${
                    amount === v.toString() ? "border-skye-500/40 bg-skye-500/15 text-skye-400" : "border-white/10 text-ink-tertiary hover:bg-white/5"
                  }`}>{v} SOL</button>
              ))}
            </div>
          )}
          {amountNum > 0 && payToken.mint === NATIVE_MINT.toBase58() && (
            <div className="text-[11px] text-ink-faint mt-1 tabular-nums">{formatUsd(amountNum * solUsd, 2)}</div>
          )}
        </div>

        {/* Flip */}
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
            {publicKey && receiveBal !== null && (
              <span className="text-[12px] text-ink-faint">{receiveBal < 1000 ? receiveBal.toFixed(4) : receiveBal.toLocaleString(undefined, {maximumFractionDigits: 2})} {receiveToken.symbol}</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1 text-[24px] sm:text-[28px] font-bold tabular-nums min-w-0">
              {quoteLoading ? (
                <span className="text-ink-faint animate-pulse">...</span>
              ) : amountNum > 0 && outputHuman > 0 ? (
                <span className="text-ink-secondary">
                  {outputHuman < 0.001 ? outputHuman.toExponential(2) : outputHuman < 1 ? outputHuman.toFixed(6) : outputHuman.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                </span>
              ) : (
                <span className="text-ink-faint">0.00</span>
              )}
            </div>
            <TokenButton token={receiveToken} onClick={() => setShowSelector("receive")} />
          </div>
          {amountNum > 0 && outputHuman > 0 && receiveToken.mint === NATIVE_MINT.toBase58() && (
            <div className="text-[11px] text-ink-faint mt-1 tabular-nums">{formatUsd(outputHuman * solUsd, 2)}</div>
          )}
        </div>

        {/* Sell % quick buttons (only for SKYE sell side) */}
        {payToken.mint === SKYE_MINT.toBase58() && publicKey && maxSellableRaw > 0 && (
          <div className="flex gap-2 pt-1">
            {[{ l: "25%", p: 0.25 }, { l: "50%", p: 0.5 }, { l: "75%", p: 0.75 }, { l: "Max", p: 1 }].map(({ l, p }) => (
              <button key={l} onClick={() => setAmount((Math.floor(maxSellableHuman * p * 10000) / 10000).toString())}
                className="flex-1 py-2 text-[11px] font-semibold rounded-lg border border-white/10 text-ink-tertiary hover:bg-white/5 transition-all">{l}</button>
            ))}
          </div>
        )}

        {/* Route + price info */}
        {amountNum > 0 && (isQuoteReady || isCurveBuy || isCurveSell) && outputHuman > 0 && (
          <div className="space-y-1 pt-1">
            {routeLabel && (
              <div className="flex justify-between text-[12px]">
                <span className="text-ink-faint">Route</span>
                <span className="text-skye-400 font-medium">{routeLabel}</span>
              </div>
            )}
            <div className="flex justify-between text-[12px]">
              <span className="text-ink-faint">Rate</span>
              <span className="text-ink-tertiary tabular-nums">
                1 {payToken.symbol} ≈ {(outputHuman / amountNum).toLocaleString(undefined, { maximumFractionDigits: 6 })} {receiveToken.symbol}
              </span>
            </div>
            {priceImpactPct > 0 && (
              <div className="flex justify-between text-[12px]">
                <span className="text-ink-faint">Price impact</span>
                <span className={`font-medium ${priceImpactPct > 5 ? "text-rose-400" : priceImpactPct > 2 ? "text-amber-400" : "text-ink-tertiary"}`}>
                  {priceImpactPct.toFixed(2)}%
                </span>
              </div>
            )}
            {(route === "jup_then_curve" || route === "curve_then_jup") && (
              <div className="flex justify-between text-[12px]">
                <span className="text-ink-faint">Steps</span>
                <span className="text-ink-faint">2 transactions required</span>
              </div>
            )}
          </div>
        )}

        {priceImpactPct > 5 && (
          <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl px-3 py-2 text-[12px] text-rose-400 font-medium">
            High price impact ({priceImpactPct.toFixed(1)}%). Consider a smaller trade.
          </div>
        )}

        {/* Submit */}
        {publicKey ? (
          <button onClick={handleSubmit} disabled={pending || amountNum <= 0 || (needsJupQuote && !isQuoteReady)}
            className={`w-full py-4 rounded-xl text-[14px] sm:text-[15px] font-semibold text-white transition-all active:scale-[0.98] min-h-[52px] ${
              pending ? "bg-white/10 cursor-wait" : "bg-skye-500/90 hover:bg-skye-500"
            } disabled:opacity-40`}>
            {pending ? "Confirming..." : quoteLoading ? "Getting quote..." : amountNum > 0 && outputHuman > 0
              ? `Swap ${payToken.symbol} for ${receiveToken.symbol}`
              : amountNum > 0 && needsJupQuote && !isQuoteReady ? "No route found" : "Enter an amount"}
          </button>
        ) : (
          <div className="text-center text-[13px] sm:text-[14px] text-ink-faint py-3">Connect wallet to trade</div>
        )}

        {confirmedTx && (
          <p className="text-center text-[12px] sm:text-[13px] text-emerald-400">
            Confirmed &middot; <a href={`https://solscan.io/tx/${confirmedTx}`} target="_blank" rel="noopener noreferrer" className="underline">View on Solscan</a>
          </p>
        )}
        {error && <p className="text-center text-[11px] sm:text-[12px] text-rose-400 break-all">{error}</p>}
      </div>

      {/* Token Selector */}
      {showSelector && (
        <TokenSelector
          allTokens={allTokens}
          solBalance={solBalance}
          solUsd={solUsd}
          onSelect={(token) => {
            if (showSelector === "pay") {
              // If same as receive, flip
              if (token.mint === receiveToken.mint) {
                setReceiveToken(payToken);
              }
              setPayToken(token);
            } else {
              if (token.mint === payToken.mint) {
                setPayToken(receiveToken);
              }
              setReceiveToken(token);
            }
            setAmount("");
            setJupQuote(null);
            setShowSelector(null);
          }}
          onClose={() => setShowSelector(null)}
          side={showSelector}
        />
      )}
    </div>
  );
}

function TokenButton({ token, onClick }: { token: SelectedToken; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="flex items-center gap-2 bg-white/10 hover:bg-white/15 rounded-xl px-3 py-2 transition-colors flex-shrink-0">
      <img src={token.logo} alt={token.symbol} className="w-6 h-6 rounded-full" />
      <span className="text-[14px] font-semibold text-ink-primary">{token.symbol}</span>
      <svg className="w-3 h-3 text-ink-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    </button>
  );
}

function TokenSelector({ allTokens, solBalance, solUsd, onSelect, onClose, side }: {
  allTokens: TokenBalance[];
  solBalance: number | null;
  solUsd: number;
  onSelect: (token: SelectedToken) => void;
  onClose: () => void;
  side: "pay" | "receive";
}) {
  const { connection } = useConnection();
  const [search, setSearch] = useState("");
  const [showDust, setShowDust] = useState(false);
  const [pastedToken, setPastedToken] = useState<SelectedToken | null>(null);
  const [loadingMint, setLoadingMint] = useState(false);
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

  // Detect if search is a valid mint address and fetch its info
  useEffect(() => {
    setPastedToken(null);
    setLoadingMint(false);
    const trimmed = search.trim();
    if (!trimmed || trimmed.length < 32 || trimmed.length > 44) return;

    let valid = false;
    try { new PublicKey(trimmed); valid = true; } catch {}
    if (!valid) return;

    // Show immediately as loading, then enrich
    setLoadingMint(true);
    let cancelled = false;

    (async () => {
      let decimals = 6; // most pump tokens are 6
      let symbol = trimmed.slice(0, 4) + "...";
      let name = "Unknown Token";
      let logo = "";

      // Fetch decimals from on-chain (try both programs)
      try {
        const info = await connection.getAccountInfo(new PublicKey(trimmed));
        if (info && info.data.length >= 45) {
          decimals = info.data[44]; // mint decimals at offset 44
        }
      } catch {}

      // Fetch metadata from DexScreener
      try {
        const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${trimmed}`);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length > 0) {
            const base = data[0].baseToken;
            if (base) {
              symbol = base.symbol || symbol;
              name = base.name || name;
            }
            logo = data[0].info?.imageUrl || "";
          }
        }
      } catch {}

      if (!cancelled) {
        setPastedToken({ mint: trimmed, symbol, name, logo, decimals });
        setLoadingMint(false);
      }
    })();

    return () => { cancelled = true; };
  }, [search, connection]);

  const solUsdVal = (solBalance ?? 0) * solUsd;
  const dustCount = allTokens.filter(t => !t.logo).length;

  const filtered = allTokens
    .filter(t => showDust || !!t.logo)
    .filter(t => {
      if (!search) return true;
      const q = search.toLowerCase();
      return t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.mint.toLowerCase().includes(q);
    });

  async function selectToken(mint: string, symbol: string, name: string, logo: string, decimals: number) {
    // Always verify decimals on-chain for non-hardcoded tokens
    if (!COMMON_TOKENS.find(t => t.mint === mint)) {
      try {
        const info = await connection.getAccountInfo(new PublicKey(mint));
        if (info && info.data.length >= 45) {
          decimals = info.data[44];
        }
      } catch {}
    }
    onSelect({ mint, symbol, name, logo, decimals });
  }

  return (
    <div className="absolute inset-0 z-50 bg-[rgba(5,5,15,0.95)] backdrop-blur-sm flex flex-col" ref={ref}>
      <div className="p-4 border-b border-white/5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[14px] font-bold text-ink-primary">Select token</h3>
          <button onClick={onClose} className="text-ink-faint hover:text-ink-primary text-[18px]">&times;</button>
        </div>
        <input ref={inputRef} type="text" placeholder="Search or paste contract address..."
          value={search} onChange={(e) => setSearch(e.target.value)}
          className="w-full bg-white/5 rounded-xl px-3 py-2.5 text-[13px] outline-none placeholder:text-ink-faint border border-white/5 focus:border-skye-500/30" />

        {/* Pasted CA result */}
        {loadingMint && (
          <div className="mt-2 px-3 py-2 text-[12px] text-ink-faint animate-pulse">Looking up mint...</div>
        )}
        {pastedToken && (
          <button onClick={() => selectToken(pastedToken.mint, pastedToken.symbol, pastedToken.name, pastedToken.logo, pastedToken.decimals)}
            className="mt-2 w-full flex items-center justify-between px-3 py-3 rounded-xl bg-skye-500/10 border border-skye-500/20 hover:bg-skye-500/20 transition-colors">
            <div className="flex items-center gap-3">
              {pastedToken.logo ? (
                <img src={pastedToken.logo} alt={pastedToken.symbol} className="w-8 h-8 rounded-full" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-[10px] font-bold text-ink-tertiary">
                  {pastedToken.symbol.slice(0, 2)}
                </div>
              )}
              <div className="text-left">
                <div className="text-[13px] font-semibold text-ink-primary">{pastedToken.name}</div>
                <div className="text-[11px] text-ink-faint font-mono">{pastedToken.mint.slice(0, 6)}...{pastedToken.mint.slice(-4)}</div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-[12px] font-semibold text-ink-primary">{pastedToken.symbol}</div>
              <div className="text-[11px] text-skye-400 font-semibold">Select</div>
            </div>
          </button>
        )}

        {/* Common tokens quick select */}
        <div className="flex gap-2 mt-3">
          {COMMON_TOKENS.map(t => (
            <button key={t.mint} onClick={() => selectToken(t.mint, t.symbol, t.name, t.logo, t.decimals)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/5 transition-colors">
              <img src={t.logo} alt={t.symbol} className="w-4 h-4 rounded-full" />
              <span className="text-[12px] font-semibold text-ink-primary">{t.symbol}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {/* SOL */}
        {(!search || "sol solana".includes(search.toLowerCase())) && (
          <button onClick={() => selectToken(SOL_TOKEN.mint, "SOL", "Solana", SOL_LOGO, 9)}
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

        {/* All wallet tokens */}
        {filtered.map(token => {
          const t = COMMON_TOKENS.find(c => c.mint === token.mint);
          return (
            <button key={token.mint}
              onClick={() => selectToken(token.mint, token.symbol, token.name, token.logo || "", token.decimals)}
              className="w-full flex items-center justify-between px-3 py-3 rounded-xl hover:bg-white/5 transition-colors">
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
              </div>
            </button>
          );
        })}

        {filtered.length === 0 && search && (
          <div className="text-center text-[13px] text-ink-faint py-8">No tokens found</div>
        )}
      </div>

      {/* Dust toggle */}
      {dustCount > 0 && (
        <div className="p-3 border-t border-white/5">
          <button onClick={() => setShowDust(!showDust)}
            className="w-full flex items-center justify-center gap-2 py-2 text-[12px] text-ink-faint hover:text-ink-tertiary transition-colors">
            <div className={`w-3.5 h-3.5 rounded border transition-colors flex items-center justify-center ${showDust ? "bg-skye-500 border-skye-500" : "border-white/20"}`}>
              {showDust && <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
            </div>
            Show dust ({dustCount} unknown tokens)
          </button>
        </div>
      )}
    </div>
  );
}
