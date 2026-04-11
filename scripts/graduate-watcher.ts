/**
 * graduate-watcher.ts — Universal graduation relayer for the Skye launchpad.
 *
 * Enumerates EVERY curve account owned by the Skye Curve program, polls
 * each one's `real_sol_reserve`, and fires the curve's `graduate`
 * instruction the moment ANY of them crosses `graduation_sol`. Matches
 * pump.fun's relayer model: zero manual ops at the moment of bonding,
 * atomic migration into the AMM, LP burned to incinerator.
 *
 * Works for SKYE and every future token launched through the launchpad —
 * NO hardcoded mint. Each token's PDAs are derived from its own mint
 * pubkey, read directly from the curve account data.
 *
 * USAGE:
 *
 *   1. Generate a hot wallet (do this ONCE):
 *        mkdir -p ~/.skye
 *        solana-keygen new --no-bip39-passphrase --outfile ~/.skye/relayer-keypair.json
 *
 *   2. Fund it with ~0.05 SOL (only pays graduate tx fees, ~0.001 SOL per call):
 *        solana transfer <relayer-pubkey> 0.05 --from ~/.config/solana/id.json -u m
 *
 *   3. Start the watcher (one of these):
 *        # Continuous poll, default 10s interval
 *        npx ts-node scripts/graduate-watcher.ts
 *
 *        # Custom poll interval
 *        npx ts-node scripts/graduate-watcher.ts --interval 5
 *
 *        # One-shot check + exit (for cron / GitHub Actions / Vercel cron)
 *        npx ts-node scripts/graduate-watcher.ts --once
 *
 *        # Use Helius RPC instead of public RPC for faster polling
 *        npx ts-node scripts/graduate-watcher.ts --rpc https://...
 *
 *        # Use a different keypair
 *        npx ts-node scripts/graduate-watcher.ts --keypair ~/.skye/other.json
 *
 *        # Provide the admin authority to auto-switch hook after graduation
 *        npx ts-node scripts/graduate-watcher.ts --admin-keypair ~/.config/solana/id.json
 *        # or via env var:
 *        ADMIN_KEYPAIR_JSON='[12,34,...]' npx ts-node scripts/graduate-watcher.ts
 *
 * POST-GRADUATION HOOK SWITCHOVER:
 * After graduation, the transfer hook's price source and pool classification
 * must be switched from the curve to the AMM. If --admin-keypair is provided
 * (or ADMIN_KEYPAIR_JSON env var), the watcher fires update_pool +
 * update_extra_metas automatically. Without it, a manual call is required
 * or token transfers will misclassify AMM trades.
 *
 * SAFETY: the hot wallet only needs SOL for tx fees. NEVER use your main
 * upgrade authority key for this — if the relayer machine is compromised,
 * the worst case is the attacker drains the hot wallet's tiny SOL balance.
 *
 * This script is idempotent and safe to run from multiple machines or
 * processes simultaneously: only the first call to graduate succeeds, all
 * others get `AlreadyGraduated` and exit cleanly.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  SystemProgram,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

// ── Constants (mainnet) ──────────────────────────────────────────────────────
const SKYE_CURVE_ID      = new PublicKey("5bxtpbYgiMQMJcB1c2cWXGErsiRmAZeyRqRKCXoeZRXf");
const SKYE_AMM_ID        = new PublicKey("GRBvJRRJfV3CzRLocGcr3NTptWQpu1G4nW9Jpff5TFoX");
const SKYE_LADDER_ID     = new PublicKey("4THAwb6WSpDyyqMHnJL2VBjU7TCLfLLGC5jtuCiyX5Rz");
const INCINERATOR        = new PublicKey("1nc1nerator11111111111111111111111111111111");

// Curve account field offsets (matches Curve struct in skye-curve/src/state.rs)
//   8 disc + 32 creator + 32 mint + 32 wsol_mint + 32 token_reserve + 32 sol_reserve
//   + 8 vToken + 8 vSol + 8 realSol + 8 realToken + 8 supply + 2 fee + 1 grad + 8 gradSol
//   + 1 bump + 32 hook + 32 creator_fee_wallet
const CURVE_MINT_OFFSET       = 8 + 32;       // 40
const CURVE_REAL_SOL_OFFSET   = 184;
const CURVE_REAL_TOKEN_OFFSET = 192;
const CURVE_GRADUATED_OFFSET  = 210;
const CURVE_GRADUATION_OFFSET = 211;
const CURVE_ACCOUNT_SIZE      = 284;          // total bytes — used as a getProgramAccounts filter

// Hook Config field offsets (matches Config struct in skye-ladder/src/state.rs)
const CONFIG_LB_PAIR_OFFSET = 8 + 32 + 32 + 32; // 104

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const ONCE        = args.includes("--once");
const INTERVAL_S  = parseInt(flag("interval") || process.env.WATCHER_INTERVAL_S || "10", 10);
const RPC_URL     = flag("rpc") || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const KEYPAIR     = flag("keypair") || path.join(process.env.HOME || ".", ".skye", "relayer-keypair.json");
const ADMIN_KEYPAIR = flag("admin-keypair") || path.join(process.env.HOME || ".", ".config", "solana", "id.json");

// ── Helpers ──────────────────────────────────────────────────────────────────
function discriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function loadKeypair(filePath: string): Keypair | null {
  // RELAYER_KEYPAIR_JSON env var takes precedence — used by hosted
  // deployments (Railway, Fly, etc.) where there's no on-disk keypair file.
  // The value should be the full JSON byte array, e.g.: [12,34,56,...]
  const envJson = process.env.RELAYER_KEYPAIR_JSON;
  if (envJson) {
    try {
      const raw = JSON.parse(envJson) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(raw));
    } catch (e: any) {
      console.error(`✗ RELAYER_KEYPAIR_JSON env var present but unparseable: ${e.message || e}`);
      return null;
    }
  }
  if (!fs.existsSync(filePath)) return null;
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function lamports(sol: number): number { return Math.floor(sol * 1e9); }
function fmtSol(lamports: number | bigint): string {
  return (Number(lamports) / 1e9).toFixed(4);
}
function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

// ── PDA derivations (all per-mint) ───────────────────────────────────────────
function curvePda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("curve"), mint.toBuffer()],
    SKYE_CURVE_ID,
  );
}
function poolPda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), mint.toBuffer(), NATIVE_MINT.toBuffer()],
    SKYE_AMM_ID,
  );
}
function lpAuthorityPda(pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lp-authority"), pool.toBuffer()],
    SKYE_AMM_ID,
  );
}
function hookConfigPda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config"), mint.toBuffer()],
    SKYE_LADDER_ID,
  );
}
function hookExtraMetasPda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBuffer()],
    SKYE_LADDER_ID,
  );
}
function walletRecordPda(owner: PublicKey, mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("wallet"), owner.toBuffer(), mint.toBuffer()],
    SKYE_LADDER_ID,
  );
}

// ── Curve state ──────────────────────────────────────────────────────────────
interface CurveState {
  curve: PublicKey;
  mint: PublicKey;
  realSol: bigint;
  realTokens: bigint;
  graduated: boolean;
  graduationSol: bigint;
}

function parseCurveAccount(curveAddress: PublicKey, data: Buffer): CurveState | null {
  if (data.length < CURVE_ACCOUNT_SIZE) return null;
  return {
    curve:         curveAddress,
    mint:          new PublicKey(data.subarray(CURVE_MINT_OFFSET, CURVE_MINT_OFFSET + 32)),
    realSol:       data.readBigUInt64LE(CURVE_REAL_SOL_OFFSET),
    realTokens:    data.readBigUInt64LE(CURVE_REAL_TOKEN_OFFSET),
    graduated:     data[CURVE_GRADUATED_OFFSET] === 1,
    graduationSol: data.readBigUInt64LE(CURVE_GRADUATION_OFFSET),
  };
}

async function fetchCurveState(conn: Connection, curve: PublicKey): Promise<CurveState | null> {
  const acct = await conn.getAccountInfo(curve, "confirmed");
  if (!acct) return null;
  return parseCurveAccount(curve, acct.data);
}

/**
 * Enumerate every active curve owned by the Skye Curve program. Filters by
 * exact account size to skip the LaunchpadConfig and any other non-Curve
 * accounts the program might own.
 */
