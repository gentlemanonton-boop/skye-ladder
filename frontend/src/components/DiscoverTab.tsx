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
import { getStoredTokens, type LaunchedTokenInfo } from "../lib/launchStore";
import { fetchMetadataForMints } from "../lib/metadataReader";
import { formatUsd } from "../lib/format";
import { useSolPrice } from "../hooks/useSolPrice";
import { SKYE_CURVE_ID, SKYE_LADDER_PROGRAM_ID as SKYE_LADDER_ID, SWAP_DISC, DECIMALS } from "../constants";
const GRADUATION_SOL = 85;

// Hidden from Discover: dead test tokens + the main SKYE coin.
// SKYE is intentionally excluded — it's the official coin and lives on the
// Trade tab, NOT in the Discover feed of community launches. SKYE still
// appears in the World view (alongside every launched coin).
const EXCLUDED_MINTS = new Set([
  "HREtu5WXuKJP1L23shpNTP3U4Xtmfekv82Lyuq1vMrsd",
  "5BJcCPdZbxBMhodSZxUMowHSNY38dqhiRgSxDw8uLqZ1",
  "4w1DQR7HuVNdK6YDKvgyGSQ7A6Ba7ChWL4Hof1HKw1j",
  "5GtUWP1x4LpKjAzGBZg9sy9TbTqjY2bvJfgfC7aUmAfF", // SKYE — official coin, on Trade tab
  "6XByX9NXn1vvoyEYof6b6VEp6RVKGTKxdydurB6PoYtC", // HODL (original test) — hidden everywhere
  "652ZioC8L56aG51hoBLRsHsoqHnXPZU5FFseDS1EJkzK", // HODL (no on-chain metadata) — abandoned, will relaunch
]);

interface DiscoveredToken extends LaunchedTokenInfo {
  realSol: number;
  virtualSol: number;
  virtualToken: number;
  graduated: boolean;
}

function computeCurveBuy(vSol: number, vToken: number, solIn: number): number {
  const fee = solIn * 100 / 10000;
  const eff = solIn - fee;
  return Math.floor(eff * vToken / (vSol + eff));
}

// Mirrors `programs/skye-curve/src/instructions/swap.rs` sell branch + `math::compute_sell`
// + `math::split_sell_output`. User receives `sol_out_raw - fee` (exactly fee_bps).
// Treasury gets fee/2 separately, pool retains the other fee/2 — neither affects
// what the user receives.
function computeCurveSell(vSol: number, vToken: number, tokensIn: number): number {
  if (tokensIn <= 0 || vSol <= 0 || vToken <= 0) return 0;
  const rawOut = Math.floor((tokensIn * vSol) / (vToken + tokensIn));
  const fee = Math.floor((rawOut * 100) / 10000);
  return rawOut - fee;
}

