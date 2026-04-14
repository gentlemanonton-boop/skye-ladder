/**
 * launch-pumpfun.ts — Launch a promotional SKYE token on pump.fun
 * to drive attention back to the main Skye Ladder platform.
 *
 * Usage: npx ts-node scripts/launch-pumpfun.ts
 */

import {
  Connection, Keypair, LAMPORTS_PER_SOL, VersionedTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const RPC_URL = "https://api.mainnet-beta.solana.com";

function loadKeypair(): Keypair {
  const p = path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Pump.fun — Launch Promotional SKYE Token");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const wallet = loadKeypair();
  const connection = new Connection(RPC_URL, "confirmed");
  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`  Wallet:  ${wallet.publicKey.toBase58()}`);
  console.log(`  Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`);

  // Generate mint keypair for the new token
  const mintKeypair = Keypair.generate();
  console.log(`  Mint:    ${mintKeypair.publicKey.toBase58()}\n`);

  // ── Step 1: Upload metadata to pump.fun IPFS ──
  console.log("  [1/3] Uploading metadata to pump.fun IPFS...");

  const imageBuffer = fs.readFileSync("/tmp/skye_image.jpg");

  const formData = new FormData();
  formData.append("file", new Blob([imageBuffer], { type: "image/jpeg" }), "skye.jpg");
  formData.append("name", "SKYE");
  formData.append("symbol", "SKYE");
  formData.append("description", "trenches fixed");
  formData.append("twitter", "https://x.com/d0uble07__/status/2040560789522681995?s=20");
  formData.append("telegram", "");
  formData.append("website", "https://skyefall.gg");
  formData.append("showName", "true");

  const ipfsResponse = await fetch("https://pump.fun/api/ipfs", {
    method: "POST",
    body: formData,
  });

  if (!ipfsResponse.ok) {
    const text = await ipfsResponse.text();
    throw new Error(`IPFS upload failed: ${ipfsResponse.status} ${text}`);
  }

  const ipfsData = await ipfsResponse.json() as { metadataUri: string };
  console.log(`  Metadata URI: ${ipfsData.metadataUri}\n`);

  // ── Step 2: Get create transaction from pumpportal ──
  console.log("  [2/3] Building create transaction...");

  const createResponse = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publicKey: wallet.publicKey.toBase58(),
      action: "create",
      tokenMetadata: {
        name: "SKYE",
        symbol: "SKYE",
        uri: ipfsData.metadataUri,
      },
      mint: mintKeypair.publicKey.toBase58(),
      denominatedInSol: "true",
      amount: 0, // no initial buy
      slippage: 10,
      priorityFee: 0.0005,
      pool: "pump",
    }),
  });

  if (createResponse.status !== 200) {
    const text = await createResponse.text();
    throw new Error(`Create TX failed: ${createResponse.status} ${text}`);
  }

  // ── Step 3: Sign and send ──
  console.log("  [3/3] Signing and sending transaction...\n");

  const txData = await createResponse.arrayBuffer();
  const tx = VersionedTransaction.deserialize(new Uint8Array(txData));
  tx.sign([wallet, mintKeypair]);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  ✓ TOKEN LAUNCHED ON PUMP.FUN");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Name:     SKYE`);
  console.log(`  Ticker:   SKYE`);
  console.log(`  Desc:     trenches fixed`);
  console.log(`  Website:  https://skyefall.gg`);
  console.log(`  Mint:     ${mintKeypair.publicKey.toBase58()}`);
  console.log(`  TX:       ${sig}`);
  console.log(`  Pump.fun: https://pump.fun/${mintKeypair.publicKey.toBase58()}`);
  console.log(`  Solscan:  https://solscan.io/token/${mintKeypair.publicKey.toBase58()}`);
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("\n  ✗ Launch failed:", err.message || err);
  process.exit(1);
});
