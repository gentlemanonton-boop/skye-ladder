/**
 * test-sell-wallets.ts — Load the 5 test wallets, shuffle them,
 * and attempt sells at various amounts to verify the Skye Ladder
 * restrictions are enforced correctly.
 *
 * Tests:
 *   - Sell 100% (should FAIL — price hasn't moved, only at entry = underwater rule)
 *   - Sell 50% (should FAIL or PASS depending on multiplier)
 *   - Small sell (should PASS if underwater/at entry)
 *   - Read final positions
 *
 * Usage:  npx ts-node scripts/test-sell-wallets.ts
 */

import * as anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, NATIVE_MINT,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction, getAccount, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

// ── Constants ──
const SKYE_MINT = new PublicKey("5GtUWP1x4LpKjAzGBZg9sy9TbTqjY2bvJfgfC7aUmAfF");
const SKYE_LADDER_ID = new PublicKey("4THAwb6WSpDyyqMHnJL2VBjU7TCLfLLGC5jtuCiyX5Rz");
const SKYE_CURVE_ID = new PublicKey("5bxtpbYgiMQMJcB1c2cWXGErsiRmAZeyRqRKCXoeZRXf");
const SWAP_DISC = new Uint8Array([248, 198, 158, 145, 225, 117, 135, 200]);
const DECIMALS = 9;
const RPC_URL = "https://api.mainnet-beta.solana.com";

// ── PDA helpers ──
function getCurvePDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("curve"), SKYE_MINT.toBuffer()], SKYE_CURVE_ID);
}
function getConfigPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("config"), SKYE_MINT.toBuffer()], SKYE_LADDER_ID);
}
function getExtraMetasPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), SKYE_MINT.toBuffer()], SKYE_LADDER_ID);
}
function getWalletRecordPDA(wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("wallet"), wallet.toBuffer(), SKYE_MINT.toBuffer()], SKYE_LADDER_ID);
}

function log(msg: string) { console.log(`  ${msg}`); }

/** Fisher-Yates shuffle */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Build a sell swap instruction */
function buildSellIx(
  user: PublicKey,
  sellAmountRaw: bigint,
  accounts: {
    curvePDA: PublicKey; userToken: PublicKey; userWsol: PublicKey;
    tokenReserve: PublicKey; solReserve: PublicKey;
    configPDA: PublicKey; buyerWR: PublicKey; curveWR: PublicKey;
    extraMetasPDA: PublicKey;
  },
): TransactionInstruction {
  const hookAccounts = [
    { pubkey: accounts.configPDA, isSigner: false, isWritable: false },
    { pubkey: accounts.buyerWR, isSigner: false, isWritable: true },    // sender = seller
    { pubkey: accounts.curveWR, isSigner: false, isWritable: true },    // receiver = curve
    { pubkey: accounts.curvePDA, isSigner: false, isWritable: false },
    { pubkey: SKYE_LADDER_ID, isSigner: false, isWritable: false },
    { pubkey: accounts.extraMetasPDA, isSigner: false, isWritable: false },
  ];

  const swapData = Buffer.alloc(25);
  swapData.set(SWAP_DISC, 0);
  swapData.writeBigUInt64LE(sellAmountRaw, 8);
  swapData.writeBigUInt64LE(0n, 16); // minOut = 0
  swapData[24] = 0; // sell

  return new TransactionInstruction({
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: accounts.curvePDA, isSigner: false, isWritable: true },
      { pubkey: SKYE_MINT, isSigner: false, isWritable: false },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: accounts.userToken, isSigner: false, isWritable: true },
      { pubkey: accounts.userWsol, isSigner: false, isWritable: true },
      { pubkey: accounts.tokenReserve, isSigner: false, isWritable: true },
      { pubkey: accounts.solReserve, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ...hookAccounts,
    ],
    programId: SKYE_CURVE_ID,
    data: swapData,
  });
}

