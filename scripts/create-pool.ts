/**
 * create-pool.ts — Create a Meteora DLMM pool for the SKYE token
 *
 * Steps:
 *   1. Mint the total SKYE supply to the deployer wallet
 *   2. Create a Meteora DLMM pool (SKYE/SOL) using the Meteora SDK
 *   3. Add one-sided SKYE liquidity
 *   4. Update the Skye Ladder config with the real pool + lb_pair addresses
 *
 * Prerequisites:
 *   - deploy.ts has been run (mint + config exist)
 *   - .deploy-state.json exists with mint address
 *
 * Usage:
 *   npx ts-node scripts/create-pool.ts
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
  NATIVE_MINT,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import DLMM, {
  ActivationType,
  StrategyType,
  deriveCustomizablePermissionlessLbPair,
  LBCLMM_PROGRAM_IDS,
} from "@meteora-ag/dlmm";
import { BN } from "bn.js";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

// ═══════════════════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════════════════

const PROGRAM_ID = new PublicKey("4THAwb6WSpDyyqMHnJL2VBjU7TCLfLLGC5jtuCiyX5Rz");
const RPC_URL = execSync("solana config get | grep 'RPC URL' | awk '{print $NF}'", { encoding: "utf-8" }).trim();
const DECIMALS = 9;
const TOTAL_SUPPLY_RAW = BigInt(1_000_000_000) * BigInt(10 ** DECIMALS); // 1B * 10^9

// Pool parameters
const BIN_STEP = 50;        // 0.5% per bin
const FEE_BPS = 100;        // 1% base fee

// ═══════════════════════════════════════════════════════════════════════════════
// Price calculation
//
// Launch MC target: ~$3,000 with 1B supply → $0.000003 per token
// Price in the DLMM is expressed as token_y (SOL) per token_x (SKYE).
//
// Formula: price = (1 + binStep/10000) ^ (activeId - 8388608)
//          = 1.005 ^ (activeId - 8388608)
//
// To find activeId for a target SOL price:
//   activeId = 8388608 + ln(price_in_sol) / ln(1.005)
//
// Example at SOL=$130:
//   price_in_sol = $0.000003 / $130 = 2.3e-8
//   ln(2.3e-8) / ln(1.005) ≈ -3526
//   activeId = 8388608 - 3526 = 8385082
//
// Adjust TARGET_PRICE_SOL below based on current SOL price.
// ═══════════════════════════════════════════════════════════════════════════════

const TARGET_PRICE_SOL = 0.000000023; // SOL per SKYE (~$3K MC at SOL=$130)
const BIN_ID_CENTER = 8_388_608;

function calculateActiveId(priceSol: number, binStep: number): number {
  const exp = Math.log(priceSol) / Math.log(1 + binStep / 10000);
  return Math.round(BIN_ID_CENTER + exp);
}

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
  console.log("  Skye Ladder — Create Meteora DLMM Pool");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const wallet = loadKeypair("~/.config/solana/id.json");
  const connection = new Connection(RPC_URL, "confirmed");
  const state = loadState();

  const mintPubkey = new PublicKey(state.mint);
  const activeId = calculateActiveId(TARGET_PRICE_SOL, BIN_STEP);

  console.log(`Wallet:  ${wallet.publicKey.toBase58()}`);
  console.log(`Mint:    ${mintPubkey.toBase58()}`);
  console.log(`Network: ${RPC_URL}`);
  console.log(`Bin step:  ${BIN_STEP} (${BIN_STEP / 100}%)`);
  console.log(`Fee:       ${FEE_BPS} bps (${FEE_BPS / 100}%)`);
  console.log(`Active ID: ${activeId} (exp: ${activeId - BIN_ID_CENTER})`);
  console.log(`Target price: ${TARGET_PRICE_SOL} SOL per SKYE`);

  const meteoraProgramId = new PublicKey(LBCLMM_PROGRAM_IDS["mainnet-beta"]);

  // --- Step 1: Mint total supply to deployer ---
  console.log("\n[1/4] Minting total supply...");

  const deployerATA = getAssociatedTokenAddressSync(
    mintPubkey,
    wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const ataInfo = await connection.getAccountInfo(deployerATA);
  if (!ataInfo) {
    console.log(`  Creating ATA: ${deployerATA.toBase58()}`);
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        deployerATA,
        wallet.publicKey,
        mintPubkey,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    await sendAndConfirmTransaction(connection, tx, [wallet]);
  }

  if (!state.minted) {
    console.log(`  Minting ${TOTAL_SUPPLY_RAW.toString()} raw tokens...`);
    const tx = new Transaction().add(
      createMintToInstruction(
        mintPubkey,
        deployerATA,
        wallet.publicKey,
        TOTAL_SUPPLY_RAW,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    );
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
    console.log(`  Minted! tx: ${sig}`);
    state.minted = true;
    state.deployerATA = deployerATA.toBase58();
    saveState(state);
  } else {
    console.log(`  Already minted. ATA: ${deployerATA.toBase58()}`);
  }

  // --- Step 2: Create Meteora DLMM Pool ---
  console.log("\n[2/4] Creating Meteora DLMM pool...");

  // Derive the LbPair PDA to check if pool already exists
  const [lbPairPubkey] = deriveCustomizablePermissionlessLbPair(
    mintPubkey,
    NATIVE_MINT,
    meteoraProgramId,
  );
  console.log(`  Expected LbPair PDA: ${lbPairPubkey.toBase58()}`);

  const existingPool = await connection.getAccountInfo(lbPairPubkey);
  if (existingPool) {
    console.log(`  Pool already exists at ${lbPairPubkey.toBase58()}`);
  } else {
    console.log(`  Creating permissionless DLMM pool...`);

    // @ts-ignore — Anchor 0.30 deep type instantiation
    const createPoolTx = await DLMM.createCustomizablePermissionlessLbPair2(
      connection,
      new BN(BIN_STEP),
      mintPubkey,       // token X = SKYE (Token-2022)
      NATIVE_MINT,      // token Y = SOL
      new BN(activeId),
      new BN(FEE_BPS),
      ActivationType.Slot,
      false,            // hasAlphaVault
      wallet.publicKey, // creator
    );

    const sig = await sendAndConfirmTransaction(connection, createPoolTx, [wallet]);
    console.log(`  Pool created! tx: ${sig}`);
  }

  state.lbPair = lbPairPubkey.toBase58();

  // Load the pool via SDK to get reserve addresses
  const dlmmPool = await DLMM.create(connection, lbPairPubkey);
  const reserveX = dlmmPool.tokenX.reserve.toBase58();
  const reserveY = dlmmPool.tokenY.reserve.toBase58();
  console.log(`  Reserve X (SKYE): ${reserveX}`);
  console.log(`  Reserve Y (SOL):  ${reserveY}`);

  // The pool address to whitelist is the reserve that holds SKYE tokens
  state.pool = reserveX;
  saveState(state);

  // --- Step 3: Add one-sided SKYE liquidity ---
  console.log("\n[3/4] Adding one-sided SKYE liquidity...");

  if (state.liquidityAdded) {
    console.log("  Liquidity already added.");
  } else {
    // Deposit all SKYE tokens as one-sided liquidity above the active bin.
    // Bins at/above activeId hold token X (SKYE). As buyers come in and push
    // price up, they buy SKYE from these bins.
    const totalXAmount = new BN(TOTAL_SUPPLY_RAW.toString());
    const totalYAmount = new BN(0);

    // Range: activeId to activeId + 69 (max bins per position)
    // For broader coverage, we may need multiple positions, but start with one.
    const MAX_BINS_PER_POSITION = 70;
    const minBinId = activeId;
    const maxBinId = activeId + MAX_BINS_PER_POSITION - 1;

    console.log(`  Depositing ${TOTAL_SUPPLY_RAW.toString()} SKYE tokens`);
    console.log(`  Bin range: ${minBinId} to ${maxBinId} (${MAX_BINS_PER_POSITION} bins)`);
    console.log(`  Price range: ${TARGET_PRICE_SOL} to ${(TARGET_PRICE_SOL * Math.pow(1 + BIN_STEP / 10000, MAX_BINS_PER_POSITION)).toFixed(12)} SOL`);

    const positionKeypair = Keypair.generate();

    // @ts-ignore — Anchor 0.30 deep type instantiation
    const addLiquidityTxs = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKeypair.publicKey,
      user: wallet.publicKey,
      totalXAmount,
      totalYAmount,
      strategy: {
        minBinId,
        maxBinId,
        strategyType: StrategyType.Spot,
      },
    });

    // May return single tx or array of txs
    const txArray = Array.isArray(addLiquidityTxs) ? addLiquidityTxs : [addLiquidityTxs];

    for (let i = 0; i < txArray.length; i++) {
      const sig = await sendAndConfirmTransaction(
        connection,
        txArray[i],
        [wallet, positionKeypair],
      );
      console.log(`  Liquidity tx ${i + 1}/${txArray.length}: ${sig}`);
    }

    state.liquidityAdded = true;
    state.positionPubkey = positionKeypair.publicKey.toBase58();
    state.positionKeypair = Array.from(positionKeypair.secretKey);
    saveState(state);
    console.log(`  Position: ${positionKeypair.publicKey.toBase58()}`);
  }

  // --- Step 4: Update Skye Ladder config with real pool addresses ---
  console.log("\n[4/4] Updating Skye Ladder config with pool addresses...");

  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(wallet),
    { commitment: "confirmed" },
  );

  const idlPath = path.join(__dirname, "..", "target", "idl", "skye_ladder.json");
  if (!fs.existsSync(idlPath)) {
    console.log("  No IDL found. Run `anchor build` first.");
    process.exit(1);
  }
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider);

  const [configPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("config"), mintPubkey.toBuffer()],
    PROGRAM_ID,
  );

  const poolPubkey = new PublicKey(state.pool);

  try {
    // @ts-ignore — Anchor 0.30 deep type instantiation
    const sig = await program.methods
      .updatePool(poolPubkey, lbPairPubkey)
      .accounts({
        authority: wallet.publicKey,
        mint: mintPubkey,
        config: configPDA,
      })
      .rpc();

    console.log(`  Config updated! tx: ${sig}`);
  } catch (e: any) {
    console.error(`  Update failed: ${e.message}`);
  }

  // --- Summary ---
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Pool Summary");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Mint:        ${mintPubkey.toBase58()}`);
  console.log(`  LbPair:      ${lbPairPubkey.toBase58()}`);
  console.log(`  Reserve X:   ${state.pool}`);
  console.log(`  Deployer ATA: ${state.deployerATA}`);
  console.log(`  Position:    ${state.positionPubkey || "N/A"}`);
  console.log(`  Active ID:   ${activeId}`);
  console.log(`  Bin step:    ${BIN_STEP}`);
  console.log(`  Network:     ${RPC_URL}`);
  console.log("\n  Next: npx ts-node scripts/test-hook.ts");
}

main().catch(console.error);
