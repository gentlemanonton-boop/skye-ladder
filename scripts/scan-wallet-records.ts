/**
 * scan-wallet-records.ts — READ-ONLY scanner for live WalletRecord PDAs.
 *
 * Enumerates every WalletRecord owned by the Skye Ladder program for the SKYE
 * mint, deserializes it via the IDL, and reports any positions that would trip
 * the on-chain corruption sanitizers in transfer_hook.rs:
 *
 *   1. entry_price == 0
 *   2. token_balance  > 10^18  (impossible — exceeds total supply)
 *   3. original_balance > 10^18
 *   4. original_balance / token_balance > 100  (stale ratio drift)
 *   5. entry_price > 1000 × current_price  (only if --current-price is given)
 *
 * Purpose: prove whether `sanitize_corrupt_entry_prices` and the
 * load-time corruption filter are still load-bearing on mainnet, so we can
 * decide whether it's safe to delete them.
 *
 * Nothing on-chain changes. No transactions are sent. No keys are loaded.
 *
 * Usage:
 *   npx ts-node scripts/scan-wallet-records.ts
 *   npx ts-node scripts/scan-wallet-records.ts --current-price 0.00000123
 *   npx ts-node scripts/scan-wallet-records.ts --rpc https://your-rpc --json
 */

import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const SKYE_MINT = new PublicKey("5GtUWP1x4LpKjAzGBZg9sy9TbTqjY2bvJfgfC7aUmAfF");
const SKYE_LADDER_ID = new PublicKey("4THAwb6WSpDyyqMHnJL2VBjU7TCLfLLGC5jtuCiyX5Rz");
const PRICE_SCALE = 10n ** 18n;
const MAX_RAW_SUPPLY = 10n ** 18n; // 1B tokens × 10^9 decimals
const STALE_RATIO_THRESHOLD = 100n;
const CORRUPT_PRICE_MULTIPLE = 1000n;

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getFlag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const RPC_URL = getFlag("rpc") || "https://api.mainnet-beta.solana.com";
const CURRENT_PRICE_RAW = getFlag("current-price"); // human price in SOL per token
const JSON_OUT = args.includes("--json");

// Convert human price (e.g. "0.00000123") to scaled u64 matching on-chain layout
let currentPriceScaled: bigint | null = null;
if (CURRENT_PRICE_RAW) {
  const [whole, frac = ""] = CURRENT_PRICE_RAW.split(".");
  const padded = (whole + frac.padEnd(18, "0")).replace(/^0+/, "") || "0";
  const sliced = padded.slice(0, 19); // u64 max ~1.8e19
  currentPriceScaled = BigInt(sliced);
}

type Position = {
  entryPrice: bigint;
  initialSol: bigint;
  tokenBalance: bigint;
  unlockedBps: number;
  originalBalance: bigint;
  soldBefore5x: boolean;
  claimed: boolean;
};

type Finding = {
  reasons: string[];
  position: Position;
  positionIndex: number;
};

type RecordReport = {
  recordPda: string;
  owner: string;
  positionCount: number;
  totalPositions: number;
  findings: Finding[];
};

function classifyPosition(p: Position, idx: number): Finding | null {
  const reasons: string[] = [];

  if (p.entryPrice === 0n) reasons.push("entry_price == 0");
  if (p.tokenBalance > MAX_RAW_SUPPLY)
    reasons.push(`token_balance (${p.tokenBalance}) > total supply (10^18)`);
  if (p.originalBalance > MAX_RAW_SUPPLY)
    reasons.push(`original_balance (${p.originalBalance}) > total supply (10^18)`);
  if (
    p.originalBalance > 0n &&
    p.tokenBalance > 0n &&
    p.originalBalance / p.tokenBalance > STALE_RATIO_THRESHOLD
  ) {
    reasons.push(
      `stale ratio: original/balance = ${p.originalBalance / p.tokenBalance}x (>100x)`
    );
  }
  if (
    currentPriceScaled !== null &&
    p.entryPrice > currentPriceScaled * CORRUPT_PRICE_MULTIPLE
  ) {
    reasons.push(
      `entry_price (${p.entryPrice}) > 1000 × current_price (${currentPriceScaled})`
    );
  }

  return reasons.length ? { reasons, position: p, positionIndex: idx } : null;
}

