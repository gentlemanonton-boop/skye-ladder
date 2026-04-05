/**
 * test-buy-wallets.ts — Create 5 wallets, fund each with 0.05 SOL,
 * and buy SKYE from the bonding curve. Then read each wallet's
 * WalletRecord to verify positions were created correctly.
 *
 * Usage:  npx ts-node scripts/test-buy-wallets.ts
 */

import * as anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
  LAMPORTS_PER_SOL, sendAndConfirmTransaction, Transaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, NATIVE_MINT,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction, getAccount, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

// ── Constants (same as frontend) ──
const SKYE_MINT = new PublicKey("5GtUWP1x4LpKjAzGBZg9sy9TbTqjY2bvJfgfC7aUmAfF");
const SKYE_LADDER_ID = new PublicKey("4THAwb6WSpDyyqMHnJL2VBjU7TCLfLLGC5jtuCiyX5Rz");
const SKYE_CURVE_ID = new PublicKey("5bxtpbYgiMQMJcB1c2cWXGErsiRmAZeyRqRKCXoeZRXf");
const SWAP_DISC = new Uint8Array([248, 198, 158, 145, 225, 117, 135, 200]);
const DECIMALS = 9;
const RPC_URL = "https://api.mainnet-beta.solana.com";

const NUM_WALLETS = 5;
const SOL_PER_WALLET = 0.05; // SOL each wallet gets to buy with
const BUY_AMOUNT = 0.035;    // SOL to actually spend on buy (rest for rent/fees)

