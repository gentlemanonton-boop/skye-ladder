/**
 * test-restrictions.ts — The real restriction test.
 *
 * 1. Create 3 wallets, each buys 0.05 SOL (cheap entry)
 * 2. Main wallet buys 0.5 SOL to pump price well above entries
 * 3. Attempt sells from the 3 wallets — they're now in profit, restrictions should apply
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
const PRICE_SCALE = BigInt("1000000000000000000");

function getCurvePDA() { return PublicKey.findProgramAddressSync([Buffer.from("curve"), SKYE_MINT.toBuffer()], SKYE_CURVE_ID); }
function getConfigPDA() { return PublicKey.findProgramAddressSync([Buffer.from("config"), SKYE_MINT.toBuffer()], SKYE_LADDER_ID); }
function getExtraMetasPDA() { return PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), SKYE_MINT.toBuffer()], SKYE_LADDER_ID); }
function getWalletRecordPDA(wallet: PublicKey) { return PublicKey.findProgramAddressSync([Buffer.from("wallet"), wallet.toBuffer(), SKYE_MINT.toBuffer()], SKYE_LADDER_ID); }

function log(msg: string) { console.log(`  ${msg}`); }

async function sendTx(connection: Connection, w: Keypair, ixs: TransactionInstruction[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const vtx = new VersionedTransaction(new TransactionMessage({ payerKey: w.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  vtx.sign([w]);
  const sig = await connection.sendRawTransaction(vtx.serialize());
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

async function doBuy(connection: Connection, w: Keypair, solAmount: number, shared: any, ladderProgram: any): Promise<string> {
  const userToken = getAssociatedTokenAddressSync(SKYE_MINT, w.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, w.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const [buyerWR] = getWalletRecordPDA(w.publicKey);
  const ixs: TransactionInstruction[] = [];

  const [tokenInfo, wsolInfo, wrInfo] = await Promise.all([
    connection.getAccountInfo(userToken), connection.getAccountInfo(userWsol), connection.getAccountInfo(buyerWR),
  ]);
  if (!tokenInfo) ixs.push(createAssociatedTokenAccountInstruction(w.publicKey, userToken, w.publicKey, SKYE_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
  if (!wsolInfo) ixs.push(createAssociatedTokenAccountInstruction(w.publicKey, userWsol, w.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
  if (!wrInfo) {
    // @ts-ignore
    ixs.push(await ladderProgram.methods.createWalletRecord()
      .accounts({ payer: w.publicKey, wallet: w.publicKey, mint: SKYE_MINT, walletRecord: buyerWR, systemProgram: SystemProgram.programId }).instruction());
  }

  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  ixs.push(SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: userWsol, lamports }));
  ixs.push(createSyncNativeInstruction(userWsol, TOKEN_PROGRAM_ID));

  const hookAccounts = [
    { pubkey: shared.configPDA, isSigner: false, isWritable: false },
    { pubkey: shared.curveWR, isSigner: false, isWritable: true },
    { pubkey: buyerWR, isSigner: false, isWritable: true },
    { pubkey: shared.curvePDA, isSigner: false, isWritable: false },
    { pubkey: SKYE_LADDER_ID, isSigner: false, isWritable: false },
    { pubkey: shared.extraMetasPDA, isSigner: false, isWritable: false },
  ];

  const swapData = Buffer.alloc(25);
  swapData.set(SWAP_DISC, 0);
  swapData.writeBigUInt64LE(BigInt(lamports), 8);
  swapData.writeBigUInt64LE(0n, 16);
  swapData[24] = 1;

  ixs.push(new TransactionInstruction({
    keys: [
      { pubkey: w.publicKey, isSigner: true, isWritable: true },
      { pubkey: shared.curvePDA, isSigner: false, isWritable: true },
      { pubkey: SKYE_MINT, isSigner: false, isWritable: false },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: userToken, isSigner: false, isWritable: true },
      { pubkey: userWsol, isSigner: false, isWritable: true },
      { pubkey: shared.tokenReserve, isSigner: false, isWritable: true },
      { pubkey: shared.solReserve, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ...hookAccounts,
    ],
    programId: SKYE_CURVE_ID,
    data: swapData,
  }));

  return sendTx(connection, w, ixs);
}

function readCurvePrice(data: Buffer): bigint {
  const vToken = data.readBigUInt64LE(168);
  const vSol = data.readBigUInt64LE(176);
  return (vSol * PRICE_SCALE) / vToken;
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Skye Ladder — Sell Restriction Proof Test");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const mainWallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(process.env.HOME!, ".config/solana/id.json"), "utf-8"))));
  const connection = new Connection(RPC_URL, { commitment: "confirmed", confirmTransactionInitialTimeout: 60000 });

  const [curvePDA] = getCurvePDA();
  const [configPDA] = getConfigPDA();
  const [extraMetasPDA] = getExtraMetasPDA();
  const tokenReserve = getAssociatedTokenAddressSync(SKYE_MINT, curvePDA, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const solReserve = getAssociatedTokenAddressSync(NATIVE_MINT, curvePDA, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const [curveWR] = PublicKey.findProgramAddressSync([Buffer.from("wallet"), curvePDA.toBuffer(), SKYE_MINT.toBuffer()], SKYE_LADDER_ID);
  const shared = { curvePDA, configPDA, extraMetasPDA, tokenReserve, solReserve, curveWR };

  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(mainWallet), { commitment: "confirmed" });
  const ladderIdl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "skye_ladder.json"), "utf-8"));
  const ladderProgram = new anchor.Program(ladderIdl, provider);

  log(`Main wallet: ${(await connection.getBalance(mainWallet.publicKey) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  // Get initial price
  let curveData = (await connection.getAccountInfo(curvePDA))!.data;
  const priceBeforeBuys = readCurvePrice(curveData);
  log(`Price before: ${priceBeforeBuys.toString()}\n`);

  // ── Step 1: Create 3 wallets, small buys ──
  console.log("  [1/5] Creating 3 test wallets + small buys (0.04 SOL each)...\n");
  const testWallets: Keypair[] = [];
  const fundTx = new Transaction();
  for (let i = 0; i < 3; i++) {
    const w = Keypair.generate();
    testWallets.push(w);
    fundTx.add(SystemProgram.transfer({ fromPubkey: mainWallet.publicKey, toPubkey: w.publicKey, lamports: Math.floor(0.08 * LAMPORTS_PER_SOL) }));
  }
  await sendAndConfirmTransaction(connection, fundTx, [mainWallet]);

  for (let i = 0; i < testWallets.length; i++) {
    const sig = await doBuy(connection, testWallets[i], 0.04, shared, ladderProgram);
    const userToken = getAssociatedTokenAddressSync(SKYE_MINT, testWallets[i].publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const acct = await getAccount(connection, userToken, "confirmed", TOKEN_2022_PROGRAM_ID);
    log(`W${i + 1} bought ${(Number(acct.amount) / 1e9).toLocaleString()} SKYE @ 0.04 SOL`);
    await new Promise(r => setTimeout(r, 1500));
  }

  curveData = (await connection.getAccountInfo(curvePDA))!.data;
  const priceAfterSmallBuys = readCurvePrice(curveData);
  log(`\nPrice after small buys: ${priceAfterSmallBuys.toString()}`);

  // ── Step 2: Main wallet pumps with 0.5 SOL ──
  console.log("\n  [2/5] Main wallet pumping with 0.5 SOL...\n");

  // Ensure main wallet has WSOL ATA
  const mainWsol = getAssociatedTokenAddressSync(NATIVE_MINT, mainWallet.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const mainToken = getAssociatedTokenAddressSync(SKYE_MINT, mainWallet.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const pumpSig = await doBuy(connection, mainWallet, 0.5, shared, ladderProgram);
  const mainAcct = await getAccount(connection, mainToken, "confirmed", TOKEN_2022_PROGRAM_ID);
  log(`Main bought ${(Number(mainAcct.amount) / 1e9).toLocaleString()} SKYE @ 0.5 SOL | TX: ${pumpSig}`);

  curveData = (await connection.getAccountInfo(curvePDA))!.data;
  const priceAfterPump = readCurvePrice(curveData);
  log(`Price after pump: ${priceAfterPump.toString()}`);

  // ── Step 3: Read positions + multipliers ──
  console.log("\n  [3/5] Positions + multipliers...\n");

  for (let i = 0; i < testWallets.length; i++) {
    const [wrPDA] = getWalletRecordPDA(testWallets[i].publicKey);
    try {
      // @ts-ignore
      const wr = await ladderProgram.account.walletRecord.fetch(wrPDA);
      for (const p of wr.positions) {
        const ep = BigInt(p.entryPrice.toString());
        const mult = Number((priceAfterPump * 10000n) / ep) / 10000;
        log(`W${i + 1}: mult=${mult.toFixed(2)}x | ${(Number(p.tokenBalance) / 1e9).toLocaleString()} tokens | entry=${ep.toString()} | unlock=${p.unlockedBps}bps`);
      }
    } catch {}
  }

  // ── Step 4: Sell tests ──
  console.log("\n  [4/5] Sell restriction tests...\n");

  const sellTests = [
    { idx: 0, pct: 1.0, label: "W1: 100% dump" },
    { idx: 1, pct: 0.75, label: "W2: 75% sell" },
    { idx: 2, pct: 0.50, label: "W3: 50% sell" },
  ];

  for (const test of sellTests) {
    const w = testWallets[test.idx];
    const userToken = getAssociatedTokenAddressSync(SKYE_MINT, w.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, w.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const [buyerWR] = getWalletRecordPDA(w.publicKey);

    const acct = await getAccount(connection, userToken, "confirmed", TOKEN_2022_PROGRAM_ID);
    const sellAmount = BigInt(Math.floor(Number(acct.amount) * test.pct));
    log(`${test.label}: selling ${(Number(sellAmount) / 1e9).toLocaleString()} of ${(Number(acct.amount) / 1e9).toLocaleString()}`);

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

      const sig = await sendTx(connection, w, ixs);
      log(`  → SELL PASSED (+SOL) | TX: ${sig}`);
    } catch (e: any) {
      const logs: string[] = e.logs || [];
      if (logs.some((l: string) => l.includes("SellExceedsUnlocked"))) {
        log(`  → 🛡 REJECTED: SellExceedsUnlocked — LADDER WORKING!`);
      } else {
        log(`  → ✗ ERROR: ${(e.message || "").slice(0, 120)}`);
        logs.slice(-3).forEach((l: string) => log(`    ${l}`));
      }
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  // ── Step 5: Reclaim ──
  console.log("\n  [5/5] Reclaiming...");
  for (const w of testWallets) {
    try {
      const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, w.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      try { await getAccount(connection, wsol, "confirmed", TOKEN_PROGRAM_ID); await sendAndConfirmTransaction(connection, new Transaction().add(createCloseAccountInstruction(wsol, w.publicKey, w.publicKey, [], TOKEN_PROGRAM_ID)), [w]); } catch {}
      const bal = await connection.getBalance(w.publicKey);
      if (bal > 5000) await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: mainWallet.publicKey, lamports: bal - 5000 })), [w]);
    } catch {}
  }
  log(`Main wallet: ${((await connection.getBalance(mainWallet.publicKey)) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log("\n═══════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("\n  ✗ Failed:", err.message || err);
  if (err.logs) err.logs.slice(-5).forEach((l: string) => console.error(`    ${l}`));
  process.exit(1);
});
