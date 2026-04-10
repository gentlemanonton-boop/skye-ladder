import { useEffect, useState, useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, NATIVE_MINT,
  getAssociatedTokenAddressSync, getAccount, createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction, createCloseAccountInstruction, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import ladderIdl from "../idl/skye_ladder.json";
import { formatUsd } from "../lib/format";
import { useSolPrice } from "../hooks/useSolPrice";
import { useDiscoveredTokens, type DiscoveredTokenBase } from "../hooks/useDiscoveredTokens";
import { SKYE_CURVE_ID, SKYE_AMM_PROGRAM_ID, SKYE_LADDER_PROGRAM_ID as SKYE_LADDER_ID, SWAP_DISC, DECIMALS, SKYE_MINT } from "../constants";
const GRADUATION_SOL = 85;

type DiscoveredToken = DiscoveredTokenBase;
const SKYE_MINT_STR = SKYE_MINT.toBase58();

function computeCurveBuy(vSol: number, vToken: number, solIn: number): number {
  const fee = solIn * 100 / 10000;
  const eff = solIn - fee;
  return Math.floor(eff * vToken / (vSol + eff));
}

function computeCurveSell(vSol: number, vToken: number, tokensIn: number): number {
  if (tokensIn <= 0 || vSol <= 0 || vToken <= 0) return 0;
  const rawOut = Math.floor((tokensIn * vSol) / (vToken + tokensIn));
  const fee = Math.floor((rawOut * 100) / 10000);
  return rawOut - fee;
}

function computeAmmSwap(reserveIn: number, reserveOut: number, amountIn: number, feeBps: number): number {
  const fee = (amountIn * feeBps) / 10000;
  const eff = amountIn - fee;
  return Math.floor((eff * reserveOut) / (reserveIn + eff));
}

export function DiscoverTab() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const solUsd = useSolPrice();
  const { tokens: allTokens, loading } = useDiscoveredTokens();
  const tokens = allTokens.filter(t => t.mint !== SKYE_MINT_STR);
  const activeTokens = tokens.filter(t => !t.graduated);
  const graduatedTokens = tokens.filter(t => t.graduated);
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

      const TREASURY_WALLET = new PublicKey("5j5J5sMhwURJv1bdufDUypt29FeRnfv8GLpv53Cy1oxs");
      const mint = new PublicKey(token.mint);
      const [curvePDA] = PublicKey.findProgramAddressSync([Buffer.from("curve"), mint.toBuffer()], SKYE_CURVE_ID);
      const userToken = getAssociatedTokenAddressSync(mint, publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

      const tx = new Transaction();

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
      if (token.graduated) {
        const [ammPoolPDA] = PublicKey.findProgramAddressSync([Buffer.from("pool"), mint.toBuffer(), NATIVE_MINT.toBuffer()], SKYE_AMM_PROGRAM_ID);
        const ammInfo = await connection.getAccountInfo(ammPoolPDA);
        if (ammInfo && ammInfo.data.length >= 218) {
          rToken = Number(ammInfo.data.readBigUInt64LE(200));
          rSol = Number(ammInfo.data.readBigUInt64LE(208));
          feeBps = ammInfo.data.readUInt16LE(216);
        }
      }

      if (isBuy) {
        rawAmount = BigInt(Math.floor(amountNum * LAMPORTS_PER_SOL));
        estimatedOut = computeAmmSwap(rSol, rToken, amountNum * LAMPORTS_PER_SOL, feeBps);
        tx.add(
          SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: userWsol, lamports: Number(rawAmount) }),
          createSyncNativeInstruction(userWsol, TOKEN_PROGRAM_ID),
        );
      } else {
        rawAmount = BigInt(Math.floor(amountNum * 1e9));
        if (token.graduated) {
          estimatedOut = computeAmmSwap(rToken, rSol, amountNum * 1e9, feeBps);
        } else {
          estimatedOut = computeCurveSell(token.virtualSol, token.virtualToken, amountNum * 1e9);
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
        const [ammPoolPDA] = PublicKey.findProgramAddressSync([Buffer.from("pool"), mint.toBuffer(), NATIVE_MINT.toBuffer()], SKYE_AMM_PROGRAM_ID);
        const ammInfo = await connection.getAccountInfo(ammPoolPDA);
        if (!ammInfo || ammInfo.data.length < 252) throw new Error("AMM pool not found for graduated token");
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
    if (isTrading && amountNum > 0) {
      if (isBuy) {
        const out = t.graduated
          ? computeAmmSwap(t.virtualSol, t.virtualToken, amountNum * LAMPORTS_PER_SOL, 100)
          : computeCurveBuy(t.virtualSol, t.virtualToken, amountNum * LAMPORTS_PER_SOL);
        outputEstimate = `~${(out / 1e9).toLocaleString(undefined, { maximumFractionDigits: 0 })} ${t.symbol}`;
      } else {
        const out = t.graduated
          ? computeAmmSwap(t.virtualToken, t.virtualSol, amountNum * 1e9, 100)
          : computeCurveSell(t.virtualSol, t.virtualToken, amountNum * 1e9);
        outputEstimate = `~${(out / LAMPORTS_PER_SOL).toFixed(6)} SOL`;
        outputSolValue = formatUsd(out / LAMPORTS_PER_SOL * solUsd, 2);
      }
    }

    const quickAmounts = isBuy ? [0.1, 0.25, 0.5, 1] : [25, 50, 75, 100];

    return (
      <div key={t.mint} className="glass overflow-hidden">
        {/* Token header — click to open swap */}
        <div className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-white/3 transition"
          onClick={() => openTrading(t.mint)}>
          <div className="w-11 h-11 rounded-xl overflow-hidden flex-shrink-0 bg-gradient-to-br from-skye-500/20 to-emerald-500/20 flex items-center justify-center">
            {t.image ? <img src={t.image} alt="" className="w-full h-full object-cover" /> :
              <span className="font-pixel text-[9px] text-skye-400">{t.symbol.slice(0, 2)}</span>}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-bold text-ink-primary">{t.name}</span>
              <span className="text-[11px] text-ink-faint">${t.symbol}</span>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-ink-faint mt-0.5">
              {!t.graduated && <span>{(t.realSol / 1e9).toFixed(2)} SOL</span>}
              {mcSol > 0 && <span>MC {formatUsd(mcSol * solUsd, 0)}</span>}
            </div>
          </div>
          <span className={`text-[12px] font-semibold ${isTrading ? "text-skye-400" : "text-ink-faint"}`}>
            {isTrading ? "Close" : "Trade"}
          </span>
        </div>

        {/* Bonding curve progress OR graduated badge */}
        {!t.graduated ? (
          <div className="px-4 pb-2">
            <div className="flex justify-between text-[10px] text-ink-faint mb-1">
              <span>Bonding curve</span>
              <span>{bondPct.toFixed(1)}% — {GRADUATION_SOL} SOL to graduate</span>
            </div>
            <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all duration-500" style={{
                width: `${Math.max(bondPct, 1)}%`,
                background: "linear-gradient(90deg, #22c55e, #4ade80)",
              }} />
            </div>
          </div>
        ) : (
          <div className="px-4 pb-2">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="font-pixel text-[8px] bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded">GRADUATED</span>
              <span className="text-ink-faint">Trading on AMM — liquidity locked</span>
            </div>
          </div>
        )}

        {/* Contract address */}
        <div className="px-4 pb-3">
          <CopyableMint mint={t.mint} />
        </div>

        {/* Swap panel */}
        {isTrading && (
          <div className="px-4 pb-5 pt-2 border-t border-white/5 space-y-3">
            {/* Socials */}
            {(t.twitter || t.telegram || t.website || t.discord) && (
              <div className="flex gap-3 text-[11px] flex-wrap">
                {t.website && <a href={t.website} target="_blank" rel="noopener noreferrer" className="text-skye-400 hover:underline">Website</a>}
                {t.twitter && <a href={`https://twitter.com/${t.twitter.replace("@","")}`} target="_blank" rel="noopener noreferrer" className="text-skye-400 hover:underline">Twitter</a>}
                {t.telegram && <a href={t.telegram} target="_blank" rel="noopener noreferrer" className="text-skye-400 hover:underline">Telegram</a>}
                {t.discord && <a href={t.discord} target="_blank" rel="noopener noreferrer" className="text-skye-400 hover:underline">Discord</a>}
              </div>
            )}
            {t.description && <p className="text-[12px] text-ink-tertiary">{t.description}</p>}

            {/* Buy/Sell toggle */}
            <div className="flex bg-white/5 rounded-xl p-1">
              <button onClick={() => { setIsBuy(true); setAmount(""); setSwapResult(null); }}
                className={`flex-1 py-2.5 text-[13px] font-semibold rounded-lg transition min-h-[44px] ${isBuy ? "bg-emerald-500/20 text-emerald-400" : "text-ink-faint"}`}>Buy</button>
              <button onClick={() => { setIsBuy(false); setAmount(""); setSwapResult(null); }}
                className={`flex-1 py-2.5 text-[13px] font-semibold rounded-lg transition min-h-[44px] ${!isBuy ? "bg-rose-500/20 text-rose-400" : "text-ink-faint"}`}>Sell</button>
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
                <button key={q} onClick={() => {
                  if (isBuy) {
                    setAmount(q.toString());
                  } else {
                    const pct = q / 100;
                    setAmount(Math.floor(holding * pct).toString());
                  }
                  setSwapResult(null);
                }}
                  className="flex-1 py-1.5 text-[11px] font-semibold bg-white/5 hover:bg-white/10 rounded-lg text-ink-secondary transition">
                  {isBuy ? `${q} SOL` : `${q}%`}
                </button>
              ))}
            </div>

            {/* Amount input */}
            <div className="bg-white/3 rounded-xl px-4 py-3">
              <div className="flex items-baseline gap-2">
                <input type="number" placeholder="0.00" value={amount} onChange={e => { setAmount(e.target.value); setSwapResult(null); }}
                  className="flex-1 bg-transparent text-[22px] font-bold text-ink-primary outline-none min-w-0" />
                <span className="text-[13px] font-semibold text-ink-faint">{isBuy ? "SOL" : t.symbol}</span>
              </div>
              {isBuy && amountNum > 0 && <p className="text-[11px] text-ink-faint mt-1">{formatUsd(amountNum * solUsd, 2)}</p>}
            </div>

            {/* Output estimate */}
            {outputEstimate && (
              <div className="bg-white/5 rounded-xl px-4 py-3 flex justify-between items-center">
                <span className="text-[12px] text-ink-faint">You receive</span>
                <div className="text-right">
                  <span className="text-[14px] text-ink-primary font-semibold">{outputEstimate}</span>
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

            {/* Swap button */}
            {publicKey ? (
              <button onClick={() => handleSwap(t)} disabled={swapPending || amountNum <= 0}
                className={`w-full py-3.5 rounded-xl text-[14px] font-semibold text-white transition min-h-[48px] active:scale-[0.98] ${
                  swapPending ? "bg-white/10 cursor-wait" : isBuy ? "bg-emerald-500/90 hover:bg-emerald-500" : "bg-rose-500/90 hover:bg-rose-500"
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

  return (
    <div className="space-y-6">
      <div className="glass p-4 text-center">
        <h2 className="font-pixel text-[14px] sm:text-[16px] text-skye-400 tracking-wide">DISCOVER</h2>
      </div>

      {loading && (
        <div className="glass p-8 text-center">
          <div className="w-2 h-2 rounded-full bg-skye-400 animate-pulse mx-auto mb-3" />
          <p className="font-pixel text-[9px] text-skye-400">SCANNING LAUNCHES...</p>
        </div>
      )}

      {!loading && tokens.length === 0 && (
        <div className="glass p-12 text-center">
          <p className="text-[14px] text-ink-tertiary">No tokens launched yet. Be the first!</p>
        </div>
      )}

      {/* Active tokens — still on bonding curve */}
      {activeTokens.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-[12px] font-semibold text-ink-tertiary uppercase tracking-wider px-1">Bonding</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {activeTokens.map(renderTokenCard)}
          </div>
        </div>
      )}

      {/* Graduated tokens — trading on AMM */}
      {graduatedTokens.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-[12px] font-semibold text-purple-400 uppercase tracking-wider px-1">Graduated</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {graduatedTokens.map(renderTokenCard)}
          </div>
        </div>
      )}

      <div className="h-2 rounded-full overflow-hidden" style={{ background: "repeating-linear-gradient(90deg, rgba(34,197,94,0.3) 0px, rgba(34,197,94,0.3) 4px, transparent 4px, transparent 8px)" }} />
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
      className="w-full flex items-center justify-between gap-2 px-3 py-1.5 bg-white/3 hover:bg-white/5 border border-white/5 rounded-lg transition-colors group">
      <span className="font-mono text-[10px] text-ink-faint truncate">{mint}</span>
      <span className={`text-[10px] font-semibold flex-shrink-0 transition-colors ${copied ? "text-emerald-400" : "text-skye-400 group-hover:text-skye-300"}`}>
        {copied ? "Copied" : "Copy"}
      </span>
    </button>
  );
}