async function fetchAllCurves(conn: Connection): Promise<CurveState[]> {
  const accounts = await conn.getProgramAccounts(SKYE_CURVE_ID, {
    commitment: "confirmed",
    filters: [{ dataSize: CURVE_ACCOUNT_SIZE }],
  });
  const curves: CurveState[] = [];
  for (const { pubkey, account } of accounts) {
    const state = parseCurveAccount(pubkey, account.data);
    if (state) curves.push(state);
  }
  return curves;
}

async function fetchHookLbPair(conn: Connection, config: PublicKey): Promise<PublicKey> {
  const acct = await conn.getAccountInfo(config, "confirmed");
  if (!acct || acct.data.length < CONFIG_LB_PAIR_OFFSET + 32) {
    throw new Error("hook config account not found or too small");
  }
  return new PublicKey(acct.data.subarray(CONFIG_LB_PAIR_OFFSET, CONFIG_LB_PAIR_OFFSET + 32));
}

// ── Build the graduate instruction ───────────────────────────────────────────
function buildGraduateIx(opts: {
  payer: PublicKey;
  mint: PublicKey;
  curve: PublicKey;
  curveTokenReserve: PublicKey;
  curveSolReserve: PublicKey;
  ammPool: PublicKey;
  ammTokenReserve: PublicKey;
  ammSolReserve: PublicKey;
  lpMint: PublicKey;
  incineratorLpAccount: PublicKey;
  lpAuthority: PublicKey;
  // Hook accounts forwarded as remaining_accounts
  hookConfig: PublicKey;
  senderWalletRecord: PublicKey;
  receiverWalletRecord: PublicKey;
  lbPair: PublicKey;
  hookExtraMetas: PublicKey;
}): TransactionInstruction {
  const data = discriminator("graduate"); // no args

  const keys = [
    // Standard graduate accounts (must match the order in graduate.rs Accounts struct)
    { pubkey: opts.payer,                isSigner: true,  isWritable: true  },
    { pubkey: opts.curve,                isSigner: false, isWritable: true  },
    { pubkey: opts.mint,                 isSigner: false, isWritable: false },
    { pubkey: NATIVE_MINT,               isSigner: false, isWritable: false },
    { pubkey: opts.curveTokenReserve,    isSigner: false, isWritable: true  },
    { pubkey: opts.curveSolReserve,      isSigner: false, isWritable: true  },
    { pubkey: opts.ammTokenReserve,      isSigner: false, isWritable: true  },
    { pubkey: opts.ammSolReserve,        isSigner: false, isWritable: true  },
    { pubkey: opts.ammPool,              isSigner: false, isWritable: true  },
    { pubkey: opts.lpMint,               isSigner: false, isWritable: true  },
    { pubkey: opts.incineratorLpAccount, isSigner: false, isWritable: true  },
    { pubkey: opts.lpAuthority,          isSigner: false, isWritable: false },
    { pubkey: SKYE_AMM_ID,               isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID,     isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID,          isSigner: false, isWritable: false },

    // Hook accounts as remaining_accounts. graduate.rs forwards these into
    // the manual transfer_checked invocation, where Token-2022 reads them
    // as the hook's extra accounts. Order: matches the hook's transfer_hook
    // Accounts struct (after the standard 4 from Token-2022).
    { pubkey: opts.hookExtraMetas,       isSigner: false, isWritable: false },
    { pubkey: opts.hookConfig,           isSigner: false, isWritable: false },
    { pubkey: opts.senderWalletRecord,   isSigner: false, isWritable: true  },
    { pubkey: opts.receiverWalletRecord, isSigner: false, isWritable: true  },
    { pubkey: opts.lbPair,               isSigner: false, isWritable: false },
    // The hook program itself must be present so Token-2022 can CPI into it.
    { pubkey: SKYE_LADDER_ID,            isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: SKYE_CURVE_ID,
    keys,
    data,
  });
}