export function DiscoverTab() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const solUsd = useSolPrice();
  const [tokens, setTokens] = useState<DiscoveredToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [trading, setTrading] = useState<string | null>(null);
  const [isBuy, setIsBuy] = useState(true);
  const [amount, setAmount] = useState("");
  const [swapPending, setSwapPending] = useState(false);
  const [swapResult, setSwapResult] = useState<{ sig: string; amount: number; symbol: string } | null>(null);
  const [swapError, setSwapError] = useState<string | null>(null);
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [tokenBalances, setTokenBalances] = useState<Record<string, number>>({});

  // Use shared balance hook via wallet context instead of independent polling
  // SOL balance is passed from parent or fetched once
  useEffect(() => {
    if (!publicKey) { setSolBalance(null); return; }
    connection.getBalance(publicKey).then(b => setSolBalance(b / LAMPORTS_PER_SOL)).catch(() => {});
  }, [connection, publicKey]);

  // Fetch token balance for a specific mint
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

  // Load tokens
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const stored = getStoredTokens();
        const sigs = await connection.getSignaturesForAddress(SKYE_CURVE_ID, { limit: 50 });

        // Batch fetch transactions instead of sequential
        const txResults = await Promise.allSettled(
          sigs.map(s => connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }))
        );

        const onChainMints: string[] = [];
        for (const result of txResults) {
          if (cancelled) break;
          if (result.status !== "fulfilled" || !result.value?.meta?.logMessages) continue;
          const logs = result.value.meta.logMessages;
          const l = logs.find(l => l.includes("Token launched:"));
          if (!l) continue;
          const m = l.match(/mint=([A-Za-z0-9]+)/);
          if (m && !EXCLUDED_MINTS.has(m[1])) onChainMints.push(m[1]);
        }

        const allMints = [...new Set([...stored.map(s => s.mint), ...onChainMints])].filter(m => !EXCLUDED_MINTS.has(m));

        // Batch fetch all curve PDAs at once using getMultipleAccountsInfo
        const curvePDAs = allMints.map(mintStr => {
          const mint = new PublicKey(mintStr);
          return PublicKey.findProgramAddressSync([Buffer.from("curve"), mint.toBuffer()], SKYE_CURVE_ID)[0];
        });
        const curveAccounts = await connection.getMultipleAccountsInfo(curvePDAs);

        const results: DiscoveredToken[] = [];
        for (let i = 0; i < allMints.length; i++) {
          const mintStr = allMints[i];
          const info = stored.find(s => s.mint === mintStr);
          const acct = curveAccounts[i];
          let realSol = 0, virtualSol = 0, virtualToken = 0, graduated = false, creatorOnChain = "";
          if (acct && acct.data.length >= 210) {
            // Creator is the first field after the 8-byte discriminator (32 bytes)
            creatorOnChain = new PublicKey(acct.data.slice(8, 40)).toBase58();
            virtualToken = Number(acct.data.readBigUInt64LE(168));
            virtualSol = Number(acct.data.readBigUInt64LE(176));
            realSol = Number(acct.data.readBigUInt64LE(184));
            graduated = acct.data[210] === 1;
          }

          results.push({
            mint: mintStr, name: info?.name || mintStr.slice(0, 6) + "...", symbol: info?.symbol || "???",
            image: info?.image || "", description: info?.description || "",
            website: info?.website || "", twitter: info?.twitter || "",
            telegram: info?.telegram || "", discord: info?.discord || "",
            curve: curvePDAs[i].toBase58(), creator: creatorOnChain || info?.creator || "",
            launchedAt: info?.launchedAt || 0, realSol, virtualSol, virtualToken, graduated,
          });
        }
        // Only show tokens that have supply in the curve (funded and tradeable)
        const tradeable = results.filter(t => t.virtualToken > 0 && t.virtualSol > 0);
        if (!cancelled) setTokens(tradeable);

        // Enrich asynchronously with on-chain Metaplex metadata. localStorage
        // only contains data for tokens this browser launched, so without this
        // step images of other people's tokens never appear on mobile.
        if (tradeable.length > 0) {
          fetchMetadataForMints(connection, tradeable.map(t => t.mint))
            .then(meta => {
              if (cancelled || meta.size === 0) return;
              setTokens(prev => prev.map(t => {
                const m = meta.get(t.mint);
                if (!m || !m.image) return t;
                return {
                  ...t,
                  image: t.image || m.image,
                  name: t.name && t.name !== t.mint.slice(0,6) + "..." ? t.name : (m.name || t.name),
                  symbol: t.symbol && t.symbol !== "???" ? t.symbol : (m.symbol || t.symbol),
                  description: t.description || m.description,
                };
              }));
            })
            .catch(() => {});
        }
      } catch {}
      if (!cancelled) setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [connection]);

  // Fetch balance when trading panel opens
  useEffect(() => {
    if (trading) fetchTokenBalance(trading);
  }, [trading, fetchTokenBalance]);

  async function handleSwap(token: DiscoveredToken) {
    if (!publicKey || !sendTransaction || !amount) return;
    setSwapPending(true);
    setSwapError(null);
    setSwapResult(null);

    try {
      // Creator buy limit: deployers can only buy max 2 SOL per swap on their own token
      if (isBuy && token.creator && publicKey.toBase58() === token.creator) {
        if (parseFloat(amount) > 2) {
          throw new Error("Creator buy limit: 2 SOL max per buy on your own token.");
        }
      }

      const TREASURY_WALLET = new PublicKey("5j5J5sMhwURJv1bdufDUypt29FeRnfv8GLpv53Cy1oxs");
      const mint = new PublicKey(token.mint);
      const [curvePDA] = PublicKey.findProgramAddressSync([Buffer.from("curve"), mint.toBuffer()], SKYE_CURVE_ID);
      const tokenReserve = getAssociatedTokenAddressSync(mint, curvePDA, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const solReserve = getAssociatedTokenAddressSync(NATIVE_MINT, curvePDA, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const treasuryWsol = getAssociatedTokenAddressSync(NATIVE_MINT, TREASURY_WALLET, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
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

      if (isBuy) {
        rawAmount = BigInt(Math.floor(amountNum * LAMPORTS_PER_SOL));
        estimatedOut = computeCurveBuy(token.virtualSol, token.virtualToken, amountNum * LAMPORTS_PER_SOL);
        tx.add(
          SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: userWsol, lamports: Number(rawAmount) }),
          createSyncNativeInstruction(userWsol, TOKEN_PROGRAM_ID),
        );
      } else {
        rawAmount = BigInt(Math.floor(amountNum * 1e9));
        estimatedOut = computeCurveSell(token.virtualSol, token.virtualToken, amountNum * 1e9);
      }

      const [configPDA] = PublicKey.findProgramAddressSync([Buffer.from("config"), mint.toBuffer()], SKYE_LADDER_ID);
      const [extraMetasPDA] = PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), mint.toBuffer()], SKYE_LADDER_ID);
      const [curveWR] = PublicKey.findProgramAddressSync([Buffer.from("wallet"), curvePDA.toBuffer(), mint.toBuffer()], SKYE_LADDER_ID);

      const senderWR = isBuy ? curveWR : buyerWR;
      const receiverWR = isBuy ? buyerWR : curveWR;

      const hookAccounts = [
        { pubkey: configPDA, isSigner: false, isWritable: false },
        { pubkey: senderWR, isSigner: false, isWritable: true },
        { pubkey: receiverWR, isSigner: false, isWritable: true },
        { pubkey: curvePDA, isSigner: false, isWritable: false },
        { pubkey: SKYE_LADDER_ID, isSigner: false, isWritable: false },
        { pubkey: extraMetasPDA, isSigner: false, isWritable: false },
      ];

      // Slippage protection: 5% tolerance
      const minOut = BigInt(Math.floor(estimatedOut * 0.95));

      const swapData = Buffer.alloc(8 + 8 + 8 + 1);
      swapData.set(SWAP_DISC, 0);
      swapData.writeBigUInt64LE(rawAmount, 8);
      swapData.writeBigUInt64LE(minOut, 16);
      swapData[24] = isBuy ? 1 : 0;

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
          ...hookAccounts,
        ],
        programId: SKYE_CURVE_ID,
        data: swapData,
      });

      // After sell: close WSOL ATA to unwrap back to native SOL
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
      // Refresh balances
      fetchTokenBalance(token.mint);
      connection.getBalance(publicKey).then(b => setSolBalance(b / LAMPORTS_PER_SOL)).catch(() => {});
    } catch (e: any) {
      setSwapError(e.message || "Swap failed");
      console.error("Curve swap error:", e);
    }
    setSwapPending(false);
  }

  return (
    <div className="space-y-6">
      <div className="glass p-4 text-center">
        <h2 className="font-pixel text-[14px] sm:text-[16px] text-skye-400 tracking-wide">DISCOVER</h2>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
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

        {tokens.map((t) => {
          const price = t.virtualToken > 0 ? t.virtualSol / t.virtualToken : 0;
          const mcSol = price * 1e9;
          const isTrading = trading === t.mint;
          const amountNum = parseFloat(amount) || 0;
          const bondPct = Math.min(100, (t.realSol / 1e9 / GRADUATION_SOL) * 100);
          const holding = tokenBalances[t.mint] || 0;

          let outputEstimate = "";
          if (isTrading && amountNum > 0 && t.virtualSol > 0) {
            if (isBuy) {
              const out = computeCurveBuy(t.virtualSol, t.virtualToken, amountNum * LAMPORTS_PER_SOL);
              outputEstimate = `~${(out / 1e9).toLocaleString(undefined, { maximumFractionDigits: 0 })} ${t.symbol}`;
            } else {
              const out = computeCurveSell(t.virtualSol, t.virtualToken, amountNum * 1e9);
              outputEstimate = `~${(out / LAMPORTS_PER_SOL).toFixed(6)} SOL (${formatUsd(out / LAMPORTS_PER_SOL * solUsd, 2)})`;
            }
          }

          return (
            <div key={t.mint} className="glass overflow-hidden">
              {/* Token header */}
              <div className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-white/3 transition"
                onClick={() => { setTrading(isTrading ? null : t.mint); setAmount(""); setSwapResult(null); setSwapError(null); setIsBuy(true); }}>
                <div className="w-11 h-11 rounded-xl overflow-hidden flex-shrink-0 bg-gradient-to-br from-skye-500/20 to-emerald-500/20 flex items-center justify-center">
                  {t.image ? <img src={t.image} alt="" className="w-full h-full object-cover" /> :
                    <span className="font-pixel text-[9px] text-skye-400">{t.symbol.slice(0, 2)}</span>}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[15px] font-bold text-ink-primary">{t.name}</span>
                    <span className="text-[11px] text-ink-faint">${t.symbol}</span>
                    {t.graduated && <span className="font-pixel text-[7px] bg-purple-500/20 text-purple-400 px-1.5 py-0.5 rounded">GRAD</span>}
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-ink-faint mt-0.5">
                    <span>{(t.realSol / 1e9).toFixed(2)} SOL</span>
                    {mcSol > 0 && <span>MC {formatUsd(mcSol * solUsd, 0)}</span>}
                  </div>
                </div>
                <span className={`text-[12px] font-semibold ${isTrading ? "text-skye-400" : "text-ink-faint"}`}>
                  {isTrading ? "Close" : "Trade"}
                </span>
              </div>

              {/* Bonding curve progress bar */}
              <div className="px-4 pb-2">
                <div className="flex justify-between text-[10px] text-ink-faint mb-1">
                  <span>Bonding curve</span>
                  <span>{bondPct.toFixed(1)}% — {GRADUATION_SOL} SOL to graduate</span>
                </div>
                <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-500" style={{
                    width: `${Math.max(bondPct, 1)}%`,
                    background: bondPct >= 100 ? "#a855f7" : "linear-gradient(90deg, #22c55e, #4ade80)",
                  }} />
                </div>
              </div>

              {/* Contract address — click to copy */}
              <div className="px-4 pb-3">
                <CopyableMint mint={t.mint} />
              </div>

              {/* Full swap panel */}
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
                      className={`flex-1 py-2.5 text-[13px] font-semibold rounded-lg transition min-h-[44px] ${isBuy ? "bg-white/10 text-ink-primary" : "text-ink-faint"}`}>Buy</button>
                    <button onClick={() => { setIsBuy(false); setAmount(""); setSwapResult(null); }}
                      className={`flex-1 py-2.5 text-[13px] font-semibold rounded-lg transition min-h-[44px] ${!isBuy ? "bg-white/10 text-ink-primary" : "text-ink-faint"}`}>Sell</button>
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

                  {/* Amount input */}
                  <div>
                    <div className="flex items-baseline gap-2">
                      <input type="number" placeholder="0.00" value={amount} onChange={e => { setAmount(e.target.value); setSwapResult(null); }}
                        className="flex-1 bg-transparent text-[22px] font-bold text-ink-primary outline-none min-w-0" />
                      <span className="text-[13px] font-semibold text-ink-faint">{isBuy ? "SOL" : t.symbol}</span>
                    </div>
                    {isBuy && amountNum > 0 && <p className="text-[11px] text-ink-faint mt-1">({formatUsd(amountNum * solUsd, 2)})</p>}
                  </div>

                  {/* Output estimate */}
                  {outputEstimate && (
                    <div className="bg-white/5 rounded-xl px-4 py-2.5 flex justify-between text-[13px]">
                      <span className="text-ink-faint">You receive</span>
                      <span className="text-ink-primary font-semibold">{outputEstimate}</span>
                    </div>
                  )}

                  {/* Swap button */}
                  {publicKey ? (
                    <button onClick={() => handleSwap(t)} disabled={swapPending || amountNum <= 0}
                      className={`w-full py-3.5 rounded-xl text-[14px] font-semibold text-white transition min-h-[48px] active:scale-[0.98] ${
                        swapPending ? "bg-white/10 cursor-wait" : isBuy ? "bg-skye-500/90 hover:bg-skye-500" : "bg-rose-500/90 hover:bg-rose-500"
                      } disabled:opacity-40`}>
                      {swapPending ? "Confirming..." : isBuy ? `Buy ${t.symbol}` : `Sell ${t.symbol}`}
                    </button>
                  ) : (
                    <p className="text-center text-[13px] text-ink-faint py-2">Connect wallet to trade</p>
                  )}

                  {/* Purchase confirmation */}
                  {swapResult && (
                    <div className="bg-skye-500/10 border border-skye-500/20 rounded-xl p-3 text-center space-y-1">
                      <p className="text-[14px] font-bold text-skye-400">
                        +{swapResult.amount.toLocaleString(undefined, {maximumFractionDigits: swapResult.symbol === "SOL" ? 6 : 0})} {swapResult.symbol}
                      </p>
                      <a href={`https://solscan.io/tx/${swapResult.sig}`} target="_blank" rel="noopener noreferrer"
                        className="text-[11px] text-skye-400/70 hover:underline">View on Solscan</a>
                    </div>
                  )}
                  {swapError && <p className="text-[11px] text-rose-400 text-center break-all">{swapError.length > 200 ? swapError.slice(0,200)+"..." : swapError}</p>}

                  <a href={`https://solscan.io/token/${t.mint}`} target="_blank" rel="noopener noreferrer"
                    className="text-[10px] text-ink-faint hover:text-ink-tertiary block text-center">{t.mint}</a>
                </div>
              )}
            </div>
          );
        })}
      </div>

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
        {copied ? "✓ Copied" : "Copy"}
      </span>
    </button>
  );
}
