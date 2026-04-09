/**
 * graduate-watcher.ts — Automatic graduation relayer for SKYE.
 *
 * Polls the SKYE bonding curve and fires the curve's `graduate` instruction
 * the moment `real_sol_reserve >= graduation_sol`. Matches pump.fun's
 * relayer model: zero manual ops at the moment of bonding, atomic migration
 * into the AMM, LP burned to incinerator.
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
const SKYE_MINT          = new PublicKey("5GtUWP1x4LpKjAzGBZg9sy9TbTqjY2bvJfgfC7aUmAfF");
const SKYE_CURVE_ID      = new PublicKey("5bxtpbYgiMQMJcB1c2cWXGErsiRmAZeyRqRKCXoeZRXf");
const SKYE_AMM_ID        = new PublicKey("GRBvJRRJfV3CzRLocGcr3NTptWQpu1G4nW9Jpff5TFoX");
const SKYE_LADDER_ID     = new PublicKey("4THAwb6WSpDyyqMHnJL2VBjU7TCLfLLGC5jtuCiyX5Rz");
const INCINERATOR        = new PublicKey("1nc1nerator11111111111111111111111111111111");

// Curve account field offsets (matches Curve struct in skye-curve/src/state.rs)
const CURVE_REAL_SOL_OFFSET   = 184;
const CURVE_REAL_TOKEN_OFFSET = 192;
const CURVE_GRADUATED_OFFSET  = 210;
const CURVE_GRADUATION_OFFSET = 211;

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

// ── PDA derivations ──────────────────────────────────────────────────────────
function curvePda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("curve"), SKYE_MINT.toBuffer()],
    SKYE_CURVE_ID,
  );
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
function hookConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config"), SKYE_MINT.toBuffer()],
    SKYE_LADDER_ID,
  );
}
function hookExtraMetasPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), SKYE_MINT.toBuffer()],
    SKYE_LADDER_ID,
  );
}
function walletRecordPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("wallet"), owner.toBuffer(), SKYE_MINT.toBuffer()],
    SKYE_LADDER_ID,
  );
}

// ── Curve state ──────────────────────────────────────────────────────────────
interface CurveState {
  realSol: bigint;
  realTokens: bigint;
  graduated: boolean;
  graduationSol: bigint;
}

async function fetchCurveState(conn: Connection, curve: PublicKey): Promise<CurveState | null> {
  const acct = await conn.getAccountInfo(curve, "confirmed");
  if (!acct || acct.data.length < 220) return null;
  const data = acct.data;
  return {
    realSol:       data.readBigUInt64LE(CURVE_REAL_SOL_OFFSET),
    realTokens:    data.readBigUInt64LE(CURVE_REAL_TOKEN_OFFSET),
    graduated:     data[CURVE_GRADUATED_OFFSET] === 1,
    graduationSol: data.readBigUInt64LE(CURVE_GRADUATION_OFFSET),
  };
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
    { pubkey: SKYE_MINT,                 isSigner: false, isWritable: false },
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

// ── Try to fire graduate ─────────────────────────────────────────────────────
async function tryGraduate(
  conn: Connection,
  payer: Keypair,
  state: CurveState,
): Promise<"graduated" | "skipped" | "error"> {
  const [curve]      = curvePda();
  const [pool]       = poolPda();
  const [lpAuth]     = lpAuthorityPda(pool);
  const [hookCfg]    = hookConfigPda();
  const [extraMetas] = hookExtraMetasPda();
  const [senderWR]   = walletRecordPda(curve);
  const [receiverWR] = walletRecordPda(pool);

  const curveTokenReserve = getAssociatedTokenAddressSync(
    SKYE_MINT, curve, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const curveSolReserve = getAssociatedTokenAddressSync(
    NATIVE_MINT, curve, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const ammTokenReserve = getAssociatedTokenAddressSync(
    SKYE_MINT, pool, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const ammSolReserve = getAssociatedTokenAddressSync(
    NATIVE_MINT, pool, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  // Read pool to get the lp_mint address (set during pre-stage)
  const poolAcct = await conn.getAccountInfo(pool, "confirmed");
  if (!poolAcct) {
    console.error(`[${ts()}] ✗ AMM Pool PDA not found — has the pre-stage script been run?`);
    return "error";
  }
  // Pool layout: 8 disc + 32 auth + 32 skye + 32 wsol + 32 skye_res + 32 wsol_res + 32 lp_mint
  // lp_mint is at offset 8 + 4*32 = 136
  const lpMint = new PublicKey(poolAcct.data.subarray(8 + 32 * 5, 8 + 32 * 6));

  const incineratorLpAccount = getAssociatedTokenAddressSync(
    lpMint, INCINERATOR, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  // Read hook config for lb_pair (the price source the hook validates)
  const lbPair = await fetchHookLbPair(conn, hookCfg);

  console.log(`[${ts()}] → Building graduate transaction...`);
  console.log(`         payer:        ${payer.publicKey.toBase58()}`);
  console.log(`         realSol:      ${fmtSol(state.realSol)} / ${fmtSol(state.graduationSol)} SOL`);
  console.log(`         realTokens:   ${(Number(state.realTokens) / 1e9).toFixed(2)} SKYE`);
  console.log(`         pool:         ${pool.toBase58()}`);
  console.log(`         lp_mint:      ${lpMint.toBase58()}`);
  console.log(`         incinerator:  ${incineratorLpAccount.toBase58()}`);
  console.log(`         lb_pair:      ${lbPair.toBase58()}`);

  const ix = buildGraduateIx({
    payer: payer.publicKey,
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
    console.log(`[${ts()}] ✓ GRADUATED! tx: ${sig}`);
    console.log(`         https://solscan.io/tx/${sig}`);
    return "graduated";
  } catch (e: any) {
    const msg = e.message || String(e);
    const logs: string[] = e.logs || [];

    // Common "expected" failures we should treat as success
    if (logs.some(l => l.includes("AlreadyGraduated")) || msg.includes("AlreadyGraduated")) {
      console.log(`[${ts()}] ✓ Curve already graduated (someone else fired graduate first). Done.`);
      return "graduated";
    }

    if (logs.some(l => l.includes("InsufficientLiquidity"))) {
      console.log(`[${ts()}] ⚠ Curve below threshold (race condition — realSol dropped between read and tx). Will retry.`);
      return "skipped";
    }

    console.error(`[${ts()}] ✗ Graduate failed: ${msg}`);
    if (logs.length > 0) {
      console.error("         on-chain logs:");
      logs.slice(0, 30).forEach(l => console.error(`           ${l}`));
    }
    return "error";
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

  const [curve] = curvePda();
  console.log(`  Curve:    ${curve.toBase58()}`);
  console.log();

  // ── Polling loop ──
  let iter = 0;
  while (true) {
    iter++;
    try {
      const state = await fetchCurveState(conn, curve);
      if (!state) {
        console.error(`[${ts()}] ✗ Curve PDA not found — wrong network or wrong mint?`);
        process.exit(1);
      }

      const ratio = (Number(state.realSol) / Number(state.graduationSol) * 100).toFixed(1);
      const status = state.graduated ? "GRADUATED" : `${fmtSol(state.realSol)} / ${fmtSol(state.graduationSol)} SOL (${ratio}%)`;
      console.log(`[${ts()}] poll #${iter}: ${status}`);

      if (state.graduated) {
        console.log(`[${ts()}] ✓ Curve is already graduated. Nothing to do. Exiting.`);
        process.exit(0);
      }

      if (state.realSol >= state.graduationSol) {
        console.log(`[${ts()}] ▲ THRESHOLD REACHED — firing graduate`);
        const result = await tryGraduate(conn, payer, state);
        if (result === "graduated") {
          console.log(`[${ts()}] ✓ Done. Exiting cleanly.`);
          process.exit(0);
        }
        // result === "skipped" or "error" → fall through to retry
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
