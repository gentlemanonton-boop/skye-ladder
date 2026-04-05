/**
 * test-metadata.ts — Backend test: create a throwaway Token-2022 mint on devnet,
 * upload metadata + tokenomics to Arweave via Irys, create Metaplex metadata
 * account, then read it back to verify everything landed correctly.
 *
 * Usage:  npx ts-node scripts/test-metadata.ts
 */

import {
  Connection, Keypair, SystemProgram, Transaction, PublicKey,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, ExtensionType,
  createInitializeMintInstruction, getMintLen,
} from "@solana/spl-token";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  mplTokenMetadata, createV1, fetchDigitalAsset, TokenStandard,
} from "@metaplex-foundation/mpl-token-metadata";
import { keypairIdentity, publicKey as umiPublicKey } from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair } from "@metaplex-foundation/umi-web3js-adapters";
import { irysUploader } from "@metaplex-foundation/umi-uploader-irys";
import * as fs from "fs";
import * as path from "path";

// ── Config ──
// Use mainnet
const RPC_URL = "https://api.mainnet-beta.solana.com";
const DECIMALS = 9;

/** Skye Ladder tokenomics attributes — same as metadataService.ts */
const SKYE_LADDER_ATTRIBUTES = [
  { trait_type: "Phase 1", value: "1x-2x: Sell back initial investment. Natural taper from ~100% to 50%" },
  { trait_type: "Phase 2", value: "2x-5x: Compressed growth 50% to 62.5%. Half rate between milestones" },
  { trait_type: "Phase 3", value: "5x-10x: Compressed growth 62.5% to 75%" },
  { trait_type: "Phase 4", value: "10x-15x: Compressed growth 75% to 100%" },
  { trait_type: "Phase 5", value: "15x+: 100% unlocked. No restrictions" },
  { trait_type: "Underwater Rule", value: "At or below entry price = always 100% sellable" },
  { trait_type: "Program", value: "Token-2022 Transfer Hook" },
];

function loadKeypair(): Keypair {
  const p = path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
}

function log(msg: string) {
  console.log(`  ${msg}`);
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Skye Ladder — Metadata Upload Test");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const wallet = loadKeypair();
  const connection = new Connection(RPC_URL, "confirmed");

  log(`RPC:    ${RPC_URL}`);
  log(`Wallet: ${wallet.publicKey.toBase58()}`);

  const balance = await connection.getBalance(wallet.publicKey);
  log(`Balance: ${(balance / 1e9).toFixed(4)} SOL\n`);

  if (balance < 0.01 * 1e9) {
    console.error("  ✗ Need at least 0.01 SOL. Run: solana airdrop 1");
    process.exit(1);
  }

  // ── Step 1: Create a throwaway Token-2022 mint ──
  console.log("  [1/4] Creating test Token-2022 mint...");
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;

  const extensions: ExtensionType[] = [];
  const mintLen = getMintLen(extensions);
  const mintLamports = await connection.getMinimumBalanceForRentExemption(mintLen);

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: mint,
      space: mintLen,
      lamports: mintLamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeMintInstruction(mint, DECIMALS, wallet.publicKey, null, TOKEN_2022_PROGRAM_ID),
  );
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(wallet, mintKeypair);

  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  log(`Mint: ${mint.toBase58()}`);
  log(`TX:   ${sig}\n`);

  // ── Step 2: Upload metadata to Arweave via Irys ──
  console.log("  [2/4] Uploading metadata JSON to Arweave...");

  const umi = createUmi(RPC_URL)
    .use(mplTokenMetadata())
    .use(irysUploader())
    .use(keypairIdentity(fromWeb3JsKeypair(wallet)));

  const testName = "Test Skye Token";
  const testSymbol = "TSKYE";
  const testDescription = "Test token for metadata verification.";

  const baseDescription =
    "Skye Ladder \u2014 Structured sell-restriction protocol on Solana. " +
    "Token-2022 Transfer Hook enforces per-wallet sell limits that scale with price appreciation. " +
    "Buys always unrestricted.";

  const metadataJson = {
    name: testName,
    symbol: testSymbol,
    description: `${testDescription}\n\n${baseDescription}`,
    image: "",
    attributes: SKYE_LADDER_ATTRIBUTES,
    properties: { category: "currency" },
  };

  const metadataUri = await umi.uploader.uploadJson(metadataJson);
  log(`Metadata URI: ${metadataUri}\n`);

  // ── Step 3: Create Metaplex metadata account ──
  console.log("  [3/4] Creating Metaplex metadata account on-chain...");

  const createTx = await createV1(umi, {
    mint: umiPublicKey(mint.toBase58()),
    name: testName,
    symbol: testSymbol,
    uri: metadataUri,
    sellerFeeBasisPoints: { basisPoints: 0n, identifier: "%" as const, decimals: 2 },
    tokenStandard: TokenStandard.Fungible,
  }).sendAndConfirm(umi);

  log(`Metadata TX: ${Buffer.from(createTx.signature).toString("base64")}\n`);

  // ── Step 4: Read back and verify ──
  console.log("  [4/4] Verifying on-chain metadata...");

  const asset = await fetchDigitalAsset(umi, umiPublicKey(mint.toBase58()));

  const onChainName = asset.metadata.name.replace(/\0/g, "").trim();
  const onChainSymbol = asset.metadata.symbol.replace(/\0/g, "").trim();
  const onChainUri = asset.metadata.uri.replace(/\0/g, "").trim();

  let allPassed = true;

  function check(label: string, actual: string, expected: string) {
    const ok = actual === expected;
    if (!ok) allPassed = false;
    console.log(`  ${ok ? "✓" : "✗"} ${label}: ${ok ? actual : `expected "${expected}", got "${actual}"`}`);
  }

  check("Name", onChainName, testName);
  check("Symbol", onChainSymbol, testSymbol);
  check("URI", onChainUri, metadataUri);

  // Fetch the Arweave JSON and verify attributes
  console.log("\n  Fetching Arweave JSON to verify tokenomics...");
  const resp = await fetch(metadataUri);
  const json = await resp.json() as { attributes?: { trait_type: string; value: string }[]; description?: string };

  const attrOk = json.attributes && json.attributes.length === SKYE_LADDER_ATTRIBUTES.length;
  if (!attrOk) allPassed = false;
  console.log(`  ${attrOk ? "✓" : "✗"} Attributes: ${json.attributes?.length || 0} of ${SKYE_LADDER_ATTRIBUTES.length} present`);

  for (const attr of SKYE_LADDER_ATTRIBUTES) {
    const found = json.attributes?.find((a) => a.trait_type === attr.trait_type && a.value === attr.value);
    if (!found) {
      allPassed = false;
      console.log(`  ✗ Missing attribute: ${attr.trait_type}`);
    }
  }

  const descOk = json.description?.includes("Skye Ladder");
  if (!descOk) allPassed = false;
  console.log(`  ${descOk ? "✓" : "✗"} Description includes Skye Ladder branding`);

  console.log("\n═══════════════════════════════════════════════════════════════");
  if (allPassed) {
    console.log("  ✓ ALL CHECKS PASSED — metadata + tokenomics verified");
  } else {
    console.log("  ✗ SOME CHECKS FAILED — review output above");
  }
  console.log(`  Mint:     ${mint.toBase58()}`);
  console.log(`  Metadata: ${metadataUri}`);
  console.log(`  Solscan:  https://solscan.io/token/${mint.toBase58()}`);
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("\n  ✗ Test failed:", err.message || err);
  process.exit(1);
});