function toBigInt(x: any): bigint {
  if (typeof x === "bigint") return x;
  if (typeof x === "number") return BigInt(x);
  if (x?.toString) return BigInt(x.toString());
  return BigInt(x);
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");

  // Build a read-only Anchor provider — no real wallet, no signing.
  const dummyWallet = {
    publicKey: PublicKey.default,
    signTransaction: async (tx: any) => tx,
    signAllTransactions: async (txs: any[]) => txs,
    payer: Keypair.generate(),
  };
  const provider = new anchor.AnchorProvider(
    connection,
    dummyWallet as any,
    { commitment: "confirmed" }
  );

  const idlPath = path.join(__dirname, "..", "target", "idl", "skye_ladder.json");
  if (!fs.existsSync(idlPath)) {
    console.error(`✗ IDL not found at ${idlPath}. Run \`anchor build\` first.`);
    process.exit(1);
  }
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider);

  if (!JSON_OUT) {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  Skye Ladder — WalletRecord Corruption Scanner (READ-ONLY)");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(`  RPC: ${RPC_URL}`);
    console.log(`  Mint: ${SKYE_MINT.toBase58()}`);
    console.log(`  Program: ${SKYE_LADDER_ID.toBase58()}`);
    if (currentPriceScaled !== null) {
      console.log(`  Current price (scaled u64): ${currentPriceScaled}`);
    } else {
      console.log("  Current price: NOT PROVIDED — skipping the >1000x check");
      console.log("    (re-run with --current-price <SOL_per_token> to include it)");
    }
    console.log();
    console.log("  Fetching all WalletRecord accounts for this mint...");
  }

  // Filter to records belonging to the SKYE mint. Layout:
  //   [8 disc] [32 owner] [32 mint] ...
  // So the mint pubkey starts at offset 40.
  const records = await (program.account as any).walletRecord.all([
    { memcmp: { offset: 8 + 32, bytes: SKYE_MINT.toBase58() } },
  ]);

  if (!JSON_OUT) {
    console.log(`  Found ${records.length} WalletRecord(s) for this mint.\n`);
  }

  const reports: RecordReport[] = [];
  let totalCorruptPositions = 0;
  let totalCorruptRecords = 0;

  for (const r of records) {
    const account = r.account as any;
    const positions: Position[] = (account.positions || []).map((p: any) => ({
      entryPrice: toBigInt(p.entryPrice),
      initialSol: toBigInt(p.initialSol),
      tokenBalance: toBigInt(p.tokenBalance),
      unlockedBps: Number(p.unlockedBps),
      originalBalance: toBigInt(p.originalBalance ?? 0),
      soldBefore5x: Boolean(p.soldBefore5x),
      claimed: Boolean(p.claimed),
    }));

    const findings: Finding[] = [];
    positions.forEach((p, idx) => {
      const f = classifyPosition(p, idx);
      if (f) findings.push(f);
    });

    if (findings.length > 0) {
      totalCorruptRecords++;
      totalCorruptPositions += findings.length;
    }

    reports.push({
      recordPda: r.publicKey.toBase58(),
      owner: account.owner.toBase58(),
      positionCount: Number(account.positionCount ?? positions.length),
      totalPositions: positions.length,
      findings,
    });
  }

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          rpc: RPC_URL,
          mint: SKYE_MINT.toBase58(),
          program: SKYE_LADDER_ID.toBase58(),
          currentPriceScaled: currentPriceScaled?.toString() ?? null,
          totalRecords: records.length,
          recordsWithCorruption: totalCorruptRecords,
          corruptPositions: totalCorruptPositions,
          reports,
        },
        (_, v) => (typeof v === "bigint" ? v.toString() : v),
        2
      )
    );
    return;
  }

  // Human-readable output
  if (totalCorruptRecords === 0) {
    console.log("  ✓ NO CORRUPTION DETECTED");
    console.log(`    All ${records.length} records pass every sanitizer check.`);
    if (currentPriceScaled === null) {
      console.log("    (Note: re-run with --current-price to also test the >1000x rule.)");
    } else {
      console.log("    Safe to delete sanitize_corrupt_entry_prices and the");
      console.log("    load-time corruption filter in transfer_hook.rs.");
    }
  } else {
    console.log(`  ⚠ FOUND ${totalCorruptPositions} CORRUPT POSITION(S) ACROSS ${totalCorruptRecords} RECORD(S):\n`);
    for (const rep of reports) {
      if (rep.findings.length === 0) continue;
      console.log(`  Record: ${rep.recordPda}`);
      console.log(`  Owner:  ${rep.owner}`);
      console.log(`  Positions: ${rep.totalPositions} (${rep.findings.length} flagged)`);
      for (const f of rep.findings) {
        console.log(`    [#${f.positionIndex}]`);
        console.log(`       entry_price      = ${f.position.entryPrice}`);
        console.log(`       token_balance    = ${f.position.tokenBalance}`);
        console.log(`       original_balance = ${f.position.originalBalance}`);
        console.log(`       unlocked_bps     = ${f.position.unlockedBps}`);
        for (const reason of f.reasons) {
          console.log(`       ✗ ${reason}`);
        }
      }
      console.log();
    }
    console.log("  → DO NOT delete the sanitizers yet. Investigate these records first.");
  }
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("\n  ✗ Scan failed:", err.message || err);
  if (err.logs) err.logs.forEach((l: string) => console.error(`    ${l}`));
  process.exit(1);
});
