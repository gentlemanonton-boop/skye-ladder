/**
 * deploy.ts — Deploy Skye Ladder
 *
 * Steps:
 *   1. Deploy the program (if not already deployed)
 *   2. Create Token-2022 mint with transfer hook extension
 *   3. Initialize the Skye Ladder config + ExtraAccountMetaList
 *
 * Prerequisites:
 *   - `solana config set --url <cluster>` (e.g. mainnet-beta, devnet)
 *   - Wallet with ≥4 SOL at ~/.config/solana/id.json
 *   - Program .so at target/deploy/skye_ladder.so
 *
 * Usage:
 *   npx ts-node scripts/deploy.ts
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
  ExtensionType,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  getMintLen,
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
const TOTAL_SUPPLY = 1_000_000_000; // 1B tokens (human-readable)

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

function findPDA(seeds: Buffer[], programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

async function airdropIfNeeded(connection: Connection, pubkey: PublicKey, minSol: number) {
  const balance = await connection.getBalance(pubkey);
  const solBalance = balance / 1e9;
  console.log(`  Wallet balance: ${solBalance.toFixed(4)} SOL`);
  if (solBalance < minSol) {
    console.log(`  ⚠ Need at least ${minSol} SOL. Please fund the wallet and re-run.`);
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Skye Ladder — Deployment");
  console.log("═══════════════════════════════════════════════════════════════\n");
  console.log(`Network: ${RPC_URL}`);

  // --- Load wallet ---
  const wallet = loadKeypair("~/.config/solana/id.json");
  const connection = new Connection(RPC_URL, "confirmed");
  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
  await airdropIfNeeded(connection, wallet.publicKey, 3);

  // --- Step 1: Deploy program ---
  console.log("\n[1/3] Deploying program...");
  const programInfo = await connection.getAccountInfo(PROGRAM_ID);
  if (programInfo) {
    console.log(`  Program already deployed at ${PROGRAM_ID.toBase58()}`);
  } else {
    console.log(`  Deploying to ${PROGRAM_ID.toBase58()}...`);
    try {
      const cmd = `solana program deploy target/deploy/skye_ladder.so --program-id target/deploy/skye_ladder-keypair.json`;
      console.log(`  $ ${cmd}`);
      const output = execSync(cmd, { encoding: "utf-8", cwd: process.cwd() });
      console.log(`  ${output.trim()}`);
    } catch (e: any) {
      console.error(`  Deploy failed: ${e.message}`);
      console.error("  Make sure you have enough SOL and the .so file exists.");
      process.exit(1);
    }
  }

  // --- Step 2: Create Token-2022 Mint with Transfer Hook ---
  console.log("\n[2/3] Creating Token-2022 mint with transfer hook extension...");

  // Check if we already created one (saved in state file)
  const stateFile = path.join(__dirname, ".deploy-state.json");
  let state: any = {};
  if (fs.existsSync(stateFile)) {
    state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  }

  let mintKeypair: Keypair;
  let mintPubkey: PublicKey;

  if (state.mint) {
    mintPubkey = new PublicKey(state.mint);
    const mintInfo = await connection.getAccountInfo(mintPubkey);
    if (mintInfo) {
      console.log(`  Mint already exists: ${mintPubkey.toBase58()}`);
    } else {
      console.log(`  Saved mint ${mintPubkey.toBase58()} not found on-chain. Creating new...`);
      state.mint = null;
    }
  }

  if (!state.mint) {
    mintKeypair = Keypair.generate();
    mintPubkey = mintKeypair.publicKey;

    // Calculate space for mint with TransferHook extension
    const extensions = [ExtensionType.TransferHook];
    const mintLen = getMintLen(extensions);
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

    const tx = new Transaction().add(
      // Create the mint account
      SystemProgram.createAccount({
        fromPubkey: wallet.publicKey,
        newAccountPubkey: mintPubkey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      // Initialize the transfer hook extension (must be before InitializeMint)
      createInitializeTransferHookInstruction(
        mintPubkey,
        wallet.publicKey, // authority
        PROGRAM_ID,       // transfer hook program
        TOKEN_2022_PROGRAM_ID,
      ),
      // Initialize the mint itself
      createInitializeMintInstruction(
        mintPubkey,
        DECIMALS,
        wallet.publicKey, // mint authority
        null,             // no freeze authority
        TOKEN_2022_PROGRAM_ID,
      ),
    );

    console.log(`  Creating mint: ${mintPubkey.toBase58()}`);
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet, mintKeypair]);
    console.log(`  Mint created! tx: ${sig}`);

    state.mint = mintPubkey.toBase58();
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  }

  mintPubkey = new PublicKey(state.mint);

  // --- Step 3: Initialize Skye Ladder Config ---
  console.log("\n[3/3] Initializing Skye Ladder config...");

  const [configPDA] = findPDA(
    [Buffer.from("config"), mintPubkey.toBuffer()],
    PROGRAM_ID,
  );
  const [extraMetasPDA] = findPDA(
    [Buffer.from("extra-account-metas"), mintPubkey.toBuffer()],
    PROGRAM_ID,
  );

  const configInfo = await connection.getAccountInfo(configPDA);
  if (configInfo) {
    console.log(`  Config already initialized: ${configPDA.toBase58()}`);
  } else {
    // For initial deployment, use placeholder pool/lb_pair addresses.
    // These will be updated via update_pool after the Meteora pool is created.
    const placeholderPool = PublicKey.default;
    const placeholderLbPair = PublicKey.default;

    // Load the IDL and create Anchor program interface
    const idlPath = path.join(__dirname, "..", "target", "idl", "skye_ladder.json");
    if (!fs.existsSync(idlPath)) {
      console.log("  IDL not found. Generating...");
      try {
        execSync("anchor build", { encoding: "utf-8", cwd: path.join(__dirname, "..") });
      } catch {
        console.log("  Anchor build failed for IDL. Using raw transaction instead.");
      }
    }

    // Build the initialize instruction manually using Anchor
    const provider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(wallet),
      { commitment: "confirmed" },
    );

    let program: anchor.Program;
    if (fs.existsSync(idlPath)) {
      const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
      program = new anchor.Program(idl, provider);
    } else {
      console.log("  ⚠ No IDL found. Cannot initialize via Anchor.");
      console.log("  Run `anchor build` first to generate the IDL, then re-run this script.");
      console.log("\n  Deployment state saved. Re-run to continue from step 3.");
      process.exit(0);
    }

    try {
      const sig = await program.methods
        .initialize(placeholderPool, placeholderLbPair)
        .accounts({
          authority: wallet.publicKey,
          mint: mintPubkey,
          config: configPDA,
          extraAccountMetaList: extraMetasPDA,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log(`  Config initialized! tx: ${sig}`);
      state.config = configPDA.toBase58();
      state.extraMetas = extraMetasPDA.toBase58();
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    } catch (e: any) {
      console.error(`  Initialize failed: ${e.message}`);
      process.exit(1);
    }
  }

  // --- Summary ---
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Deployment Summary");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Program:           ${PROGRAM_ID.toBase58()}`);
  console.log(`  Mint:              ${state.mint}`);
  console.log(`  Config PDA:        ${configPDA.toBase58()}`);
  console.log(`  ExtraMetaList PDA: ${extraMetasPDA.toBase58()}`);
  console.log(`  Pool:              (placeholder — run create-pool next)`);
  console.log(`  Network:           ${RPC_URL}`);
  console.log("\n  Next: npm run create-pool");
}

main().catch(console.error);
