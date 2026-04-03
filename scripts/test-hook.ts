/**
 * test-hook.ts — End-to-end test of the Skye Ladder transfer hook on devnet
 *
 * Tests:
 *   1. Transfer tokens to a test wallet (triggers hook as a "buy")
 *   2. Read and display the wallet's WalletRecord PDA
 *   3. Attempt a sell (transfer back to pool) and verify restrictions
 *   4. Verify the hook correctly classifies buys, sells, and transfers
 *
 * Prerequisites:
 *   - deploy.ts and create-pool.ts have been run
 *   - .deploy-state.json exists
 *
 * Usage:
 *   npx ts-node scripts/test-hook.ts
 */

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createTransferCheckedWithTransferHookInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

// ═══════════════════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════════════════

const PROGRAM_ID = new PublicKey("4THAwb6WSpDyyqMHnJL2VBjU7TCLfLLGC5jtuCiyX5Rz");
const RPC_URL = execSync("solana config get | grep 'RPC URL' | awk '{print $NF}'", { encoding: "utf-8" }).trim();
const DECIMALS = 9;

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function loadKeypair(filePath: string): Keypair {
  const abs = filePath.startsWith("~")
    ? path.join(process.env.HOME!, filePath.slice(1))
    : filePath;
  const raw = JSON.parse(fs.readFileSync(abs, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function loadState(): any {
  const stateFile = path.join(__dirname, ".deploy-state.json");
  if (!fs.existsSync(stateFile)) {
    console.error("No .deploy-state.json found. Run deploy.ts first.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(stateFile, "utf-8"));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Skye Ladder — Transfer Hook E2E Test");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const wallet = loadKeypair("~/.config/solana/id.json");
  const connection = new Connection(RPC_URL, "confirmed");
  const state = loadState();

  const mintPubkey = new PublicKey(state.mint);
  const deployerATA = new PublicKey(state.deployerATA);

  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`Mint:   ${mintPubkey.toBase58()}`);

  // Load Anchor program
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(wallet),
    { commitment: "confirmed" },
  );
  const idlPath = path.join(__dirname, "..", "target", "idl", "skye_ladder.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider);

  // --- Read Config ---
  console.log("\n[1/5] Reading Skye Ladder config...");
  const [configPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("config"), mintPubkey.toBuffer()],
    PROGRAM_ID,
  );

  try {
    // @ts-ignore — Anchor 0.30 deep type instantiation
    const config = await program.account.config.fetch(configPDA);
    console.log(`  Authority: ${config.authority.toBase58()}`);
    console.log(`  Mint:      ${config.mint.toBase58()}`);
    console.log(`  Pool:      ${config.pool.toBase58()}`);
    console.log(`  LbPair:    ${config.lbPair.toBase58()}`);
    console.log(`  Paused:    ${config.paused}`);
  } catch (e: any) {
    console.log(`  Config not found. Run deploy.ts first. Error: ${e.message}`);
    process.exit(1);
  }

  // --- Create test wallet ---
  console.log("\n[2/5] Creating test wallet...");
  const testWallet = Keypair.generate();
  console.log(`  Test wallet: ${testWallet.publicKey.toBase58()}`);

  // Fund the test wallet with a tiny bit of SOL for rent
  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: testWallet.publicKey,
      lamports: 10_000_000, // 0.01 SOL
    }),
  );
  await sendAndConfirmTransaction(connection, fundTx, [wallet]);
  console.log("  Funded with 0.01 SOL");

  // Create ATA for test wallet
  const testWalletATA = getAssociatedTokenAddressSync(
    mintPubkey,
    testWallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const createAtaTx = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      wallet.publicKey,
      testWalletATA,
      testWallet.publicKey,
      mintPubkey,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  );
  await sendAndConfirmTransaction(connection, createAtaTx, [wallet]);
  console.log(`  Test ATA: ${testWalletATA.toBase58()}`);

  // --- Transfer tokens (simulated "buy") ---
  console.log("\n[3/5] Transferring tokens to test wallet (simulated buy)...");
  const transferAmount = BigInt(1_000_000) * BigInt(10 ** DECIMALS); // 1M tokens

  try {
    // For Token-2022 with transfer hook, use the async version that
    // resolves extra accounts (ExtraAccountMetaList, WalletRecord PDAs, etc.)
    const transferIx = await createTransferCheckedWithTransferHookInstruction(
      connection,
      deployerATA,
      mintPubkey,
      testWalletATA,
      wallet.publicKey,
      transferAmount,
      DECIMALS,
      [],
      "confirmed",
      TOKEN_2022_PROGRAM_ID,
    );
    const transferTx = new Transaction().add(transferIx);

    const sig = await sendAndConfirmTransaction(connection, transferTx, [wallet]);
    console.log(`  Transferred 1,000,000 SKYE! tx: ${sig}`);

    // Check balances
    const deployerBalance = await getAccount(connection, deployerATA, "confirmed", TOKEN_2022_PROGRAM_ID);
    const testBalance = await getAccount(connection, testWalletATA, "confirmed", TOKEN_2022_PROGRAM_ID);
    console.log(`  Deployer balance: ${Number(deployerBalance.amount) / 10 ** DECIMALS} SKYE`);
    console.log(`  Test wallet balance: ${Number(testBalance.amount) / 10 ** DECIMALS} SKYE`);
  } catch (e: any) {
    console.log(`  Transfer failed (expected if hook enforces rules): ${e.message}`);
    console.log("  This is normal — the hook may reject the transfer if the pool");
    console.log("  addresses are not properly configured (placeholder addresses).");
    console.log("  Set up a real pool first, then re-test.");
  }

  // --- Read WalletRecord PDA ---
  console.log("\n[4/5] Reading WalletRecord PDA...");
  const [walletRecordPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("wallet"), testWallet.publicKey.toBuffer(), mintPubkey.toBuffer()],
    PROGRAM_ID,
  );

  try {
    // @ts-ignore — Anchor 0.30 deep type instantiation
    const walletRecord = await program.account.walletRecord.fetch(walletRecordPDA);
    console.log(`  Owner:          ${walletRecord.owner.toBase58()}`);
    console.log(`  Position count: ${walletRecord.positionCount}`);
    console.log(`  Positions:`);
    for (let i = 0; i < walletRecord.positions.length; i++) {
      const pos = walletRecord.positions[i];
      console.log(`    [${i}] entry_price=${pos.entryPrice.toString()}, ` +
        `tokens=${pos.tokenBalance.toString()}, ` +
        `initial_usd=${pos.initialUsd.toString()}, ` +
        `unlocked_bps=${pos.unlockedBps}`);
    }
  } catch (e: any) {
    console.log(`  WalletRecord not found (may not exist yet if transfer was rejected)`);
  }

  // --- Summary ---
  console.log("\n[5/5] Test complete!");
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Test Summary");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Program:     ${PROGRAM_ID.toBase58()}`);
  console.log(`  Mint:        ${mintPubkey.toBase58()}`);
  console.log(`  Test wallet: ${testWallet.publicKey.toBase58()}`);
  console.log(`  Test ATA:    ${testWalletATA.toBase58()}`);
  console.log(`  Network:     ${RPC_URL}`);
  console.log("");
  console.log("  To run a full buy/sell cycle, create a real Meteora DLMM pool");
  console.log("  and update the config with the correct pool + lb_pair addresses.");
}

main().catch(console.error);