// ── Try to fire graduate for ONE specific token ──────────────────────────────
async function tryGraduate(
  conn: Connection,
  payer: Keypair,
  state: CurveState,
): Promise<"graduated" | "skipped" | "error" | "no-pool"> {
  const mint         = state.mint;
  const [curve]      = curvePda(mint);
  const [pool]       = poolPda(mint);
  const [lpAuth]     = lpAuthorityPda(pool);
  const [hookCfg]    = hookConfigPda(mint);
  const [extraMetas] = hookExtraMetasPda(mint);
  const [senderWR]   = walletRecordPda(curve, mint);
  const [receiverWR] = walletRecordPda(pool, mint);

  const curveTokenReserve = getAssociatedTokenAddressSync(
    mint, curve, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const curveSolReserve = getAssociatedTokenAddressSync(
    NATIVE_MINT, curve, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const ammTokenReserve = getAssociatedTokenAddressSync(
    mint, pool, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const ammSolReserve = getAssociatedTokenAddressSync(
    NATIVE_MINT, pool, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  // Read pool to get the lp_mint address (set during pre-stage). If the pool
  // doesn't exist, this token was launched without auto-prestage and the
  // relayer cannot graduate it — log and skip rather than crash.
  const poolAcct = await conn.getAccountInfo(pool, "confirmed");
  if (!poolAcct) {
    console.error(`[${ts()}] ✗ ${mint.toBase58().slice(0,8)}…  pool not pre-staged — skipping. (Token launched before auto-prestage shipped, or prestage failed.)`);
    return "no-pool";
  }
  // Pool layout: 8 disc + 32 auth + 32 skye + 32 wsol + 32 skye_res + 32 wsol_res + 32 lp_mint
  // lp_mint at offset 8 + 5*32 = 168
  const lpMint = new PublicKey(poolAcct.data.subarray(8 + 32 * 5, 8 + 32 * 6));

  const incineratorLpAccount = getAssociatedTokenAddressSync(
    lpMint, INCINERATOR, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  // Read hook config for lb_pair (the price source the hook validates)
  const lbPair = await fetchHookLbPair(conn, hookCfg);

  console.log(`[${ts()}] → Building graduate tx for ${mint.toBase58()}`);
  console.log(`         payer:        ${payer.publicKey.toBase58()}`);
  console.log(`         realSol:      ${fmtSol(state.realSol)} / ${fmtSol(state.graduationSol)} SOL`);
  console.log(`         realTokens:   ${(Number(state.realTokens) / 1e9).toFixed(2)} tokens`);
  console.log(`         pool:         ${pool.toBase58()}`);
  console.log(`         lp_mint:      ${lpMint.toBase58()}`);
  console.log(`         incinerator:  ${incineratorLpAccount.toBase58()}`);
  console.log(`         lb_pair:      ${lbPair.toBase58()}`);

  const ix = buildGraduateIx({
    payer: payer.publicKey,
    mint,
    curve,
    curveTokenReserve,
    curveSolReserve,
    ammPool: pool,
    ammTokenReserve,
    ammSolReserve,
    lpMint,
    incineratorLpAccount,
    lpAuthority: lpAuth,
    hookConfig: hookCfg,
    senderWalletRecord: senderWR,
    receiverWalletRecord: receiverWR,
    lbPair,
    hookExtraMetas: extraMetas,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [payer], {
      commitment: "confirmed",
      skipPreflight: false,
    });
    console.log(`[${ts()}] ✓ GRADUATED ${mint.toBase58().slice(0,8)}…  tx: ${sig}`);
    console.log(`         https://solscan.io/tx/${sig}`);
    return "graduated";
  } catch (e: any) {
    const msg = e.message || String(e);
    const logs: string[] = e.logs || [];

    if (logs.some(l => l.includes("AlreadyGraduated")) || msg.includes("AlreadyGraduated")) {
      console.log(`[${ts()}] ✓ ${mint.toBase58().slice(0,8)}…  already graduated (someone else fired first).`);
      return "graduated";
    }

    if (logs.some(l => l.includes("InsufficientLiquidity"))) {
      console.log(`[${ts()}] ⚠ ${mint.toBase58().slice(0,8)}…  below threshold (race condition). Will retry.`);
      return "skipped";
    }

    console.error(`[${ts()}] ✗ Graduate failed for ${mint.toBase58().slice(0,8)}…: ${msg}`);
    if (logs.length > 0) {
      console.error("         on-chain logs:");
      logs.slice(0, 30).forEach(l => console.error(`           ${l}`));
    }
    return "error";
  }
}

// ── Post-graduation: switch hook price source from Curve → AMM ──────────────
//
// After graduate completes, config.pool still points to the curve's token
// reserve and config.lb_pair still points to the curve PDA. The transfer hook
// uses these to classify buys/sells and read the spot price. Without updating
// them, AMM trades would be misclassified as wallet-to-wallet transfers, and
// the price source (curve virtual reserves) would go stale.
//
// This fires update_pool + update_extra_metas to switch to the AMM pool.
// Requires the admin authority keypair (--admin-keypair or ADMIN_KEYPAIR_JSON).

function loadAdminKeypair(): Keypair | null {
  const envJson = process.env.ADMIN_KEYPAIR_JSON;
  if (envJson) {
    try {
      const raw = JSON.parse(envJson) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(raw));
    } catch { return null; }
  }
  if (fs.existsSync(ADMIN_KEYPAIR)) {
    try {
      const raw = JSON.parse(fs.readFileSync(ADMIN_KEYPAIR, "utf-8")) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(raw));
    } catch { return null; }
  }
  return null;
}

async function switchHookToAmm(
  conn: Connection,
  admin: Keypair,
  mint: PublicKey,
): Promise<boolean> {
  const [pool] = poolPda(mint);
  const [hookCfg] = hookConfigPda(mint);
  const [extraMetas] = hookExtraMetasPda(mint);

  // The AMM pool's SKYE reserve ATA — this becomes the new config.pool
  // (used by the hook to classify source/dest as buy/sell)
  const ammSkyeReserve = getAssociatedTokenAddressSync(
    mint, pool, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  // update_pool(new_pool, new_lb_pair) — args: 32 + 32 bytes
  const updatePoolData = Buffer.alloc(8 + 32 + 32);
  updatePoolData.set(discriminator("update_pool"), 0);
  ammSkyeReserve.toBuffer().copy(updatePoolData, 8);       // new_pool = AMM skye reserve
  pool.toBuffer().copy(updatePoolData, 40);                 // new_lb_pair = AMM pool PDA

  const updatePoolIx = new TransactionInstruction({
    programId: SKYE_LADDER_ID,
    data: updatePoolData,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: mint,            isSigner: false, isWritable: false },
      { pubkey: hookCfg,         isSigner: false, isWritable: true  },
    ],
  });

  // update_extra_metas() — no args
  const updateMetasData = discriminator("update_extra_metas");

  const updateMetasIx = new TransactionInstruction({
    programId: SKYE_LADDER_ID,
    data: updateMetasData,
    keys: [
      { pubkey: admin.publicKey, isSigner: true,  isWritable: false },
      { pubkey: mint,            isSigner: false, isWritable: false },
      { pubkey: hookCfg,         isSigner: false, isWritable: false },
      { pubkey: extraMetas,      isSigner: false, isWritable: true  },
    ],
  });

  // set_fee_config(team_wallet) — routes 50% of AMM swap fees to treasury.
  // This was removed from the user's launch TX because pool.authority is
  // now the platform admin (not the launcher). We set it here instead.
  const TREASURY_WSOL = getAssociatedTokenAddressSync(
    NATIVE_MINT, new PublicKey("5j5J5sMhwURJv1bdufDUypt29FeRnfv8GLpv53Cy1oxs"),
    false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const setFeeData = Buffer.alloc(8 + 32);
  setFeeData.set(discriminator("set_fee_config"), 0);
  TREASURY_WSOL.toBuffer().copy(setFeeData, 8);

  const setFeeIx = new TransactionInstruction({
    programId: SKYE_AMM_ID,
    data: setFeeData,
    keys: [
      { pubkey: admin.publicKey, isSigner: true,  isWritable: true  },
      { pubkey: pool,            isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });

  const tx = new Transaction().add(updatePoolIx, updateMetasIx, setFeeIx);
  tx.feePayer = admin.publicKey;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [admin], {
      commitment: "confirmed",
      skipPreflight: false,
    });
    console.log(`[${ts()}] ✓ HOOK SWITCHED to AMM for ${mint.toBase58().slice(0,8)}…  tx: ${sig}`);
    return true;
  } catch (e: any) {
    console.error(`[${ts()}] ✗ Hook switchover failed for ${mint.toBase58().slice(0,8)}…: ${e.message || e}`);
    if (e.logs) e.logs.slice(0, 15).forEach((l: string) => console.error(`           ${l}`));
    console.error(`         ⚠ MANUAL ACTION REQUIRED: run update_pool + update_extra_metas for this mint`);
    return false;
  }
}

// ── Main loop ────────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  SKYE Graduation Watcher");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  RPC:      ${RPC_URL}`);
  console.log(`  Mode:     ${ONCE ? "one-shot" : `continuous (poll every ${INTERVAL_S}s)`}`);
  console.log(`  Keypair:  ${KEYPAIR}`);

  const payer = loadKeypair(KEYPAIR);
  if (!payer) {
    console.error();
    console.error(`✗ Hot wallet not found at ${KEYPAIR}`);
    console.error();
    console.error("  Generate one with:");
    console.error("    mkdir -p ~/.skye");
    console.error("    solana-keygen new --no-bip39-passphrase --outfile ~/.skye/relayer-keypair.json");
    console.error();
    console.error("  Then fund it with ~0.05 SOL:");
    console.error("    solana transfer <RELAYER_PUBKEY> 0.05 --from ~/.config/solana/id.json -u m");
    console.error();
    console.error("  Use a SEPARATE keypair from your main upgrade authority — the relayer");
    console.error("  only needs SOL for transaction fees and should be treated as hot.");
    process.exit(1);
  }

  console.log(`  Payer:    ${payer.publicKey.toBase58()}`);

  const conn = new Connection(RPC_URL, "confirmed");

  // Sanity-check the hot wallet has SOL
  const balance = await conn.getBalance(payer.publicKey, "confirmed");
  console.log(`  Balance:  ${fmtSol(balance)} SOL`);
  if (balance < lamports(0.005)) {
    console.error(`  ✗ Relayer wallet needs at least ~0.005 SOL for tx fees. Fund it and re-run.`);
    process.exit(1);
  }
  console.log();

  // ── Polling loop — enumerate every curve, fire graduate on any ready ──
  //
  // Unlike a per-token watcher, this runs forever even after individual tokens
  // graduate. New tokens launched through the launchpad get picked up on the
  // next poll automatically. The relayer only exits if the wallet runs dry
  // or there's a fatal startup error.
  let iter = 0;
  while (true) {
    iter++;
    try {
      const allCurves = await fetchAllCurves(conn);
      const active   = allCurves.filter(c => !c.graduated && c.graduationSol > 0n);
      const ready    = active.filter(c => c.realSol >= c.graduationSol);

      // One-line summary per poll. Per-token detail only when something
      // interesting is happening (close to threshold or ready to fire).
      console.log(`[${ts()}] poll #${iter}: ${allCurves.length} curves total, ${active.length} active, ${ready.length} ready to graduate`);

      // Show progress for the closest non-graduated curves so you can eyeball
      // which token is closest to bonding without scrolling.
      if (active.length > 0) {
        const sorted = [...active].sort((a, b) => {
          // Higher % first
          const ra = Number(a.realSol) / Number(a.graduationSol);
          const rb = Number(b.realSol) / Number(b.graduationSol);
          return rb - ra;
        });
        const top = sorted.slice(0, 5);
        for (const c of top) {
          const ratio = (Number(c.realSol) / Number(c.graduationSol) * 100).toFixed(1);
          console.log(`         ${c.mint.toBase58().slice(0, 8)}…  ${fmtSol(c.realSol)} / ${fmtSol(c.graduationSol)} SOL (${ratio}%)`);
        }
        if (active.length > top.length) {
          console.log(`         (... ${active.length - top.length} more)`);
        }
      }

      // Fire graduate on every ready curve, sequentially. Each call is its
      // own transaction; if one fails the others still get tried.
      for (const c of ready) {
        console.log(`[${ts()}] ▲ THRESHOLD REACHED for ${c.mint.toBase58()} — firing graduate`);
        const result = await tryGraduate(conn, payer, c);

        // After a successful graduation, immediately switch the transfer
        // hook's price source and pool classification from curve → AMM.
        // Without this, all AMM trades would be misclassified and the
        // hook would read stale curve data for the spot price.
        if (result === "graduated") {
          const admin = loadAdminKeypair();
          if (admin) {
            console.log(`[${ts()}] → Switching hook to AMM for ${c.mint.toBase58().slice(0,8)}…`);
            await switchHookToAmm(conn, admin, c.mint);
          } else {
            console.error(`[${ts()}] ⚠ NO ADMIN KEY — hook NOT switched to AMM for ${c.mint.toBase58().slice(0,8)}…`);
            console.error(`         Token transfers will use stale curve price data until update_pool + update_extra_metas are called manually.`);
            console.error(`         Provide --admin-keypair <path> or set ADMIN_KEYPAIR_JSON env var.`);
          }
        }
      }
    } catch (e: any) {
      console.error(`[${ts()}] poll #${iter} error: ${e.message || e}`);
      // Don't crash the loop on RPC hiccups
    }

    if (ONCE) {
      console.log(`[${ts()}] one-shot mode — exiting`);
      process.exit(0);
    }

    await new Promise(r => setTimeout(r, INTERVAL_S * 1000));
  }
}

main().catch(err => {
  console.error("\n✗ Fatal:", err.message || err);
  if (err.logs) err.logs.forEach((l: string) => console.error(`    ${l}`));
  process.exit(1);
});
