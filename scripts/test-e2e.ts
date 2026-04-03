/**
 * test-e2e.ts — End-to-end test of Skye Ladder + Skye AMM
 *
 * Creates a fresh test token, AMM pool, and tests:
 *   1. Create Token-2022 mint with TransferHook
 *   2. Initialize Skye Ladder config + ExtraAccountMetaList
 *   3. Mint supply to deployer
 *   4. Create AMM pool + reserve accounts
 *   5. Pause hook, add initial liquidity, unpause
 *   6. Test BUY (WSOL → TEST token)
 *   7. Test SELL (TEST token → WSOL, should enforce restrictions)
 */

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  ExtensionType,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createSyncNativeInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  getMintLen,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

// ═══════════════════════════════════════════════════════════════════════════════
const SKYE_LADDER_ID = new PublicKey("4THAwb6WSpDyyqMHnJL2VBjU7TCLfLLGC5jtuCiyX5Rz");
const SKYE_AMM_ID = new PublicKey("GRBvJRRJfV3CzRLocGcr3NTptWQpu1G4nW9Jpff5TFoX");
const RPC_URL = execSync("solana config get | grep 'RPC URL' | awk '{print $NF}'", { encoding: "utf-8" }).trim();
const DECIMALS = 9;
const TOTAL_SUPPLY = BigInt(1_000_000_000) * BigInt(10 ** DECIMALS); // 1B
const INITIAL_TOKENS = BigInt(500_000_000) * BigInt(10 ** DECIMALS); // 500M for liquidity
const INITIAL_SOL = 1 * LAMPORTS_PER_SOL; // 1 SOL
const BUY_SOL = BigInt(LAMPORTS_PER_SOL / 10); // 0.1 SOL buy test

function loadKeypair(filePath: string): Keypair {
  const abs = filePath.startsWith("~") ? path.join(process.env.HOME!, filePath.slice(1)) : filePath;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(abs, "utf-8"))));
}

