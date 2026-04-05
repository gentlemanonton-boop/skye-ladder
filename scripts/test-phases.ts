/**
 * test-phases.ts — Test multiple ladder phases by pumping price progressively.
 *
 * 1. Create 1 test wallet, buy small (cheap entry)
 * 2. Main wallet pumps price to 2x, 3x, 5x of test wallet's entry
 * 3. At each level, attempt sells at various % to find the exact unlock boundary
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

async function sendTx(conn: Connection, w: Keypair, ixs: TransactionInstruction[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const vtx = new VersionedTransaction(new TransactionMessage({ payerKey: w.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  vtx.sign([w]);
  const sig = await conn.sendRawTransaction(vtx.serialize());
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

function readCurvePrice(data: Buffer): bigint {
  return (data.readBigUInt64LE(176) * PRICE_SCALE) / data.readBigUInt64LE(168);
}

function buildSwapIx(user: PublicKey, amount: bigint, buy: boolean, accounts: any): TransactionInstruction {
  const { curvePDA, tokenReserve, solReserve, configPDA, curveWR, extraMetasPDA, userToken, userWsol, buyerWR } = accounts;
  const senderWR = buy ? curveWR : buyerWR;
  const receiverWR = buy ? buyerWR : curveWR;
  const hookAccounts = [
    { pubkey: configPDA, isSigner: false, isWritable: false },
    { pubkey: senderWR, isSigner: false, isWritable: true },
    { pubkey: receiverWR, isSigner: false, isWritable: true },
    { pubkey: curvePDA, isSigner: false, isWritable: false },
    { pubkey: SKYE_LADDER_ID, isSigner: false, isWritable: false },
    { pubkey: extraMetasPDA, isSigner: false, isWritable: false },
  ];
  const swapData = Buffer.alloc(25);
  swapData.set(SWAP_DISC, 0);
  swapData.writeBigUInt64LE(amount, 8);
  swapData.writeBigUInt64LE(0n, 16);
  swapData[24] = buy ? 1 : 0;
  return new TransactionInstruction({
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
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
  });
}

async function tryBuy(conn: Connection, w: Keypair, solAmount: number, shared: any, ladderProgram: any) {
  const userToken = getAssociatedTokenAddressSync(SKYE_MINT, w.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, w.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const [buyerWR] = getWalletRecordPDA(w.publicKey);
  const ixs: TransactionInstruction[] = [];

  const [tI, wI, wrI] = await Promise.all([conn.getAccountInfo(userToken), conn.getAccountInfo(userWsol), conn.getAccountInfo(buyerWR)]);
  if (!tI) ixs.push(createAssociatedTokenAccountInstruction(w.publicKey, userToken, w.publicKey, SKYE_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
  if (!wI) ixs.push(createAssociatedTokenAccountInstruction(w.publicKey, userWsol, w.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
  // @ts-ignore
  if (!wrI) ixs.push(await ladderProgram.methods.createWalletRecord().accounts({ payer: w.publicKey, wallet: w.publicKey, mint: SKYE_MINT, walletRecord: buyerWR, systemProgram: SystemProgram.programId }).instruction());

  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  ixs.push(SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: userWsol, lamports }));
  ixs.push(createSyncNativeInstruction(userWsol, TOKEN_PROGRAM_ID));
  ixs.push(buildSwapIx(w.publicKey, BigInt(lamports), true, { ...shared, userToken, userWsol, buyerWR }));
  return sendTx(conn, w, ixs);
}

async function trySell(conn: Connection, w: Keypair, sellAmount: bigint, shared: any): Promise<{ passed: boolean; error?: string }> {
  const userToken = getAssociatedTokenAddressSync(SKYE_MINT, w.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, w.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const [buyerWR] = getWalletRecordPDA(w.publicKey);
  const ixs: TransactionInstruction[] = [];

  const wI = await conn.getAccountInfo(userWsol);
  if (!wI) ixs.push(createAssociatedTokenAccountInstruction(w.publicKey, userWsol, w.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
  ixs.push(buildSwapIx(w.publicKey, sellAmount, false, { ...shared, userToken, userWsol, buyerWR }));
  ixs.push(createCloseAccountInstruction(userWsol, w.publicKey, w.publicKey, [], TOKEN_PROGRAM_ID));

  try {
    await sendTx(conn, w, ixs);
    return { passed: true };
  } catch (e: any) {
    const logs: string[] = e.logs || [];
    if (logs.some((l: string) => l.includes("SellExceedsUnlocked"))) {
      return { passed: false, error: "SellExceedsUnlocked" };
    }
    return { passed: false, error: (e.message || "").slice(0, 100) };
  }
}

async function getMultiplier(conn: Connection, curvePDA: PublicKey, entryPrice: bigint): Promise<number> {
  const data = (await conn.getAccountInfo(curvePDA))!.data;
  const price = readCurvePrice(data);
  return Number((price * 10000n) / entryPrice) / 10000;
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Skye Ladder — Phase-by-Phase Restriction Test");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const mainWallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(process.env.HOME!, ".config/solana/id.json"), "utf-8"))));
  const conn = new Connection(RPC_URL, { commitment: "confirmed", confirmTransactionInitialTimeout: 60000 });

  const [curvePDA] = getCurvePDA();
  const [configPDA] = getConfigPDA();
  const [extraMetasPDA] = getExtraMetasPDA();
  const tokenReserve = getAssociatedTokenAddressSync(SKYE_MINT, curvePDA, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const solReserve = getAssociatedTokenAddressSync(NATIVE_MINT, curvePDA, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const [curveWR] = PublicKey.findProgramAddressSync([Buffer.from("wallet"), curvePDA.toBuffer(), SKYE_MINT.toBuffer()], SKYE_LADDER_ID);
  const shared = { curvePDA, configPDA, extraMetasPDA, tokenReserve, solReserve, curveWR };

  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(mainWallet), { commitment: "confirmed" });
  const ladderIdl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "skye_ladder.json"), "utf-8"));
  const ladderProgram = new anchor.Program(ladderIdl, provider);

  const mainBal = await conn.getBalance(mainWallet.publicKey);
  log(`Main wallet: ${(mainBal / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`);

  // ── Create test wallet + buy ──
  console.log("  [1] Test wallet buys at current price...\n");
  const testW = Keypair.generate();
  await sendAndConfirmTransaction(conn, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: mainWallet.publicKey, toPubkey: testW.publicKey, lamports: Math.floor(0.06 * LAMPORTS_PER_SOL) })
  ), [mainWallet]);

  await tryBuy(conn, testW, 0.02, shared, ladderProgram);
  const userToken = getAssociatedTokenAddressSync(SKYE_MINT, testW.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const acct = await getAccount(conn, userToken, "confirmed", TOKEN_2022_PROGRAM_ID);
  const totalTokens = acct.amount;
  log(`Test wallet bought ${(Number(totalTokens) / 1e9).toLocaleString()} SKYE`);

  // Read entry price
  const [wrPDA] = getWalletRecordPDA(testW.publicKey);
  // @ts-ignore
  const wr = await ladderProgram.account.walletRecord.fetch(wrPDA);
  const entryPrice = BigInt(wr.positions[0].entryPrice.toString());
  log(`Entry price: ${entryPrice.toString()}`);

  let mult = await getMultiplier(conn, curvePDA, entryPrice);
  log(`Current mult: ${mult.toFixed(2)}x\n`);

  // ── Pump with main wallet in stages and test sells ──
  const pumpAmounts = [0.1, 0.2, 0.3, 0.5];
  let pumpIdx = 0;

  const sellTests = [
    { pct: 1.00, label: "100%" },
    { pct: 0.75, label: "75%" },
    { pct: 0.50, label: "50%" },
    { pct: 0.25, label: "25%" },
    { pct: 0.10, label: "10%" },
  ];

  while (pumpIdx < pumpAmounts.length) {
    const pumpSol = pumpAmounts[pumpIdx];
    console.log(`  ──── Pumping +${pumpSol} SOL ────\n`);

    try {
      await tryBuy(conn, mainWallet, pumpSol, shared, ladderProgram);
    } catch (e: any) {
      log(`Pump failed: ${e.message?.slice(0, 100)}`);
      break;
    }
    await new Promise(r => setTimeout(r, 1500));

    mult = await getMultiplier(conn, curvePDA, entryPrice);
    log(`Mult after pump: ${mult.toFixed(2)}x\n`);

    // Try sells from test wallet at various %
    const currentAcct = await getAccount(conn, userToken, "confirmed", TOKEN_2022_PROGRAM_ID);
    const currentBalance = currentAcct.amount;

    if (currentBalance === 0n) {
      log("Test wallet has 0 tokens — done");
      break;
    }

    log(`Test wallet balance: ${(Number(currentBalance) / 1e9).toLocaleString()} SKYE`);
    log(`Testing sell limits at ${mult.toFixed(2)}x:\n`);

    for (const test of sellTests) {
      const sellAmt = BigInt(Math.floor(Number(currentBalance) * test.pct));
      if (sellAmt === 0n) continue;

      const result = await trySell(conn, testW, sellAmt, shared);
      const icon = result.passed ? "✓" : "🛡";
      const status = result.passed ? "ALLOWED" : `BLOCKED (${result.error})`;
      log(`  ${icon} ${test.label} (${(Number(sellAmt) / 1e9).toLocaleString()}) → ${status}`);

      if (result.passed) {
        // Sell went through — re-read balance and stop testing higher %
        log(`    Sold successfully — stopping further tests at this mult`);
        break;
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    console.log();
    pumpIdx++;
  }

  // ── Final state ──
  console.log("\n  ════ Final State ════\n");
  mult = await getMultiplier(conn, curvePDA, entryPrice);
  const finalAcct = await getAccount(conn, userToken, "confirmed", TOKEN_2022_PROGRAM_ID);
  // @ts-ignore
  const finalWr = await ladderProgram.account.walletRecord.fetch(wrPDA);
  log(`Mult: ${mult.toFixed(2)}x`);
  log(`Balance: ${(Number(finalAcct.amount) / 1e9).toLocaleString()} SKYE`);
  for (const p of finalWr.positions) {
    log(`Position: ${(Number(p.tokenBalance) / 1e9).toLocaleString()} tokens | unlock: ${p.unlockedBps} bps | sold_before_5x: ${p.soldBefore5x}`);
  }

  // Reclaim
  console.log("\n  Reclaiming...");
  try {
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, testW.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    try { await getAccount(conn, wsol, "confirmed", TOKEN_PROGRAM_ID); await sendAndConfirmTransaction(conn, new Transaction().add(createCloseAccountInstruction(wsol, testW.publicKey, testW.publicKey, [], TOKEN_PROGRAM_ID)), [testW]); } catch {}
    const bal = await conn.getBalance(testW.publicKey);
    if (bal > 5000) await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: testW.publicKey, toPubkey: mainWallet.publicKey, lamports: bal - 5000 })), [testW]);
  } catch {}
  log(`Main wallet: ${((await conn.getBalance(mainWallet.publicKey)) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log("\n═══════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("\n  ✗ Failed:", err.message || err);
  if (err.logs) err.logs.slice(-5).forEach((l: string) => console.error(`    ${l}`));
  process.exit(1);
});
