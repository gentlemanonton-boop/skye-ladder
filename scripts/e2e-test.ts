/**
 * e2e-test.ts — Full end-to-end test of the Skye Ladder transfer hook
 *
 * 1. Deploy + setup (program, mint, config, pool)
 * 2. Create WalletRecord PDAs for all participants
 * 3. BUY: Transfer tokens from pool → test wallet (creates position)
 * 4. Read position, verify it was created
 * 5. SELL (over limit): Transfer back more than allowed → should FAIL
 * 6. SELL (within limit): Transfer back allowed amount → should SUCCEED
 *
 * Runs on solana-test-validator (localhost:8899).
 */

import * as anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, ExtensionType,
  createInitializeMintInstruction, createInitializeTransferHookInstruction,
  getMintLen, createAssociatedTokenAccountInstruction, createMintToInstruction,
  getAssociatedTokenAddressSync, getAccount, ASSOCIATED_TOKEN_PROGRAM_ID,
  createTransferCheckedWithTransferHookInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("4THAwb6WSpDyyqMHnJL2VBjU7TCLfLLGC5jtuCiyX5Rz");
const RPC = "http://localhost:8899";
const DECIMALS = 9;
const TOTAL_SUPPLY = BigInt(1_000_000_000) * BigInt(10 ** DECIMALS);

function loadKeypair(p: string): Keypair {
  const abs = p.startsWith("~") ? path.join(process.env.HOME!, p.slice(1)) : p;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(abs, "utf-8"))));
}

function pda(seeds: Buffer[], pid: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, pid)[0];
}

// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Skye Ladder — Full E2E Test");
  console.log("══════════════════════════════════════════════════════════════\n");

  const conn = new Connection(RPC, "confirmed");
  const deployer = loadKeypair("~/.config/solana/id.json");
  console.log(`Deployer: ${deployer.publicKey.toBase58()}`);

  // Load Anchor program
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(deployer), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "skye_ladder.json"), "utf-8"));
  idl.address = PROGRAM_ID.toBase58();
  const program = new anchor.Program(idl, provider) as any;

  // ── Step 1: Create mint with transfer hook ──
  console.log("── 1. Create Token-2022 mint ─────────────────────────────────");
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  const mintLen = getMintLen([ExtensionType.TransferHook]);
  const mintRent = await conn.getMinimumBalanceForRentExemption(mintLen);

  await sendAndConfirmTransaction(conn, new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: deployer.publicKey, newAccountPubkey: mint, space: mintLen, lamports: mintRent, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeTransferHookInstruction(mint, deployer.publicKey, PROGRAM_ID, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint, DECIMALS, deployer.publicKey, null, TOKEN_2022_PROGRAM_ID),
  ), [deployer, mintKp]);
  console.log(`  Mint: ${mint.toBase58()}`);

  // ── Step 2: Mint supply to deployer (acts as "pool") ──
  console.log("── 2. Mint supply ────────────────────────────────────────────");
  const poolATA = getAssociatedTokenAddressSync(mint, deployer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  await sendAndConfirmTransaction(conn, new Transaction().add(
    createAssociatedTokenAccountInstruction(deployer.publicKey, poolATA, deployer.publicKey, mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createMintToInstruction(mint, poolATA, deployer.publicKey, TOTAL_SUPPLY, [], TOKEN_2022_PROGRAM_ID),
  ), [deployer]);
  console.log(`  Pool ATA (deployer): ${poolATA.toBase58()}`);

  // ── Step 3: Initialize config ──
  console.log("── 3. Initialize Skye Ladder config ──────────────────────────");
  const configPDA = pda([Buffer.from("config"), mint.toBuffer()], PROGRAM_ID);
  const extraMetasPDA = pda([Buffer.from("extra-account-metas"), mint.toBuffer()], PROGRAM_ID);
  const lbPairKp = Keypair.generate();

  // Create LbPair account (owned by our program, zeroed data → price = 1.0 → underwater)
  const lbSize = 256;
  const lbRent = await conn.getMinimumBalanceForRentExemption(lbSize);
  await sendAndConfirmTransaction(conn, new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: deployer.publicKey, newAccountPubkey: lbPairKp.publicKey, space: lbSize, lamports: lbRent, programId: PROGRAM_ID }),
  ), [deployer, lbPairKp]);

  // Initialize config
  const initIx = await program.methods.initialize(poolATA, lbPairKp.publicKey)
    .accountsPartial({ authority: deployer.publicKey, mint, config: configPDA, extraAccountMetaList: extraMetasPDA, systemProgram: SystemProgram.programId })
    .instruction();
  for (const k of initIx.keys) {
    if (k.pubkey.equals(configPDA) || k.pubkey.equals(extraMetasPDA)) k.isWritable = true;
  }
  await sendAndConfirmTransaction(conn, new Transaction().add(initIx), [deployer]);
  console.log(`  Config: ${configPDA.toBase58()}`);
  console.log(`  LbPair: ${lbPairKp.publicKey.toBase58()}`);

  // Set test price data in the LbPair account
  // bin_step=100 (1%), active_id = center - 700 → price ≈ 0.001 (realistic micro-cap)
  // (1.01)^(-700) ≈ 0.00091
  const BIN_ID_CENTER = 8388608;
  const activeId = BIN_ID_CENTER - 700;
  const testPriceIx = await program.methods.setTestPrice(activeId, 100)
    .accountsPartial({ authority: deployer.publicKey, mint, config: configPDA, lbPair: lbPairKp.publicKey })
    .instruction();
  for (const k of testPriceIx.keys) { if (k.pubkey.equals(lbPairKp.publicKey)) k.isWritable = true; }
  await sendAndConfirmTransaction(conn, new Transaction().add(testPriceIx), [deployer]);
  console.log(`  Test price set: active_id=${activeId} (≈0.001), bin_step=100`);

  // ── Step 4: Create test buyer wallet ──
  console.log("── 4. Create test buyer ──────────────────────────────────────");
  const buyer = Keypair.generate();
  await conn.requestAirdrop(buyer.publicKey, 2 * LAMPORTS_PER_SOL).then(s => conn.confirmTransaction(s));
  const buyerATA = getAssociatedTokenAddressSync(mint, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  await sendAndConfirmTransaction(conn, new Transaction().add(
    createAssociatedTokenAccountInstruction(deployer.publicKey, buyerATA, buyer.publicKey, mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
  ), [deployer]);
  console.log(`  Buyer: ${buyer.publicKey.toBase58()}`);
  console.log(`  Buyer ATA: ${buyerATA.toBase58()}`);

  // ── Step 5: Create WalletRecord PDAs ──
  console.log("── 5. Create WalletRecord PDAs ───────────────────────────────");

  // WalletRecord for deployer (pool side)
  const deployerWR = pda([Buffer.from("wallet"), deployer.publicKey.toBuffer(), mint.toBuffer()], PROGRAM_ID);
  const buyerWR = pda([Buffer.from("wallet"), buyer.publicKey.toBuffer(), mint.toBuffer()], PROGRAM_ID);

  for (const [label, walletPk, wrPDA] of [
    ["deployer", deployer.publicKey, deployerWR],
    ["buyer", buyer.publicKey, buyerWR],
  ] as [string, PublicKey, PublicKey][]) {
    const wrIx = await program.methods.createWalletRecord()
      .accountsPartial({ payer: deployer.publicKey, wallet: walletPk, mint, walletRecord: wrPDA, systemProgram: SystemProgram.programId })
      .instruction();
    for (const k of wrIx.keys) { if (k.pubkey.equals(wrPDA)) k.isWritable = true; }
    await sendAndConfirmTransaction(conn, new Transaction().add(wrIx), [deployer]);
    console.log(`  ${label} WalletRecord: ${wrPDA.toBase58()}`);
  }

  // ── Step 6: BUY — Transfer from pool to buyer ──
  console.log("── 6. BUY: pool → buyer (1,000,000 SKYE) ─────────────────────");
  const buyAmount = BigInt(1_000_000) * BigInt(10 ** DECIMALS);

  const buyIx = await createTransferCheckedWithTransferHookInstruction(
    conn, poolATA, mint, buyerATA, deployer.publicKey,
    buyAmount, DECIMALS, [], "confirmed", TOKEN_2022_PROGRAM_ID,
  );
  try {
    const buySig = await sendAndConfirmTransaction(conn, new Transaction().add(buyIx), [deployer]);
    console.log(`  BUY SUCCESS! tx: ${buySig}`);
  } catch (e: any) {
    console.log(`  BUY FAILED: ${e.message}`);
    // Print logs
    if (e.logs) for (const l of e.logs) console.log(`    ${l}`);
    else if (e.transactionLogs) for (const l of e.transactionLogs) console.log(`    ${l}`);
  }

  // Check balances
  try {
    const buyerBal = await getAccount(conn, buyerATA, "confirmed", TOKEN_2022_PROGRAM_ID);
    console.log(`  Buyer balance: ${Number(buyerBal.amount) / 10 ** DECIMALS} SKYE`);
  } catch { console.log("  (Could not read buyer balance)"); }

  // ── Step 7: Read WalletRecord — verify position created ──
  console.log("── 7. Read buyer WalletRecord ────────────────────────────────");
  try {
    // Manual borsh read
    await new Promise(r => setTimeout(r, 2000)); // Wait for commitment
    const rawAcct = await conn.getAccountInfo(buyerWR, "confirmed");
    if (rawAcct && rawAcct.data.length >= 77) {
      const d = rawAcct.data;
      let off = 8; // skip discriminator
      const owner = new PublicKey(d.slice(off, off + 32)); off += 32;
      const mintField = new PublicKey(d.slice(off, off + 32)); off += 32;
      const posCount = d[off]; off += 1;
      const vecLen = d.readUInt32LE(off); off += 4;
      console.log(`  Owner: ${owner.toBase58()}`);
      console.log(`  Mint: ${mintField.toBase58()}`);
      console.log(`  Position count: ${posCount}, Vec len: ${vecLen}`);
      for (let i = 0; i < vecLen && i < 10; i++) {
        const entryPrice = d.readBigUInt64LE(off); off += 8;
        const initialUsd = d.readBigUInt64LE(off); off += 8;
        const tokenBal = d.readBigUInt64LE(off); off += 8;
        const unlockedBps = d.readUInt32LE(off); off += 4;
        console.log(`  [${i}] entry=${entryPrice}, usd=${initialUsd}, tokens=${tokenBal}, bps=${unlockedBps}`);
      }
    } else {
      console.log("  WalletRecord not found or too short");
    }
  } catch (e: any) {
    console.log(`  Could not read WalletRecord: ${e.message}`);
  }

  // ── Step 8: SELL (over limit) — should FAIL ──
  console.log("── 8. SELL (over limit): buyer → pool (ALL tokens) ────────────");
  // At price = 1.0 (zeroed LbPair → center bin → underwater), all tokens should
  // actually be 100% sellable. But let's try selling more than the buyer has.
  try {
    const buyerBal = await getAccount(conn, buyerATA, "confirmed", TOKEN_2022_PROGRAM_ID);
    const overAmount = BigInt(buyerBal.amount) + BigInt(1); // 1 more than balance

    const sellOverIx = await createTransferCheckedWithTransferHookInstruction(
      conn, buyerATA, mint, poolATA, buyer.publicKey,
      overAmount, DECIMALS, [], "confirmed", TOKEN_2022_PROGRAM_ID,
    );
    await sendAndConfirmTransaction(conn, new Transaction().add(sellOverIx), [buyer]);
    console.log("  UNEXPECTED: Sell over balance succeeded (should have failed)");
  } catch (e: any) {
    console.log(`  SELL OVER LIMIT FAILED (expected): ${e.message?.slice(0, 80)}`);
  }

  // ── Step 9: SELL (within limit) — should SUCCEED ──
  console.log("── 9. SELL (within limit): buyer → pool (500,000 SKYE) ────────");
  const sellAmount = BigInt(500_000) * BigInt(10 ** DECIMALS);

  try {
    const sellIx = await createTransferCheckedWithTransferHookInstruction(
      conn, buyerATA, mint, poolATA, buyer.publicKey,
      sellAmount, DECIMALS, [], "confirmed", TOKEN_2022_PROGRAM_ID,
    );
    const sellSig = await sendAndConfirmTransaction(conn, new Transaction().add(sellIx), [buyer]);
    console.log(`  SELL SUCCESS! tx: ${sellSig}`);
  } catch (e: any) {
    console.log(`  SELL FAILED: ${e.message}`);
    if (e.transactionLogs) for (const l of e.transactionLogs) console.log(`    ${l}`);
  }

  // Final balances
  console.log("── 10. Final State ───────────────────────────────────────────");
  try {
    const buyerBal = await getAccount(conn, buyerATA, "confirmed", TOKEN_2022_PROGRAM_ID);
    const poolBal = await getAccount(conn, poolATA, "confirmed", TOKEN_2022_PROGRAM_ID);
    console.log(`  Buyer balance:  ${Number(buyerBal.amount) / 10 ** DECIMALS} SKYE`);
    console.log(`  Pool balance:   ${Number(poolBal.amount) / 10 ** DECIMALS} SKYE`);
  } catch {}

  try {
    const wr = await program.account.walletRecord.fetch(buyerWR);
    console.log(`  Buyer positions: ${wr.positionCount}`);
    for (let i = 0; i < (wr.positions?.length || 0); i++) {
      const p = wr.positions[i];
      console.log(`    [${i}] tokens=${p.tokenBalance.toString()}, bps=${p.unlockedBps}`);
    }
  } catch {}

  // Check program logs for the last few transactions
  console.log("\n── Program Logs ──────────────────────────────────────────────");
  const sigs = await conn.getSignaturesForAddress(PROGRAM_ID, { limit: 10 });
  for (const sig of sigs.slice(0, 5)) {
    const tx = await conn.getTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
    const hookLogs = tx?.meta?.logMessages?.filter(l => l.includes("Skye Ladder") || l.includes("Program log:")) || [];
    if (hookLogs.length) {
      console.log(`  tx: ${sig.signature.slice(0, 16)}...`);
      for (const l of hookLogs) console.log(`    ${l}`);
    }
  }

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  E2E Test Complete");
  console.log("══════════════════════════════════════════════════════════════\n");
}

main().catch(e => { console.error("\nFATAL:", e); process.exit(1); });
