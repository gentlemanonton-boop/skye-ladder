/**
 * test-pump-and-sell.ts — All 5 wallets buy big to pump the price,
 * then attempt sells at various % to test ladder restrictions.
 *
 * Phase 1: All wallets buy with ~0.45 SOL each (pump price)
 * Phase 2: Read multipliers for each position
 * Phase 3: Attempt sells in random order at various %
 *
 * Usage:  npx ts-node scripts/test-pump-and-sell.ts
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
  createSyncNativeInstruction, createCloseAccountInstruction,
  getAccount, ASSOCIATED_TOKEN_PROGRAM_ID,
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
const BUY_SOL = 0.45; // leave ~0.05 for fees

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

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function sendTx(connection: Connection, w: Keypair, ixs: TransactionInstruction[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: w.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  vtx.sign([w]);
  const sig = await connection.sendRawTransaction(vtx.serialize());
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Skye Ladder — Pump & Sell Restriction Test");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const walletsPath = path.join(__dirname, ".test-wallets.json");
  const walletData = JSON.parse(fs.readFileSync(walletsPath, "utf-8")) as { publicKey: string; secretKey: number[] }[];
  const wallets = walletData.map(w => Keypair.fromSecretKey(Uint8Array.from(w.secretKey)));
  const connection = new Connection(RPC_URL, { commitment: "confirmed", confirmTransactionInitialTimeout: 60000 });

  const [curvePDA] = getCurvePDA();
  const [configPDA] = getConfigPDA();
  const [extraMetasPDA] = getExtraMetasPDA();
  const tokenReserve = getAssociatedTokenAddressSync(SKYE_MINT, curvePDA, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const solReserve = getAssociatedTokenAddressSync(NATIVE_MINT, curvePDA, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const [curveWR] = PublicKey.findProgramAddressSync([Buffer.from("wallet"), curvePDA.toBuffer(), SKYE_MINT.toBuffer()], SKYE_LADDER_ID);

  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallets[0]), { commitment: "confirmed" });
  const ladderIdl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "skye_ladder.json"), "utf-8"));
  const ladderProgram = new anchor.Program(ladderIdl, provider);

  // ══════════════════════════════════════════════════
  // PHASE 1: All wallets buy to pump price
  // ══════════════════════════════════════════════════
  console.log(`  [PHASE 1] All 5 wallets buying with ${BUY_SOL} SOL each...\n`);

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const label = `W${i + 1}`;

    try {
      const userToken = getAssociatedTokenAddressSync(SKYE_MINT, w.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, w.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const [buyerWR] = getWalletRecordPDA(w.publicKey);

      const ixs: TransactionInstruction[] = [];

      // Create ATAs if needed
      const [tokenInfo, wsolInfo, wrInfo] = await Promise.all([
        connection.getAccountInfo(userToken),
        connection.getAccountInfo(userWsol),
        connection.getAccountInfo(buyerWR),
      ]);

      if (!tokenInfo) ixs.push(createAssociatedTokenAccountInstruction(w.publicKey, userToken, w.publicKey, SKYE_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
      if (!wsolInfo) ixs.push(createAssociatedTokenAccountInstruction(w.publicKey, userWsol, w.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
      if (!wrInfo) {
        // @ts-ignore
        ixs.push(await ladderProgram.methods.createWalletRecord()
          .accounts({ payer: w.publicKey, wallet: w.publicKey, mint: SKYE_MINT, walletRecord: buyerWR, systemProgram: SystemProgram.programId })
          .instruction());
      }

      const buyLamports = Math.floor(BUY_SOL * LAMPORTS_PER_SOL);
      ixs.push(SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: userWsol, lamports: buyLamports }));
      ixs.push(createSyncNativeInstruction(userWsol, TOKEN_PROGRAM_ID));

      // Swap
      const hookAccounts = [
        { pubkey: configPDA, isSigner: false, isWritable: false },
        { pubkey: curveWR, isSigner: false, isWritable: true },
        { pubkey: buyerWR, isSigner: false, isWritable: true },
        { pubkey: curvePDA, isSigner: false, isWritable: false },
        { pubkey: SKYE_LADDER_ID, isSigner: false, isWritable: false },
        { pubkey: extraMetasPDA, isSigner: false, isWritable: false },
      ];

      const swapData = Buffer.alloc(25);
      swapData.set(SWAP_DISC, 0);
      swapData.writeBigUInt64LE(BigInt(buyLamports), 8);
      swapData.writeBigUInt64LE(0n, 16);
      swapData[24] = 1;

      ixs.push(new TransactionInstruction({
        keys: [
          { pubkey: w.publicKey, isSigner: true, isWritable: true },
          { pubkey: curvePDA, isSigner: false, isWritable: true },
          { pubkey: SKYE_MINT, isSigner: false, isWritable: false },
          { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
          { pubkey: userToken, isSigner: false, isWritable: true },
          { pubkey: userWsol, isSigner: false, isWritable: true },
          { pubkey: tokenReserve, isSigner: false, isWritable: true },
          { pubkey: solReserve, isSigner: false, isWritable: true },
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ...hookAccounts,
        ],
        programId: SKYE_CURVE_ID,
        data: swapData,
      }));

      const sig = await sendTx(connection, w, ixs);
      const acct = await getAccount(connection, userToken, "confirmed", TOKEN_2022_PROGRAM_ID);
      const tokens = (Number(acct.amount) / 10 ** DECIMALS).toLocaleString();
      log(`✓ ${label} bought ${tokens} SKYE for ${BUY_SOL} SOL | TX: ${sig}`);
    } catch (e: any) {
      log(`✗ ${label} buy failed: ${e.message?.slice(0, 120)}`);
      if (e.logs) e.logs.slice(-3).forEach((l: string) => log(`  ${l}`));
    }

    await new Promise(r => setTimeout(r, 1500));
  }

  // ══════════════════════════════════════════════════
  // PHASE 2: Read positions + multipliers
  // ══════════════════════════════════════════════════
  console.log(`\n  [PHASE 2] Reading positions + multipliers...\n`);

  // Read curve state to get current price
  const solReserveAcct = await getAccount(connection, solReserve, "confirmed", TOKEN_PROGRAM_ID);
  const tokenReserveAcct = await getAccount(connection, tokenReserve, "confirmed", TOKEN_2022_PROGRAM_ID);
  const currentPrice = Number(solReserveAcct.amount) / Number(tokenReserveAcct.amount);
  log(`Current spot price: ${currentPrice.toExponential(4)} SOL/token`);
  log(`SOL reserve: ${(Number(solReserveAcct.amount) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  log(`Token reserve: ${(Number(tokenReserveAcct.amount) / 10**DECIMALS).toLocaleString()} SKYE\n`);

  const positionData: { wallet: Keypair; idx: number; positions: any[]; totalTokens: bigint }[] = [];

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const [wrPDA] = getWalletRecordPDA(w.publicKey);
    try {
      // @ts-ignore
      const wr = await ladderProgram.account.walletRecord.fetch(wrPDA);
      log(`W${i + 1}: ${wr.positions.length} position(s)`);

      let totalTokens = BigInt(0);
      for (const p of wr.positions) {
        const entryPrice = Number(p.entryPrice) / 1e18;
        const mult = currentPrice / entryPrice;
        const tokens = Number(p.tokenBalance) / 10 ** DECIMALS;
        totalTokens += BigInt(p.tokenBalance.toString());
        log(`  entry: ${entryPrice.toExponential(4)} | mult: ${mult.toFixed(2)}x | ${tokens.toLocaleString()} tokens | unlock: ${p.unlockedBps} bps`);
      }
      positionData.push({ wallet: w, idx: i + 1, positions: wr.positions, totalTokens });
    } catch (e: any) {
      log(`W${i + 1}: no WalletRecord`);
    }
  }

  // ══════════════════════════════════════════════════
  // PHASE 3: Sell tests in random order
  // ══════════════════════════════════════════════════
  console.log(`\n  [PHASE 3] Sell tests (random order)...\n`);

  const sellTests = [
    { pct: 1.0, label: "100% dump" },
    { pct: 0.75, label: "75% sell" },
    { pct: 0.50, label: "50% sell" },
    { pct: 0.25, label: "25% sell" },
    { pct: 0.10, label: "10% sell" },
  ];

  const shuffledData = shuffle(positionData);
  log(`Random sell order: ${shuffledData.map(d => `W${d.idx}`).join(" → ")}\n`);

  for (let t = 0; t < shuffledData.length; t++) {
    const { wallet: w, idx, totalTokens } = shuffledData[t];
    const test = sellTests[t];
    const label = `W${idx}`;

    console.log(`  ════ ${label}: ${test.label} ════`);

    if (totalTokens === 0n) {
      log(`${label} has 0 tokens, skipping`);
      continue;
    }

    const userToken = getAssociatedTokenAddressSync(SKYE_MINT, w.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, w.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const [buyerWR] = getWalletRecordPDA(w.publicKey);

    // Get actual on-chain balance
    let actualBalance: bigint;
    try {
      const acct = await getAccount(connection, userToken, "confirmed", TOKEN_2022_PROGRAM_ID);
      actualBalance = acct.amount;
    } catch {
      log(`${label} no token account`);
      continue;
    }

    const sellAmount = BigInt(Math.floor(Number(actualBalance) * test.pct));
    const sellHuman = (Number(sellAmount) / 10 ** DECIMALS).toLocaleString();
    const balHuman = (Number(actualBalance) / 10 ** DECIMALS).toLocaleString();
    log(`Balance: ${balHuman} | Selling: ${sellHuman} (${(test.pct * 100).toFixed(0)}%)`);

    try {
      const ixs: TransactionInstruction[] = [];

      const wsolInfo = await connection.getAccountInfo(userWsol);
      if (!wsolInfo) {
        ixs.push(createAssociatedTokenAccountInstruction(w.publicKey, userWsol, w.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
      }

      // Sell swap
      const hookAccounts = [
        { pubkey: configPDA, isSigner: false, isWritable: false },
        { pubkey: buyerWR, isSigner: false, isWritable: true },
        { pubkey: curveWR, isSigner: false, isWritable: true },
        { pubkey: curvePDA, isSigner: false, isWritable: false },
        { pubkey: SKYE_LADDER_ID, isSigner: false, isWritable: false },
        { pubkey: extraMetasPDA, isSigner: false, isWritable: false },
      ];

      const swapData = Buffer.alloc(25);
      swapData.set(SWAP_DISC, 0);
      swapData.writeBigUInt64LE(sellAmount, 8);
      swapData.writeBigUInt64LE(0n, 16);
      swapData[24] = 0;

      ixs.push(new TransactionInstruction({
        keys: [
          { pubkey: w.publicKey, isSigner: true, isWritable: true },
          { pubkey: curvePDA, isSigner: false, isWritable: true },
          { pubkey: SKYE_MINT, isSigner: false, isWritable: false },
          { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
          { pubkey: userToken, isSigner: false, isWritable: true },
          { pubkey: userWsol, isSigner: false, isWritable: true },
          { pubkey: tokenReserve, isSigner: false, isWritable: true },
          { pubkey: solReserve, isSigner: false, isWritable: true },
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ...hookAccounts,
        ],
        programId: SKYE_CURVE_ID,
        data: swapData,
      }));

      ixs.push(createCloseAccountInstruction(userWsol, w.publicKey, w.publicKey, [], TOKEN_PROGRAM_ID));

      const solBefore = await connection.getBalance(w.publicKey);
      const sig = await sendTx(connection, w, ixs);
      const solAfter = await connection.getBalance(w.publicKey);
      const solReceived = ((solAfter - solBefore) / LAMPORTS_PER_SOL).toFixed(6);

      log(`✓ SELL PASSED: +${solReceived} SOL | TX: ${sig}\n`);
    } catch (e: any) {
      const msg = e.message || "";
      const logs = e.logs || [];
      if (msg.includes("SellExceedsUnlocked") || logs.some((l: string) => l.includes("SellExceedsUnlocked"))) {
        log(`🛡 REJECTED: SellExceedsUnlocked — ladder enforced!\n`);
      } else {
        log(`✗ ERROR: ${msg.slice(0, 120)}`);
        logs.slice(-5).forEach((l: string) => log(`  ${l}`));
        console.log();
      }
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  // ══════════════════════════════════════════════════
  // FINAL STATE
  // ══════════════════════════════════════════════════
  console.log("  ════ Final Wallet States ════\n");

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const userToken = getAssociatedTokenAddressSync(SKYE_MINT, w.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const [wrPDA] = getWalletRecordPDA(w.publicKey);

    let tokenBal = "0";
    try {
      const acct = await getAccount(connection, userToken, "confirmed", TOKEN_2022_PROGRAM_ID);
      tokenBal = (Number(acct.amount) / 10 ** DECIMALS).toLocaleString();
    } catch {}

    const solBal = (await connection.getBalance(w.publicKey)) / LAMPORTS_PER_SOL;

    let posInfo = "";
    try {
      // @ts-ignore
      const wr = await ladderProgram.account.walletRecord.fetch(wrPDA);
      for (const p of wr.positions) {
        const entryPrice = Number(p.entryPrice) / 1e18;
        const mult = currentPrice / entryPrice;
        posInfo += ` | ${mult.toFixed(2)}x @ ${p.unlockedBps}bps`;
      }
    } catch {}

    log(`W${i + 1}: ${tokenBal} SKYE | ${solBal.toFixed(4)} SOL${posInfo}`);
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("\n  ✗ Failed:", err.message || err);
  if (err.logs) err.logs.slice(-5).forEach((l: string) => console.error(`    ${l}`));
  process.exit(1);
});
