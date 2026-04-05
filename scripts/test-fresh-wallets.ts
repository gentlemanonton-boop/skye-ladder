/**
 * test-fresh-wallets.ts — Create 5 FRESH wallets (no prior positions),
 * fund them, buy to pump price, then test sell restrictions.
 *
 * This tests the fix to pool_price.rs with clean state.
 */

import * as anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
  LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, NATIVE_MINT,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction, createCloseAccountInstruction,
  getAccount, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const SKYE_MINT = new PublicKey("5GtUWP1x4LpKjAzGBZg9sy9TbTqjY2bvJfgfC7aUmAfF");
const SKYE_LADDER_ID = new PublicKey("4THAwb6WSpDyyqMHnJL2VBjU7TCLfLLGC5jtuCiyX5Rz");
const SKYE_CURVE_ID = new PublicKey("5bxtpbYgiMQMJcB1c2cWXGErsiRmAZeyRqRKCXoeZRXf");
const SWAP_DISC = new Uint8Array([248, 198, 158, 145, 225, 117, 135, 200]);
const DECIMALS = 9;
const RPC_URL = "https://api.mainnet-beta.solana.com";

const NUM_WALLETS = 5;
const SOL_PER_WALLET = 0.12;
const BUY_SOL = 0.08;

function getCurvePDA() { return PublicKey.findProgramAddressSync([Buffer.from("curve"), SKYE_MINT.toBuffer()], SKYE_CURVE_ID); }
function getConfigPDA() { return PublicKey.findProgramAddressSync([Buffer.from("config"), SKYE_MINT.toBuffer()], SKYE_LADDER_ID); }
function getExtraMetasPDA() { return PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), SKYE_MINT.toBuffer()], SKYE_LADDER_ID); }
function getWalletRecordPDA(wallet: PublicKey) { return PublicKey.findProgramAddressSync([Buffer.from("wallet"), wallet.toBuffer(), SKYE_MINT.toBuffer()], SKYE_LADDER_ID); }

function log(msg: string) { console.log(`  ${msg}`); }

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

