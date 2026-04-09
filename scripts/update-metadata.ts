/**
 * Upload new logo + metadata to Arweave, then update on-chain Metaplex metadata.
 *
 * Usage: npx ts-node scripts/update-metadata.ts
 */

import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { mplTokenMetadata, updateV1, fetchMetadataFromSeeds } from "@metaplex-foundation/mpl-token-metadata";
import { keypairIdentity, publicKey as umiPublicKey, createGenericFile, none } from "@metaplex-foundation/umi";
import { irysUploader } from "@metaplex-foundation/umi-uploader-irys";
import fs from "fs";
import path from "path";

const RPC_URL = "https://api.mainnet-beta.solana.com";
const SKYE_MINT = "5GtUWP1x4LpKjAzGBZg9sy9TbTqjY2bvJfgfC7aUmAfF";
const KEYPAIR_PATH = path.join(process.env.HOME!, ".config/solana/id.json");
const LOGO_PATH = path.join(__dirname, "../frontend/public/logo.jpeg");

async function main() {
  console.log("Loading keypair...");
  const secretKey = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8"));

  const umi = createUmi(RPC_URL)
    .use(mplTokenMetadata())
    .use(irysUploader());

  const keypair = umi.eddsa.createKeypairFromSecretKey(new Uint8Array(secretKey));
  umi.use(keypairIdentity(keypair));

  console.log("Authority:", keypair.publicKey);

  // Upload new logo
  console.log("Uploading new logo to Arweave...");
  const logoBytes = fs.readFileSync(LOGO_PATH);
  const logoFile = createGenericFile(new Uint8Array(logoBytes), "logo.jpeg", { contentType: "image/jpeg" });
  const [logoUri] = await umi.uploader.upload([logoFile]);
  console.log("Logo URI:", logoUri);

  // Upload new metadata JSON
  console.log("Uploading metadata JSON...");
  const metadata = {
    name: "Skye",
    symbol: "SKYE",
    description: "Structured sell-restriction protocol on Solana. Token-2022 Transfer Hook enforces per-wallet sell limits that scale with price appreciation. Buys always unrestricted.",
    image: logoUri,
    attributes: [
      { trait_type: "Phase 1", value: "1x-2x: Sell back initial investment" },
      { trait_type: "Phase 2", value: "2x-5x: Compressed growth 50% to 62.5%" },
      { trait_type: "Phase 3", value: "5x-10x: Compressed growth 62.5% to 75%" },
      { trait_type: "Phase 4", value: "10x-15x: Compressed growth 75% to 100%" },
      { trait_type: "Phase 5", value: "15x+: 100% unlocked" },
      { trait_type: "Underwater Rule", value: "At or below entry = always 100% sellable" },
      { trait_type: "Program", value: "Token-2022 Transfer Hook" },
    ],
    properties: { category: "currency" },
  };

  const metadataUri = await umi.uploader.uploadJson(metadata);
  console.log("Metadata URI:", metadataUri);

  // Update on-chain metadata
  console.log("Updating on-chain metadata...");
  const mintPk = umiPublicKey(SKYE_MINT);

  // Fetch existing metadata to preserve creators
  const existing = await fetchMetadataFromSeeds(umi, { mint: mintPk });
  console.log("Existing creators:", existing.creators);

  await updateV1(umi, {
    mint: mintPk,
    data: {
      ...existing,
      name: "Skye",
      symbol: "SKYE",
      uri: metadataUri,
    },
  }).sendAndConfirm(umi);

  console.log("Done! Metadata updated.");
  console.log("New metadata URI:", metadataUri);
  console.log("New logo URI:", logoUri);
}

main().catch(console.error);
