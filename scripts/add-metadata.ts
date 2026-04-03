/**
 * add-metadata.ts — Upload image/JSON to Arweave and create Metaplex token metadata
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { mplTokenMetadata, createV1, TokenStandard } from "@metaplex-foundation/mpl-token-metadata";
import { keypairIdentity, publicKey as umiPublicKey } from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair } from "@metaplex-foundation/umi-web3js-adapters";
import Irys from "@irys/sdk";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const MINT = new PublicKey("4w1DQR7HuVNdK6YDKvgyGSQ7A6Ba7ChWL4Hof1HKw1j");
const RPC_URL = execSync("solana config get | grep 'RPC URL' | awk '{print $NF}'", { encoding: "utf-8" }).trim();
const IMAGE_PATH = path.join(process.env.HOME!, "Desktop", "IMG_0926.jpeg");

function loadKeypair(filePath: string): Keypair {
  const abs = filePath.startsWith("~") ? path.join(process.env.HOME!, filePath.slice(1)) : filePath;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(abs, "utf-8"))));
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Skye Ladder — Token Metadata Setup");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const wallet = loadKeypair("~/.config/solana/id.json");

  // Already uploaded — use existing URIs
  const imageUri = "https://gateway.irys.xyz/7KOIQD6D5bArYKAyOz8xtSmDDGKV7DbMOLo4oUhOlHI";
  const metadataUri = "https://gateway.irys.xyz/QhyDuK1lytVh84VddRolYAgsainTfbfDVrbj3_pyeCo";

  console.log(`Image:    ${imageUri}`);
  console.log(`Metadata: ${metadataUri}`);

  // Create Metaplex metadata account using Umi + CreateV1
  console.log("\nCreating Metaplex metadata account via CreateV1...");

  const umi = createUmi(RPC_URL).use(mplTokenMetadata());
  const umiKeypair = fromWeb3JsKeypair(wallet);
  umi.use(keypairIdentity(umiKeypair));

  const mintUmi = umiPublicKey(MINT.toBase58());

  const tx = await createV1(umi, {
    mint: mintUmi,
    name: "Skye Ladder",
    symbol: "SKYE",
    uri: metadataUri,
    sellerFeeBasisPoints: { basisPoints: 0n, identifier: "%" as const, decimals: 2 },
    tokenStandard: TokenStandard.Fungible,
  }).sendAndConfirm(umi);

  console.log(`Metadata created! sig: ${Buffer.from(tx.signature).toString("base64")}`);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Done!");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Mint:         ${MINT.toBase58()}`);
  console.log(`  Name:         Skye Ladder`);
  console.log(`  Symbol:       SKYE`);
  console.log(`  Image:        ${imageUri}`);
  console.log(`  Metadata URI: ${metadataUri}`);
}

main().catch(console.error);