// ── Helpers ──
function loadKeypair(): Keypair {
  const p = path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
}

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

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Skye Ladder — Multi-Wallet Buy Test (Mainnet)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const mainWallet = loadKeypair();
  const connection = new Connection(RPC_URL, { commitment: "confirmed", confirmTransactionInitialTimeout: 60000 });

  log(`Main wallet: ${mainWallet.publicKey.toBase58()}`);
  const balance = await connection.getBalance(mainWallet.publicKey);
  log(`Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  const totalNeeded = NUM_WALLETS * SOL_PER_WALLET + 0.01; // + buffer for main wallet fees
  if (balance < totalNeeded * LAMPORTS_PER_SOL) {
    console.error(`  ✗ Need ${totalNeeded} SOL, have ${(balance / LAMPORTS_PER_SOL).toFixed(4)}`);
    process.exit(1);
  }

  // Derive shared PDAs
  const [curvePDA] = getCurvePDA();
  const [configPDA] = getConfigPDA();
  const [extraMetasPDA] = getExtraMetasPDA();
  const tokenReserve = getAssociatedTokenAddressSync(SKYE_MINT, curvePDA, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const solReserve = getAssociatedTokenAddressSync(NATIVE_MINT, curvePDA, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const [curveWR] = PublicKey.findProgramAddressSync([Buffer.from("wallet"), curvePDA.toBuffer(), SKYE_MINT.toBuffer()], SKYE_LADDER_ID);

  // Load Anchor for createWalletRecord
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(mainWallet), { commitment: "confirmed" });
  const ladderIdl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "skye_ladder.json"), "utf-8"));
  const ladderProgram = new anchor.Program(ladderIdl, provider);

  log(`Curve:  ${curvePDA.toBase58()}`);
  log(`Config: ${configPDA.toBase58()}\n`);

  // ── Step 1: Generate wallets ──
  console.log(`  [1/4] Generating ${NUM_WALLETS} test wallets...`);
  const wallets: Keypair[] = [];
  for (let i = 0; i < NUM_WALLETS; i++) {
    wallets.push(Keypair.generate());
    log(`  W${i + 1}: ${wallets[i].publicKey.toBase58()}`);
  }

  // ── Step 2: Fund all wallets in one TX ──
  console.log(`\n  [2/4] Funding wallets (${SOL_PER_WALLET} SOL each)...`);
  const fundTx = new Transaction();
  for (const w of wallets) {
    fundTx.add(SystemProgram.transfer({
      fromPubkey: mainWallet.publicKey,
      toPubkey: w.publicKey,
      lamports: Math.floor(SOL_PER_WALLET * LAMPORTS_PER_SOL),
    }));
  }
  const fundSig = await sendAndConfirmTransaction(connection, fundTx, [mainWallet]);
  log(`Funded all wallets. TX: ${fundSig}\n`);

  // ── Step 3: Buy from curve with each wallet ──
  console.log(`  [3/4] Buying SKYE with each wallet (${BUY_AMOUNT} SOL each)...`);

  const results: { wallet: string; tokens: string; tx: string; error?: string }[] = [];

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const label = `W${i + 1}`;
    console.log(`\n  ── ${label}: ${w.publicKey.toBase58().slice(0, 8)}... ──`);

    try {
      const userToken = getAssociatedTokenAddressSync(SKYE_MINT, w.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, w.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const [buyerWR] = getWalletRecordPDA(w.publicKey);

      const ixs: TransactionInstruction[] = [];

      // Create SKYE ATA (main wallet pays rent, buyer owns)
      ixs.push(createAssociatedTokenAccountInstruction(w.publicKey, userToken, w.publicKey, SKYE_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));

      // Create WSOL ATA
      ixs.push(createAssociatedTokenAccountInstruction(w.publicKey, userWsol, w.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));

      // Create WalletRecord
      const wrInfo = await connection.getAccountInfo(buyerWR);
      if (!wrInfo) {
        // @ts-ignore
        ixs.push(await ladderProgram.methods.createWalletRecord()
          .accounts({ payer: w.publicKey, wallet: w.publicKey, mint: SKYE_MINT, walletRecord: buyerWR, systemProgram: SystemProgram.programId })
          .instruction());
      }

      // Transfer SOL → WSOL
      const buyLamports = Math.floor(BUY_AMOUNT * LAMPORTS_PER_SOL);
      ixs.push(SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: userWsol, lamports: buyLamports }));
      ixs.push(createSyncNativeInstruction(userWsol, TOKEN_PROGRAM_ID));

      // Build swap instruction
      const senderWR = curveWR;   // buy: curve sends tokens
      const receiverWR = buyerWR; // buy: buyer receives tokens

      const hookAccounts = [
        { pubkey: configPDA, isSigner: false, isWritable: false },
        { pubkey: senderWR, isSigner: false, isWritable: true },
        { pubkey: receiverWR, isSigner: false, isWritable: true },
        { pubkey: curvePDA, isSigner: false, isWritable: false },
        { pubkey: SKYE_LADDER_ID, isSigner: false, isWritable: false },
        { pubkey: extraMetasPDA, isSigner: false, isWritable: false },
      ];

      const swapData = Buffer.alloc(8 + 8 + 8 + 1);
      swapData.set(SWAP_DISC, 0);
      swapData.writeBigUInt64LE(BigInt(buyLamports), 8);
      swapData.writeBigUInt64LE(0n, 16); // minOut = 0 for test
      swapData[24] = 1; // buy = true

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

      // Send as versioned transaction
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

      // Read token balance
      const acct = await getAccount(connection, userToken, "confirmed", TOKEN_2022_PROGRAM_ID);
      const tokensHuman = (Number(acct.amount) / 10 ** DECIMALS).toLocaleString();
      log(`✓ Bought ${tokensHuman} SKYE for ${BUY_AMOUNT} SOL | TX: ${sig}`);
      results.push({ wallet: w.publicKey.toBase58(), tokens: tokensHuman, tx: sig });
    } catch (e: any) {
      log(`✗ ${label} failed: ${e.message}`);
      if (e.logs) e.logs.slice(-5).forEach((l: string) => log(`  ${l}`));
      results.push({ wallet: w.publicKey.toBase58(), tokens: "0", tx: "", error: e.message });
    }
  }

  // ── Step 4: Read WalletRecords and verify positions ──
  console.log(`\n  [4/4] Verifying WalletRecords + positions...\n`);

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const [wrPDA] = getWalletRecordPDA(w.publicKey);
    const label = `W${i + 1}`;

    try {
      // @ts-ignore
      const wr = await ladderProgram.account.walletRecord.fetch(wrPDA);
      log(`${label} — ${wr.positions.length} position(s):`);
      for (let j = 0; j < wr.positions.length; j++) {
        const p = wr.positions[j];
        const tokens = (Number(p.tokenBalance) / 10 ** DECIMALS).toLocaleString();
        const entryPrice = Number(p.entryPrice) / 1e18;
        log(`  [${j}] ${tokens} tokens @ ${entryPrice.toExponential(4)} SOL/token | unlock: ${p.unlockedBps} bps`);
      }
    } catch (e: any) {
      log(`${label} — WalletRecord not found: ${e.message}`);
    }
  }

  // ── Summary ──
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Summary");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Wallets: ${NUM_WALLETS} | Buy: ${BUY_AMOUNT} SOL each | Total: ${(NUM_WALLETS * SOL_PER_WALLET).toFixed(2)} SOL\n`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const status = r.error ? `✗ ${r.error.slice(0, 60)}` : `✓ ${r.tokens} SKYE`;
    console.log(`  W${i + 1}: ${r.wallet.slice(0, 12)}... ${status}`);
  }

  // Save wallet keypairs for later testing (sell tests, etc.)
  const keypairData = wallets.map(w => ({
    publicKey: w.publicKey.toBase58(),
    secretKey: Array.from(w.secretKey),
  }));
  const outPath = path.join(__dirname, ".test-wallets.json");
  fs.writeFileSync(outPath, JSON.stringify(keypairData, null, 2));
  console.log(`\n  Wallet keypairs saved to ${outPath}`);
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("\n  ✗ Test failed:", err.message || err);
  if (err.logs) err.logs.forEach((l: string) => console.error(`    ${l}`));
  process.exit(1);
});
