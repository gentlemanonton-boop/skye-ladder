/**
 * create-amm-pool.ts — Create the Skye AMM pool and configure everything
 *
 * Steps:
 *   1. Create SKYE reserve ATA, WSOL reserve ATA, and LP mint (client-side)
 *   2. Call initialize_pool on the AMM
 *   3. Update Skye Ladder config with new pool + price source addresses
 *   4. Update ExtraAccountMetaList to point to AMM pool PDA
 *   5. Add initial liquidity (small amount for testing)
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
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  createSyncNativeInstruction,
  createInitializeMintInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getMintLen,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

// ═══════════════════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════════════════

const SKYE_LADDER_PROGRAM_ID = new PublicKey("4THAwb6WSpDyyqMHnJL2VBjU7TCLfLLGC5jtuCiyX5Rz");
const SKYE_AMM_PROGRAM_ID = new PublicKey("GRBvJRRJfV3CzRLocGcr3NTptWQpu1G4nW9Jpff5TFoX");
const RPC_URL = execSync("solana config get | grep 'RPC URL' | awk '{print $NF}'", { encoding: "utf-8" }).trim();
const DECIMALS = 9;

// Initial liquidity: small amounts for testing
const INITIAL_SKYE = BigInt(100_000_000) * BigInt(10 ** DECIMALS); // 100M SKYE
const INITIAL_WSOL = BigInt(23_000_000); // 0.023 SOL (~$3K MC at SOL=$130)

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

function saveState(state: any) {
  const stateFile = path.join(__dirname, ".deploy-state.json");
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Skye AMM — Pool Creation & Configuration");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const wallet = loadKeypair("~/.config/solana/id.json");
  const connection = new Connection(RPC_URL, "confirmed");
  const state = loadState();
  const mintPubkey = new PublicKey(state.mint);

  console.log(`Wallet:   ${wallet.publicKey.toBase58()}`);
  console.log(`Mint:     ${mintPubkey.toBase58()}`);
  console.log(`Network:  ${RPC_URL}`);

  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`Balance:  ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`);

  // ── Derive Pool PDA ──
  const [poolPDA, poolBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), mintPubkey.toBuffer(), NATIVE_MINT.toBuffer()],
    SKYE_AMM_PROGRAM_ID,
  );
  console.log(`Pool PDA: ${poolPDA.toBase58()}`);

  const [lpAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp-authority"), poolPDA.toBuffer()],
    SKYE_AMM_PROGRAM_ID,
  );

  // ── Step 1: Create reserve ATAs and LP mint ──
  console.log("\n[1/5] Creating reserve accounts and LP mint...");

  // SKYE reserve ATA (Token-2022, owned by pool PDA)
  const skyeReserve = getAssociatedTokenAddressSync(
    mintPubkey, poolPDA, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  // WSOL reserve ATA (standard Token, owned by pool PDA)
  const wsolReserve = getAssociatedTokenAddressSync(
    NATIVE_MINT, poolPDA, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  console.log(`  SKYE reserve: ${skyeReserve.toBase58()}`);
  console.log(`  WSOL reserve: ${wsolReserve.toBase58()}`);

  // Create ATAs if they don't exist
  const skyeReserveInfo = await connection.getAccountInfo(skyeReserve);
  const wsolReserveInfo = await connection.getAccountInfo(wsolReserve);

  const setupTx = new Transaction();
  if (!skyeReserveInfo) {
    setupTx.add(createAssociatedTokenAccountInstruction(
      wallet.publicKey, skyeReserve, poolPDA, mintPubkey,
      TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ));
  }
  if (!wsolReserveInfo) {
    setupTx.add(createAssociatedTokenAccountInstruction(
      wallet.publicKey, wsolReserve, poolPDA, NATIVE_MINT,
      TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ));
  }

  // Create LP mint (standard Token program, authority = lpAuthority PDA)
  let lpMintKeypair: Keypair;
  let lpMintPubkey: PublicKey;

  if (state.ammLpMint) {
    lpMintPubkey = new PublicKey(state.ammLpMint);
    console.log(`  LP mint already exists: ${lpMintPubkey.toBase58()}`);
  } else {
    lpMintKeypair = Keypair.generate();
    lpMintPubkey = lpMintKeypair.publicKey;

    const mintLen = getMintLen([]);
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

    setupTx.add(
      SystemProgram.createAccount({
        fromPubkey: wallet.publicKey,
        newAccountPubkey: lpMintPubkey,
        space: mintLen,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(
        lpMintPubkey, DECIMALS, lpAuthority, null, TOKEN_PROGRAM_ID,
      ),
    );

    if (setupTx.instructions.length > 0) {
      const signers: Keypair[] = [wallet];
      if (lpMintKeypair!) signers.push(lpMintKeypair!);
      const sig = await sendAndConfirmTransaction(connection, setupTx, signers);
      console.log(`  Setup tx: ${sig}`);
    }

    state.ammLpMint = lpMintPubkey.toBase58();
    state.ammLpMintKeypair = Array.from(lpMintKeypair!.secretKey);
    saveState(state);
  }

  console.log(`  LP mint:      ${lpMintPubkey.toBase58()}`);

  // ── Step 2: Initialize AMM Pool ──
  console.log("\n[2/5] Initializing AMM pool...");

  const poolInfo = await connection.getAccountInfo(poolPDA);
  if (poolInfo) {
    console.log(`  Pool already initialized: ${poolPDA.toBase58()}`);
  } else {
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), { commitment: "confirmed" });
    const ammIdlPath = path.join(__dirname, "..", "target", "idl", "skye_amm.json");
    const ammIdl = JSON.parse(fs.readFileSync(ammIdlPath, "utf-8"));
    const ammProgram = new anchor.Program(ammIdl, provider);

    // @ts-ignore
    const sig = await ammProgram.methods
      .initializePool(100) // 1% fee
      .accounts({
        authority: wallet.publicKey,
        skyeMint: mintPubkey,
        wsolMint: NATIVE_MINT,
        pool: poolPDA,
        skyeReserve: skyeReserve,
        wsolReserve: wsolReserve,
        lpMint: lpMintPubkey,
        lpAuthority: lpAuthority,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log(`  Pool initialized! tx: ${sig}`);
  }

  state.ammPool = poolPDA.toBase58();
  state.ammSkyeReserve = skyeReserve.toBase58();
  state.ammWsolReserve = wsolReserve.toBase58();
  saveState(state);

  // ── Step 3: Update Skye Ladder config ──
  console.log("\n[3/5] Updating Skye Ladder config...");

  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), { commitment: "confirmed" });
  const ladderIdlPath = path.join(__dirname, "..", "target", "idl", "skye_ladder.json");
  const ladderIdl = JSON.parse(fs.readFileSync(ladderIdlPath, "utf-8"));
  const ladderProgram = new anchor.Program(ladderIdl, provider);

  const [configPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("config"), mintPubkey.toBuffer()],
    SKYE_LADDER_PROGRAM_ID,
  );

  try {
    // @ts-ignore
    const sig = await ladderProgram.methods
      .updatePool(skyeReserve, poolPDA) // pool = skyeReserve (for transfer classification), lb_pair = poolPDA (for price reading)
      .accounts({
        authority: wallet.publicKey,
        mint: mintPubkey,
        config: configPDA,
      })
      .rpc();
    console.log(`  Config updated! tx: ${sig}`);
  } catch (e: any) {
    console.error(`  Config update failed: ${e.message}`);
  }

  // ── Step 4: Update ExtraAccountMetaList ──
  console.log("\n[4/5] Updating ExtraAccountMetaList...");

  const [extraMetasPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mintPubkey.toBuffer()],
    SKYE_LADDER_PROGRAM_ID,
  );

  try {
    // @ts-ignore
    const sig = await ladderProgram.methods
      .updateExtraMetas()
      .accounts({
        authority: wallet.publicKey,
        mint: mintPubkey,
        config: configPDA,
        extraAccountMetaList: extraMetasPDA,
      })
      .rpc();
    console.log(`  ExtraMetas updated! tx: ${sig}`);
  } catch (e: any) {
    console.error(`  ExtraMetas update failed: ${e.message}`);
  }

  // ── Step 5: Pause hook, add initial liquidity, unpause ──
  console.log("\n[5/5] Adding initial liquidity...");
  console.log(`  SKYE: ${(Number(INITIAL_SKYE) / 10**DECIMALS).toLocaleString()} tokens`);
  console.log(`  WSOL: ${(Number(INITIAL_WSOL) / 10**DECIMALS).toFixed(6)} SOL`);

  // Pause the hook so initial liquidity can be added without sell restrictions
  try {
    // @ts-ignore
    const pauseSig = await ladderProgram.methods
      .setPaused(true)
      .accounts({ authority: wallet.publicKey, mint: mintPubkey, config: configPDA })
      .rpc();
    console.log(`  Hook paused: ${pauseSig}`);
  } catch (e: any) {
    console.log(`  Pause failed (may already be paused): ${e.message}`);
  }

  // Need user's WSOL account with wrapped SOL
  const userWsolATA = getAssociatedTokenAddressSync(
    NATIVE_MINT, wallet.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  // Create user WSOL ATA if needed, wrap SOL
  const userWsolInfo = await connection.getAccountInfo(userWsolATA);
  const wrapTx = new Transaction();
  if (!userWsolInfo) {
    wrapTx.add(createAssociatedTokenAccountInstruction(
      wallet.publicKey, userWsolATA, wallet.publicKey, NATIVE_MINT,
      TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ));
  }
  // Transfer SOL to WSOL account and sync
  wrapTx.add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: userWsolATA,
      lamports: Number(INITIAL_WSOL),
    }),
    createSyncNativeInstruction(userWsolATA, TOKEN_PROGRAM_ID),
  );
  const wrapSig = await sendAndConfirmTransaction(connection, wrapTx, [wallet]);
  console.log(`  Wrapped SOL: ${wrapSig}`);

  // User's LP token account
  const userLpATA = getAssociatedTokenAddressSync(
    lpMintPubkey, wallet.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const userLpInfo = await connection.getAccountInfo(userLpATA);
  if (!userLpInfo) {
    const createLpAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey, userLpATA, wallet.publicKey, lpMintPubkey,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    await sendAndConfirmTransaction(connection, createLpAtaTx, [wallet]);
    console.log(`  Created LP ATA: ${userLpATA.toBase58()}`);
  }

  // User's SKYE account (already exists from deploy)
  const userSkyeATA = new PublicKey(state.deployerATA);

  // Add liquidity via AMM
  const ammProvider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), { commitment: "confirmed" });
  const ammIdlPath2 = path.join(__dirname, "..", "target", "idl", "skye_amm.json");
  const ammIdl2 = JSON.parse(fs.readFileSync(ammIdlPath2, "utf-8"));
  const ammProgram = new anchor.Program(ammIdl2, ammProvider);

  // Resolve the exact extra accounts Token-2022 needs for the transfer hook
  // by using the SPL helper. This builds a dummy transfer instruction and
  // we extract the extra account keys from it.
  const resolvedIx = await createTransferCheckedWithTransferHookInstruction(
    connection,
    userSkyeATA,
    mintPubkey,
    skyeReserve,
    wallet.publicKey,
    INITIAL_SKYE,
    DECIMALS,
    [],
    "confirmed",
    TOKEN_2022_PROGRAM_ID,
  );

  // The resolved instruction has accounts beyond the standard 4 (source, mint, dest, authority).
  // Extract those extra accounts (index 4+) as remaining_accounts for our AMM CPI.
  const hookExtraAccounts = resolvedIx.keys.slice(4).map(k => ({
    pubkey: k.pubkey,
    isSigner: false, // none of these should be signers in CPI context
    isWritable: k.isWritable,
  }));

  console.log(`  Resolved ${hookExtraAccounts.length} hook extra accounts:`);
  hookExtraAccounts.forEach((a, i) => console.log(`    [${i}] ${a.pubkey.toBase58()} writable=${a.isWritable}`));

  try {
    // @ts-ignore
    const sig = await ammProgram.methods
      .addLiquidity(
        new anchor.BN(INITIAL_SKYE.toString()),
        new anchor.BN(INITIAL_WSOL.toString()),
        new anchor.BN(0), // min LP tokens (0 for initial deposit)
      )
      .accounts({
        user: wallet.publicKey,
        pool: poolPDA,
        skyeMint: mintPubkey,
        wsolMint: NATIVE_MINT,
        userSkyeAccount: userSkyeATA,
        userWsolAccount: userWsolATA,
        skyeReserve: skyeReserve,
        wsolReserve: wsolReserve,
        lpMint: lpMintPubkey,
        userLpAccount: userLpATA,
        lpAuthority: lpAuthority,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(hookExtraAccounts)
      .rpc();

    console.log(`  Liquidity added! tx: ${sig}`);
    state.ammLiquidityAdded = true;
    saveState(state);
  } catch (e: any) {
    console.error(`  Add liquidity failed: ${e.message}`);
    if (e.logs) {
      console.error("  Logs:");
      e.logs.forEach((l: string) => console.error(`    ${l}`));
    }
  }

  // Unpause the hook
  try {
    // @ts-ignore
    const unpauseSig = await ladderProgram.methods
      .setPaused(false)
      .accounts({ authority: wallet.publicKey, mint: mintPubkey, config: configPDA })
      .rpc();
    console.log(`  Hook unpaused: ${unpauseSig}`);
  } catch (e: any) {
    console.log(`  Unpause failed: ${e.message}`);
  }

  // ── Summary ──
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Deployment Summary");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Skye Ladder: ${SKYE_LADDER_PROGRAM_ID.toBase58()}`);
  console.log(`  Skye AMM:    ${SKYE_AMM_PROGRAM_ID.toBase58()}`);
  console.log(`  Mint:        ${mintPubkey.toBase58()}`);
  console.log(`  AMM Pool:    ${poolPDA.toBase58()}`);
  console.log(`  SKYE Reserve:${skyeReserve.toBase58()}`);
  console.log(`  WSOL Reserve:${wsolReserve.toBase58()}`);
  console.log(`  LP Mint:     ${lpMintPubkey.toBase58()}`);
  console.log(`  Config:      ${configPDA.toBase58()}`);
  console.log(`  ExtraMetas:  ${extraMetasPDA.toBase58()}`);
  console.log(`  Network:     ${RPC_URL}`);
}

main().catch(console.error);
