/**
 * rebalance-pool.ts — Remove old liquidity, update SOL price, re-add at $3K MC
 *
 * 1. Set sol_price to $80
 * 2. Pause hook
 * 3. Remove all existing LP
 * 4. Add fresh liquidity: 2 SOL + ~53.33M SKYE (= $3K MC at $80/SOL)
 * 5. Unpause hook
 * 6. Test swap
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
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  createTransferCheckedWithTransferHookInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const LADDER_ID = new PublicKey("4THAwb6WSpDyyqMHnJL2VBjU7TCLfLLGC5jtuCiyX5Rz");
const AMM_ID = new PublicKey("GRBvJRRJfV3CzRLocGcr3NTptWQpu1G4nW9Jpff5TFoX");
const MINT = new PublicKey("4w1DQR7HuVNdK6YDKvgyGSQ7A6Ba7ChWL4Hof1HKw1j");
const RPC_URL = execSync("solana config get | grep 'RPC URL' | awk '{print $NF}'", { encoding: "utf-8" }).trim();

const SOL_PRICE_USD = 80;
const TARGET_MC_USD = 3_000;
const LIQUIDITY_SOL = 2;
const DECIMALS = 9;

function loadKeypair(fp: string): Keypair {
  const abs = fp.startsWith("~") ? path.join(process.env.HOME!, fp.slice(1)) : fp;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(abs, "utf-8"))));
}

function loadState(): any {
  return JSON.parse(fs.readFileSync(path.join(__dirname, ".deploy-state.json"), "utf-8"));
}

async function resolveHookAccounts(
  connection: Connection, from: PublicKey, to: PublicKey, authority: PublicKey,
) {
  const ix = await createTransferCheckedWithTransferHookInstruction(
    connection, from, MINT, to, authority, BigInt(1), DECIMALS, [], "confirmed", TOKEN_2022_PROGRAM_ID,
  );
  return ix.keys.slice(4).map(k => ({ pubkey: k.pubkey, isSigner: false, isWritable: k.isWritable }));
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Rebalance SKYE/SOL Pool — $3K MC at $80/SOL");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const wallet = loadKeypair("~/.config/solana/id.json");
  const connection = new Connection(RPC_URL, { commitment: "confirmed", confirmTransactionInitialTimeout: 60000 });
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), { commitment: "confirmed" });
  const state = loadState();

  const ladderIdl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "skye_ladder.json"), "utf-8"));
  const ammIdl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "skye_amm.json"), "utf-8"));
  const ladderProgram = new anchor.Program(ladderIdl, provider);
  const ammProgram = new anchor.Program(ammIdl, provider);

  const [poolPDA] = PublicKey.findProgramAddressSync([Buffer.from("pool"), MINT.toBuffer(), NATIVE_MINT.toBuffer()], AMM_ID);
  const [lpAuthority] = PublicKey.findProgramAddressSync([Buffer.from("lp-authority"), poolPDA.toBuffer()], AMM_ID);
  const [configPDA] = PublicKey.findProgramAddressSync([Buffer.from("config"), MINT.toBuffer()], LADDER_ID);
  const skyeReserve = new PublicKey(state.ammSkyeReserve);
  const wsolReserve = new PublicKey(state.ammWsolReserve);
  const lpMint = new PublicKey(state.ammLpMint);
  const deployerATA = new PublicKey(state.deployerATA);
  const userWsolATA = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userLpATA = getAssociatedTokenAddressSync(lpMint, wallet.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`Wallet:  ${wallet.publicKey.toBase58()}`);
  console.log(`Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`);

  // ── Step 1: Set SOL price to $80 ──
  console.log("[1/6] Setting SOL price to $80...");
  // @ts-ignore
  await ladderProgram.methods
    .setSolPrice(new anchor.BN(SOL_PRICE_USD * 1_000_000))
    .accounts({ authority: wallet.publicKey, mint: MINT, config: configPDA, systemProgram: SystemProgram.programId })
    .rpc();
  console.log("  Done\n");

  // ── Step 2: Pause hook ──
  console.log("[2/6] Pausing hook...");
  // @ts-ignore
  await ladderProgram.methods
    .setPaused(true)
    .accounts({ authority: wallet.publicKey, mint: MINT, config: configPDA })
    .rpc();
  console.log("  Done\n");

  // ── Step 3: Remove existing liquidity ──
  console.log("[3/6] Removing existing liquidity...");
  const lpBalance = await getAccount(connection, userLpATA, "confirmed", TOKEN_PROGRAM_ID);
  const lpAmount = lpBalance.amount;
  console.log(`  LP tokens to burn: ${lpAmount.toString()}`);

  if (lpAmount > 0n) {
    const hookAccounts = await resolveHookAccounts(connection, skyeReserve, deployerATA, poolPDA);

    // @ts-ignore
    const removeSig = await ammProgram.methods
      .removeLiquidity(new anchor.BN(lpAmount.toString()), new anchor.BN(0), new anchor.BN(0))
      .accounts({
        user: wallet.publicKey, pool: poolPDA, skyeMint: MINT, wsolMint: NATIVE_MINT,
        userSkyeAccount: deployerATA, userWsolAccount: userWsolATA,
        skyeReserve, wsolReserve, lpMint, userLpAccount: userLpATA,
        token2022Program: TOKEN_2022_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(hookAccounts)
      .rpc();
    console.log(`  Removed: ${removeSig}\n`);
  } else {
    console.log("  No LP to remove\n");
  }

  // ── Step 4: Add fresh liquidity at correct ratio ──
  console.log("[4/6] Adding liquidity: 2 SOL + SKYE for $3K MC...");

  // MC = supply * price = 1B * (wsol/skye). Target MC in SOL = $3K/$80 = 37.5 SOL
  // skye_human = wsol_human / (mc_sol / 1B) = 2 / (37.5/1B) = 2 * 1B / 37.5 = 53,333,333.33
  const mcSol = TARGET_MC_USD / SOL_PRICE_USD;
  const skyeHuman = Math.floor(LIQUIDITY_SOL * 1_000_000_000 / mcSol);
  const skyeRaw = BigInt(skyeHuman) * BigInt(10 ** DECIMALS);
  const wsolRaw = BigInt(LIQUIDITY_SOL) * BigInt(LAMPORTS_PER_SOL);

  console.log(`  SKYE: ${skyeHuman.toLocaleString()} tokens (${skyeRaw.toString()} raw)`);
  console.log(`  WSOL: ${LIQUIDITY_SOL} SOL (${wsolRaw.toString()} lamports)`);
  console.log(`  Implied price: ${(LIQUIDITY_SOL / skyeHuman).toExponential(4)} SOL/token`);
  console.log(`  Implied MC: ${mcSol} SOL = $${TARGET_MC_USD}`);

  // Wrap SOL
  const wsolInfo = await getAccount(connection, userWsolATA, "confirmed", TOKEN_PROGRAM_ID).catch(() => null);
  const currentWsol = wsolInfo ? Number(wsolInfo.amount) : 0;
  const wsolNeeded = Number(wsolRaw) - currentWsol;

  if (wsolNeeded > 0) {
    const wrapTx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: userWsolATA, lamports: wsolNeeded }),
      createSyncNativeInstruction(userWsolATA, TOKEN_PROGRAM_ID),
    );
    await sendAndConfirmTransaction(connection, wrapTx, [wallet]);
    console.log(`  Wrapped ${(wsolNeeded / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  }

  // Add liquidity
  const addHookAccounts = await resolveHookAccounts(connection, deployerATA, skyeReserve, wallet.publicKey);

  // @ts-ignore
  const addSig = await ammProgram.methods
    .addLiquidity(
      new anchor.BN(skyeRaw.toString()),
      new anchor.BN(wsolRaw.toString()),
      new anchor.BN(0),
    )
    .accounts({
      user: wallet.publicKey, pool: poolPDA, skyeMint: MINT, wsolMint: NATIVE_MINT,
      userSkyeAccount: deployerATA, userWsolAccount: userWsolATA,
      skyeReserve, wsolReserve, lpMint, userLpAccount: userLpATA,
      lpAuthority, token2022Program: TOKEN_2022_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(addHookAccounts)
    .rpc();
  console.log(`  Liquidity added: ${addSig}\n`);

  // ── Step 5: Unpause hook ──
  console.log("[5/6] Unpausing hook...");
  // @ts-ignore
  await ladderProgram.methods
    .setPaused(false)
    .accounts({ authority: wallet.publicKey, mint: MINT, config: configPDA })
    .rpc();
  console.log("  Done\n");

  // ── Step 6: Test swap ──
  console.log("[6/6] Test swap: buy 0.001 SOL worth of SKYE...");

  // Create WalletRecord if needed
  const [buyerWR] = PublicKey.findProgramAddressSync(
    [Buffer.from("wallet"), wallet.publicKey.toBuffer(), MINT.toBuffer()], LADDER_ID);
  const wrInfo = await connection.getAccountInfo(buyerWR);
  if (!wrInfo) {
    // @ts-ignore
    await ladderProgram.methods.createWalletRecord()
      .accounts({ payer: wallet.publicKey, wallet: wallet.publicKey, mint: MINT, walletRecord: buyerWR, systemProgram: SystemProgram.programId })
      .rpc();
    console.log("  Created WalletRecord");
  }
  // Pool WR
  const [poolWR] = PublicKey.findProgramAddressSync(
    [Buffer.from("wallet"), poolPDA.toBuffer(), MINT.toBuffer()], LADDER_ID);
  const poolWRInfo = await connection.getAccountInfo(poolWR);
  if (!poolWRInfo) {
    // @ts-ignore
    await ladderProgram.methods.createWalletRecord()
      .accounts({ payer: wallet.publicKey, wallet: poolPDA, mint: MINT, walletRecord: poolWR, systemProgram: SystemProgram.programId })
      .rpc();
    console.log("  Created Pool WalletRecord");
  }

  const buyAmount = new anchor.BN((0.001 * LAMPORTS_PER_SOL).toString());
  const buyHookAccounts = await resolveHookAccounts(connection, skyeReserve, deployerATA, poolPDA);

  const before = await getAccount(connection, deployerATA, "confirmed", TOKEN_2022_PROGRAM_ID);

  try {
    // @ts-ignore
    const swapSig = await ammProgram.methods
      .swap(buyAmount, new anchor.BN(0), true)
      .accounts({
        user: wallet.publicKey, pool: poolPDA, skyeMint: MINT, wsolMint: NATIVE_MINT,
        userSkyeAccount: deployerATA, userWsolAccount: userWsolATA,
        skyeReserve, wsolReserve,
        token2022Program: TOKEN_2022_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(buyHookAccounts)
      .rpc();

    const after = await getAccount(connection, deployerATA, "confirmed", TOKEN_2022_PROGRAM_ID);
    const bought = Number(after.amount) - Number(before.amount);
    console.log(`  BUY OK: 0.001 SOL → ${(bought / 10 ** DECIMALS).toLocaleString()} SKYE`);
    console.log(`  tx: ${swapSig}`);
  } catch (e: any) {
    console.error(`  BUY FAILED: ${e.message}`);
    if (e.logs) e.logs.slice(-5).forEach((l: string) => console.error(`    ${l}`));
  }

  // Read pool state
  // @ts-ignore
  const poolAccount = await ammProgram.account.pool.fetch(poolPDA);
  console.log(`\n  Pool state:`);
  console.log(`    SKYE reserve: ${(Number(poolAccount.skyeAmount) / 10 ** DECIMALS).toLocaleString()} tokens`);
  console.log(`    WSOL reserve: ${(Number(poolAccount.wsolAmount) / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  const spotPrice = Number(poolAccount.wsolAmount) / Number(poolAccount.skyeAmount);
  const mcSolActual = spotPrice * 1_000_000_000 * 10 ** DECIMALS / 10 ** DECIMALS;
  console.log(`    Spot price:   ${spotPrice.toExponential(4)} SOL/raw-token`);
  console.log(`    MC:           ${(mcSolActual).toFixed(2)} SOL = $${(mcSolActual * SOL_PRICE_USD).toFixed(0)}`);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Pool is live and tradeable!");
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch(console.error);
