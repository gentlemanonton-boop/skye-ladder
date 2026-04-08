/**
 * prestage-skye-pool.ts — One-time bootstrap for SKYE's AMM pool.
 *
 * Creates the empty Pool PDA, lp_mint, reserve ATAs, and incinerator LP ATA,
 * then sets up fee routing to the treasury. After this runs successfully,
 * the curve's `graduate` instruction is fully wired and will atomically
 * migrate liquidity into this pool the moment SKYE bonds at 85 SOL.
 *
 * SAFETY: this script sends REAL MAINNET TRANSACTIONS. Read the printed
 * plan before approving. Run with --dry-run first to see what it would do
 * without sending anything.
 *
 * Usage:
 *   npx ts-node scripts/prestage-skye-pool.ts --dry-run
 *   npx ts-node scripts/prestage-skye-pool.ts --rpc <helius_url>
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  MINT_SIZE,
  getMinimumBalanceForRentExemptMint,
  getAccount,
  getMint,
} from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

// ── Constants (mainnet) ──────────────────────────────────────────────────────
const SKYE_MINT       = new PublicKey("5GtUWP1x4LpKjAzGBZg9sy9TbTqjY2bvJfgfC7aUmAfF");
const SKYE_AMM_ID     = new PublicKey("GRBvJRRJfV3CzRLocGcr3NTptWQpu1G4nW9Jpff5TFoX");
const TREASURY_WALLET = new PublicKey("5j5J5sMhwURJv1bdufDUypt29FeRnfv8GLpv53Cy1oxs");
const INCINERATOR     = new PublicKey("1nc1nerator11111111111111111111111111111111");
const POOL_FEE_BPS    = 100; // 1% — matches the curve's fee_bps for continuity

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const RPC_URL = (() => {
  const i = args.indexOf("--rpc");
  return i >= 0 ? args[i + 1] : "https://api.mainnet-beta.solana.com";
})();

// ── Anchor instruction discriminators (sha256("global:<name>")[0..8]) ────────
function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function loadKeypair(filePath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function poolPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), SKYE_MINT.toBuffer(), NATIVE_MINT.toBuffer()],
    SKYE_AMM_ID,
  );
}

function lpAuthorityPda(pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lp-authority"), pool.toBuffer()],
    SKYE_AMM_ID,
  );
}

// Build the AMM `initialize_pool(fee_bps: u16)` instruction by hand.
function buildInitializePoolIx(
  authority: PublicKey,
  pool: PublicKey,
  lpMint: PublicKey,
  lpAuthority: PublicKey,
  skyeReserve: PublicKey,
  wsolReserve: PublicKey,
): TransactionInstruction {
  const data = Buffer.concat([
    anchorDiscriminator("initialize_pool"),
    (() => {
      const buf = Buffer.alloc(2);
      buf.writeUInt16LE(POOL_FEE_BPS, 0);
      return buf;
    })(),
  ]);

  return new TransactionInstruction({
    programId: SKYE_AMM_ID,
    keys: [
      { pubkey: authority,                       isSigner: true,  isWritable: true  },
      { pubkey: SKYE_MINT,                       isSigner: false, isWritable: false },
      { pubkey: NATIVE_MINT,                     isSigner: false, isWritable: false },
      { pubkey: pool,                            isSigner: false, isWritable: true  },
      { pubkey: skyeReserve,                     isSigner: false, isWritable: false },
      { pubkey: wsolReserve,                     isSigner: false, isWritable: false },
      { pubkey: lpMint,                          isSigner: false, isWritable: false },
      { pubkey: lpAuthority,                     isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID,           isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,                isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,     isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,         isSigner: false, isWritable: false },
    ],
    data,
  });
}

// Build the AMM `set_fee_config(team_wallet: Pubkey)` instruction by hand.
function buildSetFeeConfigIx(
  authority: PublicKey,
  pool: PublicKey,
  teamWallet: PublicKey,
): TransactionInstruction {
  const data = Buffer.concat([
    anchorDiscriminator("set_fee_config"),
    teamWallet.toBuffer(),
  ]);

  return new TransactionInstruction({
    programId: SKYE_AMM_ID,
    keys: [
      { pubkey: authority,               isSigner: true,  isWritable: true },
      { pubkey: pool,                    isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  SKYE Pool Pre-Stage  (one-time bootstrap)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  RPC:        ${RPC_URL}`);
  console.log(`  Mode:       ${DRY_RUN ? "DRY RUN (no transactions sent)" : "LIVE — will send mainnet transactions"}`);
  console.log();

  const connection = new Connection(RPC_URL, "confirmed");
  const authority  = loadKeypair(path.join(process.env.HOME!, ".config", "solana", "id.json"));

  // Derive all addresses
  const [pool, poolBump]               = poolPda();
  const [lpAuthority, lpAuthorityBump] = lpAuthorityPda(pool);

  const lpMintKp = Keypair.generate();

  const skyeReserve = getAssociatedTokenAddressSync(
    SKYE_MINT, pool, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const wsolReserve = getAssociatedTokenAddressSync(
    NATIVE_MINT, pool, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const treasuryWsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT, TREASURY_WALLET, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const incineratorLpAta = getAssociatedTokenAddressSync(
    lpMintKp.publicKey, INCINERATOR, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  console.log("─── Addresses ───────────────────────────────────────────");
  console.log(`  Authority (signer):  ${authority.publicKey.toBase58()}`);
  console.log(`  SKYE mint:           ${SKYE_MINT.toBase58()}`);
  console.log(`  WSOL mint:           ${NATIVE_MINT.toBase58()}`);
  console.log(`  Pool PDA:            ${pool.toBase58()}  (bump ${poolBump})`);
  console.log(`  LP authority PDA:    ${lpAuthority.toBase58()}  (bump ${lpAuthorityBump})`);
  console.log(`  LP mint (NEW):       ${lpMintKp.publicKey.toBase58()}`);
  console.log(`  SKYE reserve ATA:    ${skyeReserve.toBase58()}`);
  console.log(`  WSOL reserve ATA:    ${wsolReserve.toBase58()}`);
  console.log(`  Treasury WSOL ATA:   ${treasuryWsolAta.toBase58()}`);
  console.log(`  Incinerator LP ATA:  ${incineratorLpAta.toBase58()}`);
  console.log();

  // Check whether the pool already exists (idempotency guard)
  const existingPool = await connection.getAccountInfo(pool);
  if (existingPool) {
    console.log("⚠  Pool PDA already exists. This script is one-shot.");
    console.log("   If you need to reconfigure, do it manually via set_fee_config.");
    process.exit(1);
  }

  // Verify authority has SOL
  const balance = await connection.getBalance(authority.publicKey);
  console.log(`  Authority balance:   ${(balance / 1e9).toFixed(4)} SOL`);
  if (balance < 0.05 * 1e9) {
    console.error(`✗ Authority needs at least ~0.05 SOL for rent + tx fees.`);
    process.exit(1);
  }

  // Verify SKYE mint exists and is Token-2022
  const skyeMintAcct = await connection.getAccountInfo(SKYE_MINT);
  if (!skyeMintAcct || !skyeMintAcct.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    console.error(`✗ SKYE mint not found or not Token-2022.`);
    process.exit(1);
  }
  console.log(`  SKYE mint owner:     ${skyeMintAcct.owner.toBase58()} ✓ Token-2022`);
  console.log();

  // ── Build the transaction ──
  console.log("─── Plan ────────────────────────────────────────────────");
  console.log("  1. Create LP mint account (rent-exempt, 6 decimals, lp_authority owns it)");
  console.log("  2. Create SKYE reserve ATA (Token-2022, owned by Pool PDA)");
  console.log("  3. Create WSOL reserve ATA (standard SPL Token, owned by Pool PDA)");
  console.log("  4. Call AMM initialize_pool(fee_bps=100)");
  console.log("  5. Call AMM set_fee_config(team_wallet = treasury WSOL ATA)");
  console.log("  6. Create incinerator's LP token ATA");
  console.log();

  const lpMintRent = await getMinimumBalanceForRentExemptMint(connection);

  const ixs: TransactionInstruction[] = [
    // 1. Create LP mint account
    SystemProgram.createAccount({
      fromPubkey:       authority.publicKey,
      newAccountPubkey: lpMintKp.publicKey,
      lamports:         lpMintRent,
      space:            MINT_SIZE,
      programId:        TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(
      lpMintKp.publicKey,
      6,            // LP token decimals (matches Uniswap V2 convention of 6)
      lpAuthority,  // mint authority = lp_authority PDA
      lpAuthority,  // freeze authority = lp_authority PDA (so we can revoke later if desired)
      TOKEN_PROGRAM_ID,
    ),

    // 2. Create SKYE reserve ATA (Token-2022)
    createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey,
      skyeReserve,
      pool,
      SKYE_MINT,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),

    // 3. Create WSOL reserve ATA (standard Token)
    createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey,
      wsolReserve,
      pool,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),

    // 4. initialize_pool
    buildInitializePoolIx(
      authority.publicKey,
      pool,
      lpMintKp.publicKey,
      lpAuthority,
      skyeReserve,
      wsolReserve,
    ),

    // 5. set_fee_config
    buildSetFeeConfigIx(
      authority.publicKey,
      pool,
      treasuryWsolAta,
    ),

    // 6. Create incinerator LP ATA
    createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey,
      incineratorLpAta,
      INCINERATOR,
      lpMintKp.publicKey,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  ];

  if (DRY_RUN) {
    console.log("─── DRY RUN ─────────────────────────────────────────────");
    console.log(`  Would send 1 transaction with ${ixs.length} instructions.`);
    console.log(`  Estimated cost: ~${((lpMintRent + 5_000) / 1e9).toFixed(4)} SOL`);
    console.log(`  Re-run without --dry-run to actually send.`);
    return;
  }

  // ── Send for real ──
  console.log("─── Sending transaction ─────────────────────────────────");
  const tx = new Transaction().add(...ixs);
  tx.feePayer = authority.publicKey;
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.partialSign(lpMintKp);

  try {
    const sig = await sendAndConfirmTransaction(
      connection,
      tx,
      [authority, lpMintKp],
      { commitment: "confirmed", skipPreflight: false },
    );
    console.log(`  ✓ Confirmed: ${sig}`);
    console.log(`  Solscan: https://solscan.io/tx/${sig}`);
  } catch (e: any) {
    console.error(`✗ Transaction failed: ${e.message || e}`);
    if (e.logs) e.logs.forEach((l: string) => console.error(`    ${l}`));
    process.exit(1);
  }

  // ── Verify ──
  console.log();
  console.log("─── Verification ────────────────────────────────────────");
  const poolInfo = await connection.getAccountInfo(pool);
  if (!poolInfo) {
    console.error("  ✗ Pool PDA not found post-deploy");
    process.exit(1);
  }
  console.log(`  ✓ Pool PDA exists (${poolInfo.data.length} bytes, owner ${poolInfo.owner.toBase58()})`);

  const lpMintInfo = await getMint(connection, lpMintKp.publicKey, "confirmed", TOKEN_PROGRAM_ID);
  console.log(`  ✓ LP mint: supply=${lpMintInfo.supply.toString()}, decimals=${lpMintInfo.decimals}, authority=${lpMintInfo.mintAuthority?.toBase58()}`);
  if (!lpMintInfo.mintAuthority?.equals(lpAuthority)) {
    console.error("  ✗ LP mint authority mismatch");
    process.exit(1);
  }

  const skyeReserveInfo = await getAccount(connection, skyeReserve, "confirmed", TOKEN_2022_PROGRAM_ID);
  console.log(`  ✓ SKYE reserve: owner=${skyeReserveInfo.owner.toBase58()}, balance=${skyeReserveInfo.amount.toString()}`);

  const wsolReserveInfo = await getAccount(connection, wsolReserve, "confirmed", TOKEN_PROGRAM_ID);
  console.log(`  ✓ WSOL reserve: owner=${wsolReserveInfo.owner.toBase58()}, balance=${wsolReserveInfo.amount.toString()}`);

  const incinAtaInfo = await getAccount(connection, incineratorLpAta, "confirmed", TOKEN_PROGRAM_ID);
  console.log(`  ✓ Incinerator LP ATA: owner=${incinAtaInfo.owner.toBase58()}, balance=${incinAtaInfo.amount.toString()}`);
  if (!incinAtaInfo.owner.equals(INCINERATOR)) {
    console.error("  ✗ Incinerator LP ATA owner mismatch");
    process.exit(1);
  }

  console.log();
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  ✓ PRE-STAGE COMPLETE");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log();
  console.log("  SKYE bonding is now seamless. The moment realSol crosses 85,");
  console.log("  anyone (or any backend bot) can call the curve's `graduate`");
  console.log("  instruction. It will atomically migrate liquidity into this");
  console.log("  pool, mint LP to the incinerator, and start trading. Treasury");
  console.log("  fees will route automatically via the team_wallet you just set.");
  console.log();
  console.log("  Save the LP mint address — you'll want it documented:");
  console.log(`    LP mint: ${lpMintKp.publicKey.toBase58()}`);
}

main().catch((err) => {
  console.error("\n✗ Fatal:", err.message || err);
  if (err.logs) err.logs.forEach((l: string) => console.error(`    ${l}`));
  process.exit(1);
});