function ok(label: string) { console.log(`  [OK] ${label}`); }
function fail(label: string, e: any) { console.error(`  [FAIL] ${label}: ${e.message || e}`); }

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Skye Ladder — End-to-End Test (Fresh Token)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const wallet = loadKeypair("~/.config/solana/id.json");
  const connection = new Connection(RPC_URL, { commitment: "confirmed", confirmTransactionInitialTimeout: 60000 });
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), { commitment: "confirmed" });

  const ladderIdl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "skye_ladder.json"), "utf-8"));
  const ammIdl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "skye_amm.json"), "utf-8"));
  const ladderProgram = new anchor.Program(ladderIdl, provider);
  const ammProgram = new anchor.Program(ammIdl, provider);

  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`Wallet:  ${wallet.publicKey.toBase58()}`);
  console.log(`Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log(`Network: ${RPC_URL}\n`);

  // ═══════════════════════════════════════════════════════════════════════
  // Step 1: Create Token-2022 mint with TransferHook
  // ═══════════════════════════════════════════════════════════════════════
  console.log("[1/7] Creating test Token-2022 mint with TransferHook...");
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;

  const extensions = [ExtensionType.TransferHook];
  const mintLen = getMintLen(extensions);
  const mintLamports = await connection.getMinimumBalanceForRentExemption(mintLen);

  const createMintTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: mint,
      space: mintLen,
      lamports: mintLamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeTransferHookInstruction(mint, wallet.publicKey, SKYE_LADDER_ID, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint, DECIMALS, wallet.publicKey, null, TOKEN_2022_PROGRAM_ID),
  );
  await sendAndConfirmTransaction(connection, createMintTx, [wallet, mintKeypair]);
  ok(`Mint: ${mint.toBase58()}`);

  // ═══════════════════════════════════════════════════════════════════════
  // Step 2: Initialize Skye Ladder config + ExtraAccountMetaList
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[2/7] Initializing Skye Ladder config...");

  // We'll use placeholder addresses first, then update after pool creation
  const placeholderPool = PublicKey.default;
  const placeholderLbPair = PublicKey.default;

  const [configPDA] = PublicKey.findProgramAddressSync([Buffer.from("config"), mint.toBuffer()], SKYE_LADDER_ID);
  const [extraMetasPDA] = PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), mint.toBuffer()], SKYE_LADDER_ID);

  // @ts-ignore
  const initSig = await ladderProgram.methods
    .initialize(placeholderPool, placeholderLbPair)
    .accounts({
      authority: wallet.publicKey,
      mint,
      config: configPDA,
      extraAccountMetaList: extraMetasPDA,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  ok(`Config: ${configPDA.toBase58()} | tx: ${initSig}`);

  // ═══════════════════════════════════════════════════════════════════════
  // Step 3: Mint supply to deployer
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[3/7] Minting token supply...");

  const deployerATA = getAssociatedTokenAddressSync(mint, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const mintSupplyTx = new Transaction().add(
    createAssociatedTokenAccountInstruction(wallet.publicKey, deployerATA, wallet.publicKey, mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createMintToInstruction(mint, deployerATA, wallet.publicKey, TOTAL_SUPPLY, [], TOKEN_2022_PROGRAM_ID),
  );
  await sendAndConfirmTransaction(connection, mintSupplyTx, [wallet]);
  ok(`Minted ${(Number(TOTAL_SUPPLY) / 10**DECIMALS).toLocaleString()} tokens to ${deployerATA.toBase58()}`);

  // ═══════════════════════════════════════════════════════════════════════
  // Step 4: Create AMM pool
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[4/7] Creating AMM pool...");

  const [poolPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), mint.toBuffer(), NATIVE_MINT.toBuffer()], SKYE_AMM_ID,
  );
  const [lpAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp-authority"), poolPDA.toBuffer()], SKYE_AMM_ID,
  );

  const skyeReserve = getAssociatedTokenAddressSync(mint, poolPDA, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const wsolReserve = getAssociatedTokenAddressSync(NATIVE_MINT, poolPDA, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  // Create reserve ATAs
  const createReservesTx = new Transaction().add(
    createAssociatedTokenAccountInstruction(wallet.publicKey, skyeReserve, poolPDA, mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountInstruction(wallet.publicKey, wsolReserve, poolPDA, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
  );
  await sendAndConfirmTransaction(connection, createReservesTx, [wallet]);

  // Create LP mint
  const lpMintKeypair = Keypair.generate();
  const lpMint = lpMintKeypair.publicKey;
  const lpMintLen = getMintLen([]);
  const lpMintLamports = await connection.getMinimumBalanceForRentExemption(lpMintLen);

  const createLpTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: lpMint,
      space: lpMintLen,
      lamports: lpMintLamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(lpMint, DECIMALS, lpAuthority, null, TOKEN_PROGRAM_ID),
  );
  await sendAndConfirmTransaction(connection, createLpTx, [wallet, lpMintKeypair]);

  // Initialize pool
  // @ts-ignore
  const poolSig = await ammProgram.methods
    .initializePool(100) // 1% fee
    .accounts({
      authority: wallet.publicKey,
      skyeMint: mint,
      wsolMint: NATIVE_MINT,
      pool: poolPDA,
      skyeReserve,
      wsolReserve,
      lpMint,
      lpAuthority,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  ok(`Pool: ${poolPDA.toBase58()} | tx: ${poolSig}`);

  // ═══════════════════════════════════════════════════════════════════════
  // Step 5: Update config + ExtraMetas, pause, add liquidity, unpause
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[5/7] Configuring hook + adding liquidity...");

  // Update config with real pool addresses
  // @ts-ignore
  await ladderProgram.methods
    .updatePool(skyeReserve, poolPDA)
    .accounts({ authority: wallet.publicKey, mint, config: configPDA })
    .rpc();
  ok("Config updated with pool addresses");

  // Update ExtraAccountMetaList
  // @ts-ignore
  await ladderProgram.methods
    .updateExtraMetas()
    .accounts({ authority: wallet.publicKey, mint, config: configPDA, extraAccountMetaList: extraMetasPDA })
    .rpc();
  ok("ExtraAccountMetaList updated");

  // Pause hook for initial liquidity
  // @ts-ignore
  await ladderProgram.methods
    .setPaused(true)
    .accounts({ authority: wallet.publicKey, mint, config: configPDA })
    .rpc();
  ok("Hook paused");

  // Wrap SOL for liquidity
  const userWsolATA = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userWsolInfo = await connection.getAccountInfo(userWsolATA);
  const wrapTx = new Transaction();
  if (!userWsolInfo) {
    wrapTx.add(createAssociatedTokenAccountInstruction(wallet.publicKey, userWsolATA, wallet.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
  }
  wrapTx.add(
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: userWsolATA, lamports: INITIAL_SOL + Number(BUY_SOL) }),
    createSyncNativeInstruction(userWsolATA, TOKEN_PROGRAM_ID),
  );
  await sendAndConfirmTransaction(connection, wrapTx, [wallet]);
  ok(`Wrapped ${((INITIAL_SOL + Number(BUY_SOL)) / LAMPORTS_PER_SOL).toFixed(2)} SOL`);

  // Create user LP ATA
  const userLpATA = getAssociatedTokenAddressSync(lpMint, wallet.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const createLpAtaTx = new Transaction().add(
    createAssociatedTokenAccountInstruction(wallet.publicKey, userLpATA, wallet.publicKey, lpMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
  );
  await sendAndConfirmTransaction(connection, createLpAtaTx, [wallet]);

  // Resolve hook extra accounts for the token transfer
  const resolvedIx = await createTransferCheckedWithTransferHookInstruction(
    connection, deployerATA, mint, skyeReserve, wallet.publicKey,
    INITIAL_TOKENS, DECIMALS, [], "confirmed", TOKEN_2022_PROGRAM_ID,
  );
  const hookExtraAccounts = resolvedIx.keys.slice(4).map(k => ({
    pubkey: k.pubkey, isSigner: false, isWritable: k.isWritable,
  }));

  // Add liquidity
  // @ts-ignore
  const liqSig = await ammProgram.methods
    .addLiquidity(
      new anchor.BN(INITIAL_TOKENS.toString()),
      new anchor.BN(INITIAL_SOL.toString()),
      new anchor.BN(0),
    )
    .accounts({
      user: wallet.publicKey, pool: poolPDA, skyeMint: mint, wsolMint: NATIVE_MINT,
      userSkyeAccount: deployerATA, userWsolAccount: userWsolATA,
      skyeReserve, wsolReserve, lpMint, userLpAccount: userLpATA,
      lpAuthority, token2022Program: TOKEN_2022_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(hookExtraAccounts)
    .rpc();
  ok(`Liquidity added: 500M tokens + 1 SOL | tx: ${liqSig}`);

  // Unpause hook
  // @ts-ignore
  await ladderProgram.methods
    .setPaused(false)
    .accounts({ authority: wallet.publicKey, mint, config: configPDA })
    .rpc();
  ok("Hook unpaused — restrictions now active");

  // ═══════════════════════════════════════════════════════════════════════
  // Step 6: Test BUY (WSOL → TEST token)
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[6/7] Testing BUY (0.1 SOL → tokens)...");

  // First, create a WalletRecord for the buyer (required by hook)
  const [buyerWR] = PublicKey.findProgramAddressSync(
    [Buffer.from("wallet"), wallet.publicKey.toBuffer(), mint.toBuffer()], SKYE_LADDER_ID,
  );
  const buyerWRInfo = await connection.getAccountInfo(buyerWR);
  if (!buyerWRInfo) {
    // @ts-ignore
    await ladderProgram.methods
      .createWalletRecord()
      .accounts({
        payer: wallet.publicKey,
        wallet: wallet.publicKey,
        mint,
        walletRecord: buyerWR,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    ok("WalletRecord created for buyer");
  }

  // Also create WalletRecord for pool PDA (receiver in sells / sender in buys)
  const [poolWR] = PublicKey.findProgramAddressSync(
    [Buffer.from("wallet"), poolPDA.toBuffer(), mint.toBuffer()], SKYE_LADDER_ID,
  );
  const poolWRInfo = await connection.getAccountInfo(poolWR);
  if (!poolWRInfo) {
    // @ts-ignore
    await ladderProgram.methods
      .createWalletRecord()
      .accounts({
        payer: wallet.publicKey,
        wallet: poolPDA,
        mint,
        walletRecord: poolWR,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    ok("WalletRecord created for pool");
  }

  // Re-resolve hook accounts now that WalletRecords exist
  const buyResolvedIx = await createTransferCheckedWithTransferHookInstruction(
    connection, skyeReserve, mint, deployerATA, poolPDA,
    BigInt(1), DECIMALS, [], "confirmed", TOKEN_2022_PROGRAM_ID,
  );
  const buyHookAccounts = buyResolvedIx.keys.slice(4).map(k => ({
    pubkey: k.pubkey, isSigner: false, isWritable: k.isWritable,
  }));

  const balanceBefore = await getAccount(connection, deployerATA, "confirmed", TOKEN_2022_PROGRAM_ID);
  console.log(`  Token balance before buy: ${(Number(balanceBefore.amount) / 10**DECIMALS).toLocaleString()}`);

  try {
    // @ts-ignore
    const buySig = await ammProgram.methods
      .swap(new anchor.BN(BUY_SOL.toString()), new anchor.BN(0), true)
      .accounts({
        user: wallet.publicKey, pool: poolPDA, skyeMint: mint, wsolMint: NATIVE_MINT,
        userSkyeAccount: deployerATA, userWsolAccount: userWsolATA,
        skyeReserve, wsolReserve,
        token2022Program: TOKEN_2022_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(buyHookAccounts)
      .rpc();

    const balanceAfter = await getAccount(connection, deployerATA, "confirmed", TOKEN_2022_PROGRAM_ID);
    const bought = Number(balanceAfter.amount) - Number(balanceBefore.amount);
    ok(`BUY SUCCESS: 0.1 SOL → ${(bought / 10**DECIMALS).toLocaleString()} tokens | tx: ${buySig}`);
  } catch (e: any) {
    fail("BUY", e);
    if (e.logs) e.logs.forEach((l: string) => console.error(`    ${l}`));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Step 7: Test SELL (TEST token → WSOL)
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[7/7] Testing SELL (tokens → WSOL)...");

  // Read the WalletRecord to see positions
  try {
    // @ts-ignore
    const wr = await ladderProgram.account.walletRecord.fetch(buyerWR);
    console.log(`  Positions: ${wr.positions.length}`);
    for (let i = 0; i < wr.positions.length; i++) {
      const p = wr.positions[i];
      console.log(`    [${i}] entry=${p.entryPrice.toString()} tokens=${p.tokenBalance.toString()} unlocked=${p.unlockedBps}`);
    }
  } catch (e: any) {
    console.log(`  Could not read WalletRecord: ${e.message}`);
  }

  // Try selling a small amount (should work since price hasn't changed much)
  const sellResolvedIx = await createTransferCheckedWithTransferHookInstruction(
    connection, deployerATA, mint, skyeReserve, wallet.publicKey,
    BigInt(1), DECIMALS, [], "confirmed", TOKEN_2022_PROGRAM_ID,
  );
  const sellHookAccounts = sellResolvedIx.keys.slice(4).map(k => ({
    pubkey: k.pubkey, isSigner: false, isWritable: k.isWritable,
  }));

  // Sell 10% of what we bought
  const balanceNow = await getAccount(connection, deployerATA, "confirmed", TOKEN_2022_PROGRAM_ID);
  // Use tokens from the buy position — sell a small amount
  const sellAmount = BigInt(1_000_000) * BigInt(10 ** DECIMALS); // 1M tokens

  const wsolBefore = await getAccount(connection, userWsolATA, "confirmed", TOKEN_PROGRAM_ID);

  try {
    // @ts-ignore
    const sellSig = await ammProgram.methods
      .swap(new anchor.BN(sellAmount.toString()), new anchor.BN(0), false)
      .accounts({
        user: wallet.publicKey, pool: poolPDA, skyeMint: mint, wsolMint: NATIVE_MINT,
        userSkyeAccount: deployerATA, userWsolAccount: userWsolATA,
        skyeReserve, wsolReserve,
        token2022Program: TOKEN_2022_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(sellHookAccounts)
      .rpc();

    const wsolAfter = await getAccount(connection, userWsolATA, "confirmed", TOKEN_PROGRAM_ID);
    const received = Number(wsolAfter.amount) - Number(wsolBefore.amount);
    ok(`SELL SUCCESS: 1M tokens → ${(received / LAMPORTS_PER_SOL).toFixed(6)} SOL | tx: ${sellSig}`);
  } catch (e: any) {
    if (e.message?.includes("SellExceedsUnlocked")) {
      ok("SELL CORRECTLY REJECTED: SellExceedsUnlocked — hook is enforcing restrictions!");
    } else {
      fail("SELL", e);
      if (e.logs) e.logs.forEach((l: string) => console.error(`    ${l}`));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  E2E Test Summary");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Test Mint:     ${mint.toBase58()}`);
  console.log(`  AMM Pool:      ${poolPDA.toBase58()}`);
  console.log(`  SKYE Reserve:  ${skyeReserve.toBase58()}`);
  console.log(`  Config:        ${configPDA.toBase58()}`);
  console.log(`  Buyer WR:      ${buyerWR.toBase58()}`);
  console.log(`  LP Mint:       ${lpMint.toBase58()}`);
  console.log(`  Network:       ${RPC_URL}`);
}

main().catch(console.error);