interface SellTest {
  label: string;
  pctOfBalance: number;
  expectFail: boolean;
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Skye Ladder — Sell Restriction Test (Random Order)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Load test wallets
  const walletsPath = path.join(__dirname, ".test-wallets.json");
  if (!fs.existsSync(walletsPath)) {
    console.error("  ✗ No .test-wallets.json found. Run test-buy-wallets.ts first.");
    process.exit(1);
  }

  const walletData = JSON.parse(fs.readFileSync(walletsPath, "utf-8")) as { publicKey: string; secretKey: number[] }[];
  const wallets = walletData.map(w => Keypair.fromSecretKey(Uint8Array.from(w.secretKey)));

  const connection = new Connection(RPC_URL, { commitment: "confirmed", confirmTransactionInitialTimeout: 60000 });

  // Shared PDAs
  const [curvePDA] = getCurvePDA();
  const [configPDA] = getConfigPDA();
  const [extraMetasPDA] = getExtraMetasPDA();
  const tokenReserve = getAssociatedTokenAddressSync(SKYE_MINT, curvePDA, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const solReserve = getAssociatedTokenAddressSync(NATIVE_MINT, curvePDA, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const [curveWR] = PublicKey.findProgramAddressSync([Buffer.from("wallet"), curvePDA.toBuffer(), SKYE_MINT.toBuffer()], SKYE_LADDER_ID);

  // Anchor for reading WalletRecords
  const mainWallet = wallets[0]; // just need any signer for provider
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(mainWallet), { commitment: "confirmed" });
  const ladderIdl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "skye_ladder.json"), "utf-8"));
  const ladderProgram = new anchor.Program(ladderIdl, provider);

  // Shuffle wallet order
  const shuffled = shuffle(wallets.map((w, i) => ({ wallet: w, idx: i + 1 })));
  log(`Randomized order: ${shuffled.map(s => `W${s.idx}`).join(" → ")}\n`);

  // Define sell tests per wallet
  const sellTests: SellTest[] = [
    { label: "100% dump", pctOfBalance: 1.0, expectFail: true },
    { label: "50% sell", pctOfBalance: 0.5, expectFail: true },
    { label: "10% sell", pctOfBalance: 0.1, expectFail: true },
    { label: "100% sell (entry price = underwater?)", pctOfBalance: 1.0, expectFail: false },
    { label: "25% sell", pctOfBalance: 0.25, expectFail: true },
  ];

  const results: { wallet: string; label: string; test: string; result: string; solReceived?: string }[] = [];

  for (let t = 0; t < shuffled.length; t++) {
    const { wallet: w, idx } = shuffled[t];
    const test = sellTests[t];
    const wLabel = `W${idx}`;

    console.log(`\n  ════ ${wLabel}: ${test.label} (${(test.pctOfBalance * 100).toFixed(0)}% of balance) ════`);

    const userToken = getAssociatedTokenAddressSync(SKYE_MINT, w.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, w.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const [buyerWR] = getWalletRecordPDA(w.publicKey);

    // Read current balance
    let tokenBalance: bigint;
    try {
      const acct = await getAccount(connection, userToken, "confirmed", TOKEN_2022_PROGRAM_ID);
      tokenBalance = acct.amount;
    } catch {
      log(`✗ No token account found for ${wLabel}`);
      results.push({ wallet: w.publicKey.toBase58(), label: wLabel, test: test.label, result: "NO_TOKENS" });
      continue;
    }

    if (tokenBalance === 0n) {
      log(`✗ ${wLabel} has 0 tokens`);
      results.push({ wallet: w.publicKey.toBase58(), label: wLabel, test: test.label, result: "ZERO_BALANCE" });
      continue;
    }

    const tokensHuman = (Number(tokenBalance) / 10 ** DECIMALS).toLocaleString();
    const sellAmount = BigInt(Math.floor(Number(tokenBalance) * test.pctOfBalance));
    const sellHuman = (Number(sellAmount) / 10 ** DECIMALS).toLocaleString();
    log(`Balance: ${tokensHuman} SKYE | Attempting to sell: ${sellHuman} SKYE`);

    // Read position info
    try {
      // @ts-ignore
      const wr = await ladderProgram.account.walletRecord.fetch(buyerWR);
      for (const p of wr.positions) {
        const entryPrice = Number(p.entryPrice) / 1e18;
        log(`Position: ${(Number(p.tokenBalance) / 1e9).toLocaleString()} tokens @ ${entryPrice.toExponential(4)} | unlock: ${p.unlockedBps} bps`);
      }
    } catch { /* ok */ }

    try {
      const ixs: TransactionInstruction[] = [];

      // Ensure WSOL ATA exists
      const wsolInfo = await connection.getAccountInfo(userWsol);
      if (!wsolInfo) {
        ixs.push(createAssociatedTokenAccountInstruction(w.publicKey, userWsol, w.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
      }

      // Sell instruction
      ixs.push(buildSellIx(w.publicKey, sellAmount, {
        curvePDA, userToken, userWsol, tokenReserve, solReserve,
        configPDA, buyerWR, curveWR, extraMetasPDA,
      }));

      // Close WSOL to unwrap
      ixs.push(createCloseAccountInstruction(userWsol, w.publicKey, w.publicKey, [], TOKEN_PROGRAM_ID));

      const solBefore = await connection.getBalance(w.publicKey);

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      const messageV0 = new TransactionMessage({
        payerKey: w.publicKey,
        recentBlockhash: blockhash,
        instructions: ixs,
      }).compileToV0Message();
      const vtx = new VersionedTransaction(messageV0);
      vtx.sign([w]);

      const sig = await connection.sendRawTransaction(vtx.serialize());
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");

      const solAfter = await connection.getBalance(w.publicKey);
      const solReceived = ((solAfter - solBefore) / LAMPORTS_PER_SOL).toFixed(6);

      log(`✓ SELL SUCCEEDED | +${solReceived} SOL | TX: ${sig}`);
      results.push({ wallet: w.publicKey.toBase58(), label: wLabel, test: test.label, result: "PASSED", solReceived });

    } catch (e: any) {
      const msg = e.message || "";
      if (msg.includes("SellExceedsUnlocked") || (e.logs && e.logs.some((l: string) => l.includes("SellExceedsUnlocked")))) {
        log(`✓ CORRECTLY REJECTED: SellExceedsUnlocked — ladder enforced!`);
        results.push({ wallet: w.publicKey.toBase58(), label: wLabel, test: test.label, result: "REJECTED_CORRECTLY" });
      } else {
        log(`✗ FAILED: ${msg.slice(0, 120)}`);
        if (e.logs) e.logs.slice(-5).forEach((l: string) => log(`  ${l}`));
        results.push({ wallet: w.publicKey.toBase58(), label: wLabel, test: test.label, result: `ERROR: ${msg.slice(0, 80)}` });
      }
    }

    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 2000));
  }

  // ── Final state ──
  console.log("\n\n  ════ Final Wallet States ════\n");
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const userToken = getAssociatedTokenAddressSync(SKYE_MINT, w.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    try {
      const acct = await getAccount(connection, userToken, "confirmed", TOKEN_2022_PROGRAM_ID);
      const bal = (Number(acct.amount) / 10 ** DECIMALS).toLocaleString();
      const solBal = (await connection.getBalance(w.publicKey)) / LAMPORTS_PER_SOL;
      log(`W${i + 1}: ${bal} SKYE | ${solBal.toFixed(4)} SOL`);
    } catch {
      log(`W${i + 1}: no token account`);
    }
  }

  // ── Summary ──
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Sell Test Results");
  console.log("═══════════════════════════════════════════════════════════════\n");

  for (const r of results) {
    const icon = r.result === "REJECTED_CORRECTLY" ? "🛡" : r.result === "PASSED" ? "✓" : "✗";
    const sol = r.solReceived ? ` (+${r.solReceived} SOL)` : "";
    console.log(`  ${icon} ${r.label} | ${r.test} → ${r.result}${sol}`);
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("\n  ✗ Test failed:", err.message || err);
  if (err.logs) err.logs.forEach((l: string) => console.error(`    ${l}`));
  process.exit(1);
});