async function sendTx(connection: Connection, w: Keypair, ixs: TransactionInstruction[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: w.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  vtx.sign([w]);
  const sig = await connection.sendRawTransaction(vtx.serialize());
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Skye Ladder — Fresh Wallet Test (Post-Fix)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const mainWallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(process.env.HOME!, ".config/solana/id.json"), "utf-8"))));
  const connection = new Connection(RPC_URL, { commitment: "confirmed", confirmTransactionInitialTimeout: 60000 });

  const [curvePDA] = getCurvePDA();
  const [configPDA] = getConfigPDA();
  const [extraMetasPDA] = getExtraMetasPDA();
  const tokenReserve = getAssociatedTokenAddressSync(SKYE_MINT, curvePDA, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const solReserve = getAssociatedTokenAddressSync(NATIVE_MINT, curvePDA, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const [curveWR] = PublicKey.findProgramAddressSync([Buffer.from("wallet"), curvePDA.toBuffer(), SKYE_MINT.toBuffer()], SKYE_LADDER_ID);

  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(mainWallet), { commitment: "confirmed" });
  const ladderIdl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "skye_ladder.json"), "utf-8"));
  const ladderProgram = new anchor.Program(ladderIdl, provider);

  const balance = await connection.getBalance(mainWallet.publicKey);
  log(`Main wallet: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`);

  // ══════════════════════════════════════════════════
  // STEP 1: Generate + fund fresh wallets
  // ══════════════════════════════════════════════════
  console.log(`  [1/4] Creating ${NUM_WALLETS} fresh wallets + funding ${SOL_PER_WALLET} SOL each...\n`);
  const wallets: Keypair[] = [];
  const fundTx = new Transaction();
  for (let i = 0; i < NUM_WALLETS; i++) {
    const w = Keypair.generate();
    wallets.push(w);
    fundTx.add(SystemProgram.transfer({ fromPubkey: mainWallet.publicKey, toPubkey: w.publicKey, lamports: Math.floor(SOL_PER_WALLET * LAMPORTS_PER_SOL) }));
    log(`W${i + 1}: ${w.publicKey.toBase58()}`);
  }
  await sendAndConfirmTransaction(connection, fundTx, [mainWallet]);
  log("Funded!\n");

  // ══════════════════════════════════════════════════
  // STEP 2: All wallets buy
  // ══════════════════════════════════════════════════
  console.log(`  [2/4] All wallets buying with ${BUY_SOL} SOL...\n`);

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    try {
      const userToken = getAssociatedTokenAddressSync(SKYE_MINT, w.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, w.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const [buyerWR] = getWalletRecordPDA(w.publicKey);

      const ixs: TransactionInstruction[] = [];
      ixs.push(createAssociatedTokenAccountInstruction(w.publicKey, userToken, w.publicKey, SKYE_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
      ixs.push(createAssociatedTokenAccountInstruction(w.publicKey, userWsol, w.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));

      // @ts-ignore
      ixs.push(await ladderProgram.methods.createWalletRecord()
        .accounts({ payer: w.publicKey, wallet: w.publicKey, mint: SKYE_MINT, walletRecord: buyerWR, systemProgram: SystemProgram.programId })
        .instruction());

      const buyLamports = Math.floor(BUY_SOL * LAMPORTS_PER_SOL);
      ixs.push(SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: userWsol, lamports: buyLamports }));
      ixs.push(createSyncNativeInstruction(userWsol, TOKEN_PROGRAM_ID));

      const hookAccounts = [
        { pubkey: configPDA, isSigner: false, isWritable: false },
        { pubkey: curveWR, isSigner: false, isWritable: true },
        { pubkey: buyerWR, isSigner: false, isWritable: true },
        { pubkey: curvePDA, isSigner: false, isWritable: false },
        { pubkey: SKYE_LADDER_ID, isSigner: false, isWritable: false },
        { pubkey: extraMetasPDA, isSigner: false, isWritable: false },
      ];

      const swapData = Buffer.alloc(25);
      swapData.set(SWAP_DISC, 0);
      swapData.writeBigUInt64LE(BigInt(buyLamports), 8);
      swapData.writeBigUInt64LE(0n, 16);
      swapData[24] = 1;

      ixs.push(new TransactionInstruction({
        keys: [
          { pubkey: w.publicKey, isSigner: true, isWritable: true },
          { pubkey: curvePDA, isSigner: false, isWritable: true },
          { pubkey: SKYE_MINT, isSigner: false, isWritable: false },
          { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
          { pubkey: userToken, isSigner: false, isWritable: true },
          { pubkey: userWsol, isSigner: false, isWritable: true },
          { pubkey: tokenReserve, isSigner: false, isWritable: true },
          { pubkey: solReserve, isSigner: false, isWritable: true },
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ...hookAccounts,
        ],
        programId: SKYE_CURVE_ID,
        data: swapData,
      }));

      const sig = await sendTx(connection, w, ixs);
      const acct = await getAccount(connection, userToken, "confirmed", TOKEN_2022_PROGRAM_ID);
      log(`✓ W${i + 1} bought ${(Number(acct.amount) / 1e9).toLocaleString()} SKYE | TX: ${sig}`);
    } catch (e: any) {
      log(`✗ W${i + 1} failed: ${e.message?.slice(0, 150)}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  // ══════════════════════════════════════════════════
  // STEP 3: Read positions — verify correct entry_price
  // ══════════════════════════════════════════════════
  console.log(`\n  [3/4] Reading positions (verifying correct entry_price)...\n`);

  const PRICE_SCALE = BigInt("1000000000000000000");
  const curveInfo = await connection.getAccountInfo(curvePDA);
  const vToken = curveInfo!.data.readBigUInt64LE(168);
  const vSol = curveInfo!.data.readBigUInt64LE(176);
  const currentOnChainPrice = (vSol * PRICE_SCALE) / vToken;
  log(`Current on-chain price: ${currentOnChainPrice.toString()}`);
  log(`Human: ${(Number(vSol) / Number(vToken)).toExponential(4)} SOL/token\n`);

  interface WalletInfo { wallet: Keypair; idx: number; tokens: bigint }
  const walletInfos: WalletInfo[] = [];

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const [wrPDA] = getWalletRecordPDA(w.publicKey);
    try {
      // @ts-ignore
      const wr = await ladderProgram.account.walletRecord.fetch(wrPDA);
      for (const p of wr.positions) {
        const ep = BigInt(p.entryPrice.toString());
        const mult = Number((currentOnChainPrice * 10000n) / ep) / 10000;
        const isCorrectScale = ep < 1000000000000n; // correct prices are ~3.9e10, buggy were ~1.4e18
        log(`W${i + 1}: entry=${ep.toString()} | mult=${mult.toFixed(2)}x | ${(Number(p.tokenBalance) / 1e9).toLocaleString()} tokens | unlock=${p.unlockedBps}bps | correct_scale=${isCorrectScale ? "YES ✓" : "NO ✗"}`);
        walletInfos.push({ wallet: w, idx: i + 1, tokens: BigInt(p.tokenBalance.toString()) });
      }
    } catch (e: any) {
      log(`W${i + 1}: no WalletRecord`);
    }
  }

  // ══════════════════════════════════════════════════
  // STEP 4: Sell tests in random order
  // ══════════════════════════════════════════════════
  console.log(`\n  [4/4] Sell restriction tests (random order)...\n`);

  const sellTests = [
    { pct: 1.0, label: "100% dump" },
    { pct: 0.75, label: "75% sell" },
    { pct: 0.50, label: "50% sell" },
    { pct: 0.25, label: "25% sell" },
    { pct: 0.05, label: "5% sell" },
  ];

  const shuffled = shuffle(walletInfos);
  log(`Random order: ${shuffled.map(w => `W${w.idx}`).join(" → ")}\n`);

  for (let t = 0; t < shuffled.length; t++) {
    const { wallet: w, idx, tokens } = shuffled[t];
    const test = sellTests[t];
    console.log(`  ════ W${idx}: ${test.label} ════`);

    if (tokens === 0n) { log("0 tokens, skip\n"); continue; }

    const userToken = getAssociatedTokenAddressSync(SKYE_MINT, w.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, w.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const [buyerWR] = getWalletRecordPDA(w.publicKey);

    let actualBalance: bigint;
    try {
      const acct = await getAccount(connection, userToken, "confirmed", TOKEN_2022_PROGRAM_ID);
      actualBalance = acct.amount;
    } catch { log("no token account\n"); continue; }

    const sellAmount = BigInt(Math.floor(Number(actualBalance) * test.pct));
    log(`Balance: ${(Number(actualBalance) / 1e9).toLocaleString()} | Selling: ${(Number(sellAmount) / 1e9).toLocaleString()} (${(test.pct * 100)}%)`);

    try {
      const ixs: TransactionInstruction[] = [];
      const wsolInfo = await connection.getAccountInfo(userWsol);
      if (!wsolInfo) ixs.push(createAssociatedTokenAccountInstruction(w.publicKey, userWsol, w.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));

      const hookAccounts = [
        { pubkey: configPDA, isSigner: false, isWritable: false },
        { pubkey: buyerWR, isSigner: false, isWritable: true },
        { pubkey: curveWR, isSigner: false, isWritable: true },
        { pubkey: curvePDA, isSigner: false, isWritable: false },
        { pubkey: SKYE_LADDER_ID, isSigner: false, isWritable: false },
        { pubkey: extraMetasPDA, isSigner: false, isWritable: false },
      ];

      const swapData = Buffer.alloc(25);
      swapData.set(SWAP_DISC, 0);
      swapData.writeBigUInt64LE(sellAmount, 8);
      swapData.writeBigUInt64LE(0n, 16);
      swapData[24] = 0;

      ixs.push(new TransactionInstruction({
        keys: [
          { pubkey: w.publicKey, isSigner: true, isWritable: true },
          { pubkey: curvePDA, isSigner: false, isWritable: true },
          { pubkey: SKYE_MINT, isSigner: false, isWritable: false },
          { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
          { pubkey: userToken, isSigner: false, isWritable: true },
          { pubkey: userWsol, isSigner: false, isWritable: true },
          { pubkey: tokenReserve, isSigner: false, isWritable: true },
          { pubkey: solReserve, isSigner: false, isWritable: true },
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ...hookAccounts,
        ],
        programId: SKYE_CURVE_ID,
        data: swapData,
      }));
      ixs.push(createCloseAccountInstruction(userWsol, w.publicKey, w.publicKey, [], TOKEN_PROGRAM_ID));

      const solBefore = await connection.getBalance(w.publicKey);
      const sig = await sendTx(connection, w, ixs);
      const solAfter = await connection.getBalance(w.publicKey);
      log(`✓ SELL PASSED: +${((solAfter - solBefore) / LAMPORTS_PER_SOL).toFixed(6)} SOL | TX: ${sig}\n`);
    } catch (e: any) {
      const msg = e.message || "";
      const logs: string[] = e.logs || [];
      if (msg.includes("SellExceedsUnlocked") || logs.some((l: string) => l.includes("SellExceedsUnlocked"))) {
        log(`🛡 REJECTED: SellExceedsUnlocked — LADDER IS WORKING!\n`);
      } else {
        log(`✗ ERROR: ${msg.slice(0, 150)}`);
        logs.slice(-5).forEach((l: string) => log(`  ${l}`));
        console.log();
      }
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  // Reclaim SOL
  console.log("  ════ Reclaiming SOL ════\n");
  for (const w of wallets) {
    try {
      const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, w.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      try { await getAccount(connection, wsol, "confirmed", TOKEN_PROGRAM_ID); const tx = new Transaction().add(createCloseAccountInstruction(wsol, w.publicKey, w.publicKey, [], TOKEN_PROGRAM_ID)); await sendAndConfirmTransaction(connection, tx, [w]); } catch {}
      const bal = await connection.getBalance(w.publicKey);
      if (bal > 5000) {
        const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: mainWallet.publicKey, lamports: bal - 5000 }));
        await sendAndConfirmTransaction(connection, tx, [w]);
      }
    } catch {}
  }
  const finalBal = await connection.getBalance(mainWallet.publicKey);
  log(`Main wallet: ${(finalBal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  console.log("\n═══════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("\n  ✗ Failed:", err.message || err);
  if (err.logs) err.logs.slice(-5).forEach((l: string) => console.error(`    ${l}`));
  process.exit(1);
});
