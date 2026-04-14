import { useEffect, useState, useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL, ComputeBudgetProgram } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, NATIVE_MINT,
  getAssociatedTokenAddressSync, getAccount, createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction, createCloseAccountInstruction, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import ladderIdl from "../idl/skye_ladder.json";
import { formatUsd, computeSwapOutput, computeCurveSellOutput } from "../lib/format";
import { useSolPrice } from "../hooks/useSolPrice";
import { useDiscoveredTokens, type DiscoveredTokenBase } from "../hooks/useDiscoveredTokens";
import { SKYE_CURVE_ID, SKYE_AMM_PROGRAM_ID, SKYE_LADDER_PROGRAM_ID as SKYE_LADDER_ID, SWAP_DISC, DECIMALS, SKYE_MINT, TREASURY_WALLET } from "../constants";
const GRADUATION_SOL = 85;

function formatAge(ts: number): string {
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Reject javascript: and data: URIs in user-supplied social links. */
function safeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : "#";
}

type DiscoveredToken = DiscoveredTokenBase;
const SKYE_MINT_STR = SKYE_MINT.toBase58();

function computeCurveBuy(vSol: number, vToken: number, solIn: number): number {
  return Math.floor(computeSwapOutput(vSol, vToken, solIn, 100));
}

export function DiscoverTab() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const solUsd = useSolPrice();
  const { tokens: allTokens, loading } = useDiscoveredTokens();
  const tokens = allTokens.filter(t => t.mint !== SKYE_MINT_STR);
  const activeTokens = tokens.filter(t => !t.graduated);
  const graduatedTokens = tokens.filter(t => t.graduated);
  const [viewMode, setViewMode] = useState<"table" | "grid">("table");
  type SortKey = "mcap" | "progress" | "created";
  type SortDir = "asc" | "desc";
  const [sortKey, setSortKey] = useState<SortKey>("created");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [filter, setFilter] = useState<"all" | "bonding" | "graduated">("all");

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  }

  const filteredTokens = filter === "all" ? tokens : filter === "bonding" ? activeTokens : graduatedTokens;
  const sortedTokens = [...filteredTokens].sort((a, b) => {
    let diff = 0;
    if (sortKey === "mcap") {
      const mcA = a.virtualToken > 0 ? (a.virtualSol / a.virtualToken) * 1e9 : 0;
      const mcB = b.virtualToken > 0 ? (b.virtualSol / b.virtualToken) * 1e9 : 0;
      diff = mcA - mcB;
    } else if (sortKey === "progress") {
      diff = a.realSol - b.realSol;
    } else if (sortKey === "created") {
      diff = a.launchedAt - b.launchedAt;
    }
    return sortDir === "asc" ? diff : -diff;
  });

  const [trading, setTrading] = useState<string | null>(null);
  const [isBuy, setIsBuy] = useState(true);
  const [amount, setAmount] = useState("");
  const [swapPending, setSwapPending] = useState(false);
  const [swapResult, setSwapResult] = useState<{ sig: string; amount: number; symbol: string } | null>(null);
  const [swapError, setSwapError] = useState<string | null>(null);
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [tokenBalances, setTokenBalances] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!publicKey) { setSolBalance(null); return; }
    connection.getBalance(publicKey).then(b => setSolBalance(b / LAMPORTS_PER_SOL)).catch(() => {});
  }, [connection, publicKey]);

  const fetchTokenBalance = useCallback(async (mintStr: string) => {
    if (!publicKey) return;
    try {
      const mint = new PublicKey(mintStr);
      const ata = getAssociatedTokenAddressSync(mint, publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const acct = await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
      setTokenBalances(prev => ({ ...prev, [mintStr]: Number(acct.amount) / 1e9 }));
    } catch {
      setTokenBalances(prev => ({ ...prev, [mintStr]: 0 }));
    }
  }, [connection, publicKey]);

  useEffect(() => {
    if (trading) fetchTokenBalance(trading);
  }, [trading, fetchTokenBalance]);

  function openTrading(mint: string) {
    if (trading === mint) { setTrading(null); return; }
    setTrading(mint);
    setAmount("");
    setSwapResult(null);
    setSwapError(null);
    setIsBuy(true);
  }

  async function handleSwap(token: DiscoveredToken) {
    if (!publicKey || !sendTransaction || !amount) return;
    setSwapPending(true);
    setSwapError(null);
    setSwapResult(null);

    try {
      if (isBuy && token.creator && publicKey.toBase58() === token.creator) {
        if (parseFloat(amount) > 2) throw new Error("Creator buy limit: 2 SOL max per buy on your own token.");
      }

      const mint = new PublicKey(token.mint);
      const [curvePDA] = PublicKey.findProgramAddressSync([Buffer.from("curve"), mint.toBuffer()], SKYE_CURVE_ID);
      const userToken = getAssociatedTokenAddressSync(mint, publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

      const tx = new Transaction();
      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      );

      const [tokenInfo, wsolInfo, buyerWRInfo] = await Promise.all([
        connection.getAccountInfo(userToken),
        connection.getAccountInfo(userWsol),
        connection.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from("wallet"), publicKey.toBuffer(), mint.toBuffer()], SKYE_LADDER_ID)[0]),
      ]);

      if (!tokenInfo) tx.add(createAssociatedTokenAccountInstruction(publicKey, userToken, publicKey, mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
      if (!wsolInfo) tx.add(createAssociatedTokenAccountInstruction(publicKey, userWsol, publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));

      const provider = new AnchorProvider(connection, { publicKey, signTransaction: null, signAllTransactions: null } as any, { commitment: "confirmed" });
      const ladderProgram = new Program(ladderIdl as any, provider);
      const [buyerWR] = PublicKey.findProgramAddressSync([Buffer.from("wallet"), publicKey.toBuffer(), mint.toBuffer()], SKYE_LADDER_ID);
      if (!buyerWRInfo) {
        tx.add(await (ladderProgram.methods as any).createWalletRecord()
          .accounts({ payer: publicKey, wallet: publicKey, mint, walletRecord: buyerWR, systemProgram: SystemProgram.programId }).instruction());
      }

      const amountNum = parseFloat(amount);
      let rawAmount: bigint;
      let estimatedOut = 0;

      let rSol = token.virtualSol;
      let rToken = token.virtualToken;
      let feeBps = 100;
      // Fetch AMM data once and reuse for both output estimate and tx construction
      let ammPoolPDA: PublicKey | null = null;
      let ammInfo: Awaited<ReturnType<typeof connection.getAccountInfo>> = null;
      if (token.graduated) {
        [ammPoolPDA] = PublicKey.findProgramAddressSync([Buffer.from("pool"), mint.toBuffer(), NATIVE_MINT.toBuffer()], SKYE_AMM_PROGRAM_ID);
        ammInfo = await connection.getAccountInfo(ammPoolPDA);
        if (ammInfo && ammInfo.data.length >= 218) {
          rToken = Number(ammInfo.data.readBigUInt64LE(200));
          rSol = Number(ammInfo.data.readBigUInt64LE(208));
          feeBps = ammInfo.data.readUInt16LE(216);
        }
      }

      if (isBuy) {
        rawAmount = BigInt(Math.floor(amountNum * LAMPORTS_PER_SOL));
        estimatedOut = computeSwapOutput(rSol, rToken, amountNum * LAMPORTS_PER_SOL, feeBps);
        tx.add(
          SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: userWsol, lamports: Number(rawAmount) }),
          createSyncNativeInstruction(userWsol, TOKEN_PROGRAM_ID),
        );
      } else {
        rawAmount = BigInt(Math.floor(amountNum * 1e9));
        if (token.graduated) {
          estimatedOut = computeSwapOutput(rToken, rSol, amountNum * 1e9, feeBps);
        } else {
          estimatedOut = computeCurveSellOutput(token.virtualSol, token.virtualToken, amountNum * 1e9, 100);
        }
      }

      const [configPDA] = PublicKey.findProgramAddressSync([Buffer.from("config"), mint.toBuffer()], SKYE_LADDER_ID);
      const [extraMetasPDA] = PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), mint.toBuffer()], SKYE_LADDER_ID);

      const minOut = BigInt(Math.floor(estimatedOut * 0.95));

      const swapData = Buffer.alloc(8 + 8 + 8 + 1);
      swapData.set(SWAP_DISC, 0);
      swapData.writeBigUInt64LE(rawAmount, 8);
      swapData.writeBigUInt64LE(minOut, 16);
      swapData[24] = isBuy ? 1 : 0;

      if (token.graduated) {
        if (!ammPoolPDA || !ammInfo || ammInfo.data.length < 252) throw new Error("AMM pool not found for graduated token");
        const skyeReserve = new PublicKey(ammInfo.data.subarray(104, 136));
        const wsolReserve = new PublicKey(ammInfo.data.subarray(136, 168));
        const teamWallet = new PublicKey(ammInfo.data.subarray(220, 252));

        const [poolWR] = PublicKey.findProgramAddressSync([Buffer.from("wallet"), ammPoolPDA.toBuffer(), mint.toBuffer()], SKYE_LADDER_ID);
        const senderWR = isBuy ? poolWR : buyerWR;
        const receiverWR = isBuy ? buyerWR : poolWR;

        tx.add({
          keys: [
            { pubkey: publicKey, isSigner: true, isWritable: true },
            { pubkey: ammPoolPDA, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
            { pubkey: userToken, isSigner: false, isWritable: true },
            { pubkey: userWsol, isSigner: false, isWritable: true },
            { pubkey: skyeReserve, isSigner: false, isWritable: true },
            { pubkey: wsolReserve, isSigner: false, isWritable: true },
            { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: configPDA, isSigner: false, isWritable: false },
            { pubkey: senderWR, isSigner: false, isWritable: true },
            { pubkey: receiverWR, isSigner: false, isWritable: true },
            { pubkey: ammPoolPDA, isSigner: false, isWritable: false },
            { pubkey: SKYE_LADDER_ID, isSigner: false, isWritable: false },
            { pubkey: extraMetasPDA, isSigner: false, isWritable: false },
            { pubkey: teamWallet, isSigner: false, isWritable: true },
          ],
          programId: SKYE_AMM_PROGRAM_ID,
          data: swapData,
        });
      } else {
        const tokenReserve = getAssociatedTokenAddressSync(mint, curvePDA, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
        const solReserve = getAssociatedTokenAddressSync(NATIVE_MINT, curvePDA, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
        const treasuryWsol = getAssociatedTokenAddressSync(NATIVE_MINT, TREASURY_WALLET, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
        const [curveWR] = PublicKey.findProgramAddressSync([Buffer.from("wallet"), curvePDA.toBuffer(), mint.toBuffer()], SKYE_LADDER_ID);
        const senderWR = isBuy ? curveWR : buyerWR;
        const receiverWR = isBuy ? buyerWR : curveWR;

        tx.add({
          keys: [
            { pubkey: publicKey, isSigner: true, isWritable: true },
            { pubkey: curvePDA, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
            { pubkey: userToken, isSigner: false, isWritable: true },
            { pubkey: userWsol, isSigner: false, isWritable: true },
            { pubkey: tokenReserve, isSigner: false, isWritable: true },
            { pubkey: solReserve, isSigner: false, isWritable: true },
            { pubkey: treasuryWsol, isSigner: false, isWritable: true },
            { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: configPDA, isSigner: false, isWritable: false },
            { pubkey: senderWR, isSigner: false, isWritable: true },
            { pubkey: receiverWR, isSigner: false, isWritable: true },
            { pubkey: curvePDA, isSigner: false, isWritable: false },
            { pubkey: SKYE_LADDER_ID, isSigner: false, isWritable: false },
            { pubkey: extraMetasPDA, isSigner: false, isWritable: false },
          ],
          programId: SKYE_CURVE_ID,
          data: swapData,
        });
      }

      if (!isBuy) {
        tx.add(createCloseAccountInstruction(userWsol, publicKey, publicKey, [], TOKEN_PROGRAM_ID));
      }

      tx.feePayer = publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");

      setSwapResult({
        sig,
        amount: isBuy ? estimatedOut / 1e9 : estimatedOut / LAMPORTS_PER_SOL,
        symbol: isBuy ? token.symbol : "SOL",
      });
      setAmount("");
      fetchTokenBalance(token.mint);
      connection.getBalance(publicKey).then(b => setSolBalance(b / LAMPORTS_PER_SOL)).catch(() => {});
    } catch (e: any) {
      setSwapError(e.message || "Swap failed");
      console.error("Swap error:", e);
    }
    setSwapPending(false);
  }

  function renderTokenCard(t: DiscoveredToken) {
    const price = t.virtualToken > 0 ? t.virtualSol / t.virtualToken : 0;
    const mcSol = price * 1e9;
    const isTrading = trading === t.mint;
    const amountNum = parseFloat(amount) || 0;
    const bondPct = Math.min(100, (t.realSol / 1e9 / GRADUATION_SOL) * 100);
    const holding = tokenBalances[t.mint] || 0;

    let outputEstimate = "";
    let outputSolValue = "";
    let priceImpactPct = 0;
    if (isTrading && amountNum > 0) {
      if (isBuy) {
        const inLamports = amountNum * LAMPORTS_PER_SOL;
        const out = t.graduated
          ? computeSwapOutput(t.virtualSol, t.virtualToken, inLamports, 100)
          : computeCurveBuy(t.virtualSol, t.virtualToken, inLamports);
        outputEstimate = `~${(out / 1e9).toLocaleString(undefined, { maximumFractionDigits: 0 })} ${t.symbol}`;
        if (out > 0) {
          const spotPrice = t.virtualSol / t.virtualToken;
          const effectivePrice = inLamports / out;
          priceImpactPct = ((effectivePrice - spotPrice) / spotPrice) * 100;
        }
      } else {
        const rawIn = amountNum * 1e9;
        const out = t.graduated
          ? computeSwapOutput(t.virtualToken, t.virtualSol, rawIn, 100)
          : computeCurveSellOutput(t.virtualSol, t.virtualToken, rawIn, 100);
        outputEstimate = `~${(out / LAMPORTS_PER_SOL).toFixed(6)} SOL`;
        outputSolValue = formatUsd(out / LAMPORTS_PER_SOL * solUsd, 2);
        if (out > 0) {
          const spotPrice = t.virtualToken / t.virtualSol;
          const effectivePrice = rawIn / out;
          priceImpactPct = ((effectivePrice - spotPrice) / spotPrice) * 100;
        }
      }
    }

    const quickAmounts = isBuy ? [0.1, 0.25, 0.5, 1] : [25, 50, 75, 100];

    // Circular bonding arc values
    const circumference = 2 * Math.PI * 18;
    const arcOffset = circumference - (circumference * bondPct / 100);

    return (
      <div key={t.mint} className="album-card group">
        {/* ── Album image area ── */}
        <div className="album-img-wrap cursor-pointer" onClick={() => openTrading(t.mint)}>
          {t.image ? (
            <img src={t.image} alt={t.name} />
          ) : (
            <div className="w-full h-full flex items-center justify-center dot-grid">
              <span className="font-pixel text-[24px] text-skye-400/30">{t.symbol.slice(0, 2)}</span>
            </div>
          )}

          {/* Floating overlay on image */}
          <div className="album-overlay">
            <div className="flex items-end justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-[18px] font-bold text-white tracking-tight truncate">{t.name}</h3>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[12px] text-ink-secondary font-medium">${t.symbol}</span>
                  {mcSol > 0 && <span className="text-[11px] text-ink-faint">MC {formatUsd(mcSol * solUsd, 0)}</span>}
                </div>
              </div>

              {/* Bonding arc or graduated badge */}
              {!t.graduated ? (
                <div className="bond-arc flex-shrink-0">
                  <svg width="44" height="44" viewBox="0 0 44 44">
                    <circle className="bond-arc-bg" cx="22" cy="22" r="18" />
                    <circle className="bond-arc-fill" cx="22" cy="22" r="18"
                      stroke="url(#bond-grad)"
                      strokeDasharray={circumference}
                      strokeDashoffset={arcOffset} />
                    <defs><linearGradient id="bond-grad" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0%" stopColor="#10b981" />
                      <stop offset="100%" stopColor="#34d399" />
                    </linearGradient></defs>
                  </svg>
                  <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold text-white">{Math.floor(bondPct)}%</span>
                </div>
              ) : (
                <div className="grad-badge rounded-full text-[8px] font-pixel flex-shrink-0">
                  <span className="text-purple-300 whitespace-nowrap">GRADUATED</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Card body ── */}
        <div className="p-4 space-y-3">
          {/* Quick info row */}
          <div className="flex items-center justify-between">
            {!t.graduated ? (
              <span className="text-[11px] text-ink-faint">{(t.realSol / 1e9).toFixed(2)} SOL raised</span>
            ) : (
              <span className="text-[11px] text-ink-faint">AMM · Liquidity locked</span>
            )}
            <button onClick={() => openTrading(t.mint)}
              className={`btn-glow px-4 py-1.5 rounded-full text-[11px] font-semibold border transition-all duration-300 ${
                isTrading
                  ? "bg-skye-500/10 border-skye-500/30 text-skye-400"
                  : "bg-surface-2 border-white/[0.06] text-ink-secondary hover:text-white"
              }`}>
              {isTrading ? "Close" : "Trade"}
            </button>
          </div>

          {/* Contract address */}
          <CopyableMint mint={t.mint} />
        </div>

        {/* Swap drawer */}
        {isTrading && (
          <div className="px-4 pb-5 pt-3 border-t border-white/[0.06] space-y-3">
            {/* Socials */}
            {(t.twitter || t.telegram || t.website || t.discord) && (
              <div className="flex gap-3 text-[11px] flex-wrap">
                {t.website && <a href={safeUrl(t.website)} target="_blank" rel="noopener noreferrer" className="text-skye-400 hover:underline">Website</a>}
                {t.twitter && <a href={`https://twitter.com/${t.twitter.replace("@","")}`} target="_blank" rel="noopener noreferrer" className="text-skye-400 hover:underline">Twitter</a>}
                {t.telegram && <a href={safeUrl(t.telegram)} target="_blank" rel="noopener noreferrer" className="text-skye-400 hover:underline">Telegram</a>}
                {t.discord && <a href={safeUrl(t.discord)} target="_blank" rel="noopener noreferrer" className="text-skye-400 hover:underline">Discord</a>}
              </div>
            )}
            {t.description && <p className="text-[12px] text-ink-tertiary">{t.description}</p>}

            {/* Buy/Sell toggle */}
            <div className="flex bg-surface-0 rounded-full p-1 border border-white/[0.04]">
              <button onClick={() => { setIsBuy(true); setAmount(""); setSwapResult(null); }}
                className={`flex-1 py-2 text-[13px] font-semibold rounded-full transition-all duration-300 ${isBuy ? "bg-skye-500/[0.15] text-skye-400 shadow-sm" : "text-ink-faint hover:text-ink-secondary"}`}>Buy</button>
              <button onClick={() => { setIsBuy(false); setAmount(""); setSwapResult(null); }}
                className={`flex-1 py-2 text-[13px] font-semibold rounded-full transition-all duration-300 ${!isBuy ? "bg-rose-500/[0.12] text-rose-400 shadow-sm" : "text-ink-faint hover:text-ink-secondary"}`}>Sell</button>
            </div>

            {/* Balance row */}
            {publicKey && (
              <div className="flex justify-between text-[12px] text-ink-faint px-1">
                {isBuy ? (
                  <>
                    <span>Balance: <span className="text-ink-secondary font-semibold">{solBalance !== null ? solBalance.toFixed(4) : "..."} SOL</span></span>
                    <button onClick={() => setAmount(((solBalance || 0) * 0.95).toFixed(4))} className="text-skye-400 font-semibold hover:underline">Max</button>
                  </>
                ) : (
                  <>
                    <span>Holdings: <span className="text-ink-secondary font-semibold">{holding.toLocaleString(undefined, {maximumFractionDigits: 0})} {t.symbol}</span></span>
                    {holding > 0 && <button onClick={() => setAmount(holding.toString())} className="text-skye-400 font-semibold hover:underline">Max</button>}
                  </>
                )}
              </div>
            )}

            {/* Quick amount buttons */}
            <div className="flex gap-2">
              {quickAmounts.map(q => (
                <button key={q} disabled={!isBuy && holding <= 0} onClick={() => {
                  if (isBuy) {
                    setAmount(q.toString());
                  } else {
                    const pct = q / 100;
                    setAmount(Math.floor(holding * pct).toString());
                  }
                  setSwapResult(null);
                }}
                  className={`flex-1 py-1.5 text-[11px] font-semibold bg-surface-0 border border-white/[0.06] rounded-full text-ink-secondary transition-all duration-200 ${!isBuy && holding <= 0 ? "opacity-40 cursor-not-allowed" : "hover:bg-surface-2"}`}>
                  {isBuy ? `${q} SOL` : `${q}%`}
                </button>
              ))}
            </div>

            {/* Amount input */}
            <div className="glow-input card-inset rounded-2xl p-4">
              <div className="flex items-baseline gap-2">
                <input type="number" placeholder="0.00" value={amount} onChange={e => { setAmount(e.target.value); setSwapResult(null); }}
                  className="flex-1 bg-transparent text-[26px] font-bold text-white outline-none min-w-0 tracking-tight" />
                <span className="text-[13px] font-semibold text-ink-faint">{isBuy ? "SOL" : t.symbol}</span>
              </div>
              {isBuy && amountNum > 0 && <p className="text-[11px] text-ink-faint mt-1">{formatUsd(amountNum * solUsd, 2)}</p>}
            </div>

            {/* Output estimate */}
            {outputEstimate && (
              <div className="bg-surface-0 border border-white/[0.06] rounded-xl px-4 py-3 flex justify-between items-center">
                <span className="text-[12px] text-ink-faint">You receive</span>
                <div className="text-right">
                  <span className="text-[14px] text-white font-semibold">{outputEstimate}</span>
                  {outputSolValue && <span className="text-[11px] text-ink-faint ml-2">({outputSolValue})</span>}
                </div>
              </div>
            )}

            {/* Slippage info */}
            {amountNum > 0 && (
              <div className="flex justify-between text-[10px] text-ink-faint px-1">
                <span>Slippage tolerance</span>
                <span>5%</span>
              </div>
            )}

            {/* Price impact warning */}
            {priceImpactPct > 5 && (
              <div className="bg-rose-500/8 border border-rose-500/15 rounded-xl px-3 py-2 text-[11px] text-rose-400 font-medium">
                High price impact ({priceImpactPct.toFixed(1)}%). Consider a smaller trade.
              </div>
            )}

            {/* Swap button */}
            {publicKey ? (
              <button onClick={() => handleSwap(t)} disabled={swapPending || amountNum <= 0}
                className={`btn-glow w-full py-3.5 rounded-2xl text-[14px] font-bold text-white transition-all duration-300 min-h-[48px] active:scale-[0.97] ${
                  swapPending ? "bg-white/10 cursor-wait" : isBuy ? "bg-gradient-to-r from-skye-600 via-skye-500 to-emerald-500" : "bg-gradient-to-r from-rose-600 to-rose-500"
                } disabled:opacity-40`}>
                {swapPending ? "Confirming..." : isBuy ? `Buy ${t.symbol}` : `Sell ${t.symbol}`}
              </button>
            ) : (
              <p className="text-center text-[13px] text-ink-faint py-2">Connect wallet to trade</p>
            )}

            {/* Result */}
            {swapResult && (
              <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-3 text-center space-y-1">
                <p className="text-[14px] font-bold text-emerald-400">
                  +{swapResult.amount.toLocaleString(undefined, {maximumFractionDigits: swapResult.symbol === "SOL" ? 6 : 0})} {swapResult.symbol}
                </p>
                <a href={`https://solscan.io/tx/${swapResult.sig}`} target="_blank" rel="noopener noreferrer"
                  className="text-[11px] text-emerald-400/70 hover:underline">View on Solscan</a>
              </div>
            )}
            {swapError && <p className="text-[11px] text-rose-400 text-center break-all">{swapError.length > 200 ? swapError.slice(0,200)+"..." : swapError}</p>}

            <a href={`https://solscan.io/token/${t.mint}`} target="_blank" rel="noopener noreferrer"
              className="text-[10px] text-ink-faint hover:text-ink-tertiary block text-center">{t.mint}</a>
          </div>
        )}
      </div>
    );
  }

  function SortBtn({ k, label }: { k: SortKey; label: string }) {
    const active = sortKey === k;
    return (
      <button onClick={() => toggleSort(k)} className={`flex items-center gap-1 ${active ? "text-skye-400" : "text-ink-faint"}`}>
        {label}
        <span className="flex flex-col text-[8px] leading-[8px]">
          <span className={active && sortDir === "asc" ? "text-skye-400" : "text-ink-ghost"}>▲</span>
          <span className={active && sortDir === "desc" ? "text-skye-400" : "text-ink-ghost"}>▼</span>
        </span>
      </button>
    );
  }

  return (
    <div className="space-y-4">

      {loading && (
        <div className="flex flex-col items-center py-16 gap-4">
          <div className="relative w-10 h-10">
            <div className="absolute inset-0 rounded-full border-2 border-skye-500/20 border-t-skye-400 animate-spin" />
          </div>
          <p className="font-pixel text-[8px] text-skye-400 tracking-[0.2em]">SCANNING LAUNCHES...</p>
        </div>
      )}

      {!loading && tokens.length === 0 && (
        <div className="glass p-16 text-center space-y-4">
          <p className="text-[16px] text-white font-semibold">No tokens launched yet</p>
          <p className="text-[14px] text-ink-faint">Be the first to create one</p>
        </div>
      )}

      {!loading && tokens.length > 0 && (
        <>
          {/* Filter bar */}
          <div className="flex items-center gap-2 flex-wrap">
            {(["all", "bonding", "graduated"] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`px-3 py-1.5 text-[11px] font-semibold rounded-lg transition ${filter === f ? "bg-skye-500/20 text-skye-400" : "bg-white/5 text-ink-faint hover:bg-white/10"}`}>
                {f === "all" ? `ALL (${tokens.length})` : f === "bonding" ? `BONDING (${activeTokens.length})` : `GRADUATED (${graduatedTokens.length})`}
              </button>
            ))}
            <div className="flex-1" />
            <button onClick={() => setViewMode(v => v === "table" ? "grid" : "table")}
              className="px-3 py-1.5 text-[11px] font-semibold rounded-lg bg-white/5 text-ink-faint hover:bg-white/10 transition">
              {viewMode === "table" ? "GRID" : "TABLE"}
            </button>
          </div>

          {viewMode === "table" ? (
            /* ── Table view ── */
            <div className="glass overflow-x-auto p-4">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-white/5 text-ink-faint">
                    <th className="text-left py-3 px-3 font-semibold">TOKEN</th>
                    <th className="text-right py-3 px-3 font-semibold"><SortBtn k="mcap" label="MCAP" /></th>
                    <th className="text-right py-3 px-3 font-semibold"><SortBtn k="progress" label="PROGRESS" /></th>
                    <th className="text-right py-3 px-3 font-semibold"><SortBtn k="created" label="CREATED" /></th>
                    <th className="text-left py-3 px-3 font-semibold">CREATOR</th>
                    <th className="text-center py-3 px-3 font-semibold">STATUS</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedTokens.map(t => {
                    const price = t.virtualToken > 0 ? t.virtualSol / t.virtualToken : 0;
                    const mcSol = price * 1e9;
                    const progress = Math.min(100, (t.realSol / 1e9 / GRADUATION_SOL) * 100);
                    const age = t.launchedAt > 0 ? formatAge(t.launchedAt) : "—";
                    const isOpen = trading === t.mint;

                    return (
                      <tr key={t.mint} className="border-b border-white/[0.03] hover:bg-white/[0.02] cursor-pointer transition"
                        onClick={() => openTrading(t.mint)}>
                        <td className="py-3 px-3">
                          <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-lg overflow-hidden flex-shrink-0 bg-white/5">
                              {t.image ? <img src={t.image} alt="" className="w-full h-full object-cover" /> :
                                <div className="w-full h-full flex items-center justify-center text-[9px] text-ink-faint">{t.symbol.slice(0,2)}</div>}
                            </div>
                            <div>
                              <div className="font-semibold text-white text-[13px]">{t.name}</div>
                              <div className="text-ink-faint text-[10px]">${t.symbol}</div>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 px-3 text-right text-white font-semibold tabular-nums">{formatUsd(mcSol * solUsd, 0)}</td>
                        <td className="py-3 px-3 text-right">
                          {t.graduated ? (
                            <span className="text-purple-400 font-semibold">100%</span>
                          ) : (
                            <div className="flex items-center gap-2 justify-end">
                              <span className="text-ink-faint tabular-nums">{progress.toFixed(1)}%</span>
                              <div className="w-16 h-1.5 bg-white/5 rounded-full overflow-hidden">
                                <div className="h-full rounded-full bg-skye-400" style={{ width: `${Math.max(progress, 2)}%` }} />
                              </div>
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-3 text-right text-ink-faint tabular-nums">{age}</td>
                        <td className="py-3 px-3">
                          <span className="font-mono text-[10px] text-ink-faint">{t.creator ? t.creator.slice(0,4) + "..." + t.creator.slice(-4) : "—"}</span>
                        </td>
                        <td className="py-3 px-3 text-center">
                          {t.graduated
                            ? <span className="px-2 py-0.5 rounded text-[9px] font-semibold bg-purple-500/20 text-purple-400">GRAD</span>
                            : <span className="px-2 py-0.5 rounded text-[9px] font-semibold bg-skye-500/20 text-skye-400">LIVE</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            /* ── Grid view (existing cards) ── */
            <div className="space-y-6">
              {activeTokens.length > 0 && (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 px-1">
                    <div className="w-2 h-2 rounded-full bg-skye-400 breathe" />
                    <h3 className="text-[14px] font-semibold text-white tracking-tight">Bonding</h3>
                    <span className="text-[12px] text-ink-faint">{activeTokens.length}</span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 stagger-in">
                    {activeTokens.map(renderTokenCard)}
                  </div>
                </div>
              )}
              {graduatedTokens.length > 0 && (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 px-1">
                    <div className="w-2 h-2 rounded-full bg-purple-400" />
                    <h3 className="text-[14px] font-semibold text-white tracking-tight">Graduated</h3>
                    <span className="text-[12px] text-ink-faint">{graduatedTokens.length}</span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                    {graduatedTokens.map(renderTokenCard)}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Swap panel for selected token */}
          {trading && (() => {
            const t = tokens.find(x => x.mint === trading);
            if (!t) return null;
            return renderTokenCard(t);
          })()}
        </>
      )}
    </div>
  );
}

function CopyableMint({ mint }: { mint: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(mint).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }
  return (
    <button onClick={handleCopy}
      className="w-full flex items-center justify-between gap-2 px-3 py-1.5 bg-surface-0 hover:bg-surface-2 border border-white/[0.06] rounded-lg transition-all duration-200 group">
      <span className="font-mono text-[10px] text-ink-faint truncate">{mint}</span>
      <span className={`text-[10px] font-semibold flex-shrink-0 transition-colors ${copied ? "text-emerald-400" : "text-skye-400 group-hover:text-skye-300"}`}>
        {copied ? "Copied" : "Copy"}
      </span>
    </button>
  );
}
