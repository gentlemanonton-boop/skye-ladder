/**
 * Backfill on-chain Metaplex metadata for an existing token.
 *
 * Use this for tokens launched BEFORE the LaunchTab metadata wiring shipped
 * (commit 94f831c). Those tokens only have name/symbol/image in the launching
 * browser's localStorage, so they appear as "<mint>..." / "???" on every
 * other device. This script uploads the image + JSON to Arweave via Irys
 * and creates (or updates) the Metaplex metadata account on chain.
 *
 * After running, every Solana explorer + the Skye website will show the
 * token by name on every device.
 *
 * Usage:
 *   npx ts-node scripts/backfill-metadata.ts \
 *     --mint <mint-address> \
 *     --name "HODL" \
 *     --symbol "HODL" \
 *     --image ./path/to/image.png \
 *     [--description "optional description"]
 *
 * Requirements:
 *   - The local keypair (~/.config/solana/id.json) must be the MINT AUTHORITY
 *     of the token. For Skye launches the launching wallet stays as mint
 *     authority unless you explicitly revoked it.
 *   - The local keypair needs ~0.02 SOL for the Irys upload + createV1 tx.
 */

import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  mplTokenMetadata,
  createV1,
  updateV1,
  fetchMetadataFromSeeds,
  TokenStandard,
} from "@metaplex-foundation/mpl-token-metadata";
import {
  keypairIdentity,
  publicKey as umiPublicKey,
  createGenericFile,
} from "@metaplex-foundation/umi";
import { irysUploader } from "@metaplex-foundation/umi-uploader-irys";
import fs from "fs";
import path from "path";

const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const DEFAULT_KEYPAIR_PATH = path.join(process.env.HOME!, ".config/solana/id.json");
// Token-2022 program ID — Skye mints use Token-2022 because of TransferHook
const SPL_TOKEN_2022_PROGRAM_ID = umiPublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);

interface Args {
  mint: string;
  name: string;
  symbol: string;
  image: string;
  description?: string;
  keypair: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Partial<Args> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--mint") { out.mint = value; i++; }
    else if (flag === "--name") { out.name = value; i++; }
    else if (flag === "--symbol") { out.symbol = value; i++; }
    else if (flag === "--image") { out.image = value; i++; }
    else if (flag === "--description") { out.description = value; i++; }
    else if (flag === "--keypair") { out.keypair = value; i++; }
  }
  if (!out.mint || !out.name || !out.symbol || !out.image) {
    console.error(
      "Usage: backfill-metadata.ts --mint <addr> --name <name> --symbol <symbol> --image <path> [--description <desc>] [--keypair <path>]"
    );
    process.exit(1);
  }
  if (!out.keypair) out.keypair = DEFAULT_KEYPAIR_PATH;
  return out as Args;
}

async function main() {
  const args = parseArgs();

  console.log("Loading keypair from", args.keypair);
  const secretKey = JSON.parse(fs.readFileSync(args.keypair, "utf-8"));

  const umi = createUmi(RPC_URL)
    .use(mplTokenMetadata())
    .use(irysUploader());

  const keypair = umi.eddsa.createKeypairFromSecretKey(new Uint8Array(secretKey));
  umi.use(keypairIdentity(keypair));

  console.log("Signer:", keypair.publicKey);
  console.log("Mint:  ", args.mint);

  // Read image file
  const imagePath = path.resolve(args.image);
  if (!fs.existsSync(imagePath)) {
    console.error("Image file not found:", imagePath);
    process.exit(1);
  }
  const imageBytes = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase().replace(".", "") || "png";
  const contentType =
    ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
    ext === "gif" ? "image/gif" :
    ext === "webp" ? "image/webp" :
    "image/png";

  console.log(`Uploading image (${imageBytes.length} bytes, ${contentType}) to Arweave via Irys...`);
  const imageFile = createGenericFile(
    new Uint8Array(imageBytes),
    path.basename(imagePath),
    { contentType }
  );
  const [imageUri] = await umi.uploader.upload([imageFile]);
  console.log("Image URI:", imageUri);

  // Build metadata JSON (matches the structure from frontend metadataService.ts)
  const baseDescription =
    "Skye Ladder — Structured sell-restriction protocol on Solana. " +
    "Token-2022 Transfer Hook enforces per-wallet sell limits that scale with price appreciation. " +
    "Buys always unrestricted.";

  const metadataJson = {
    name: args.name,
    symbol: args.symbol,
    description: args.description
      ? `${args.description}\n\n${baseDescription}`
      : baseDescription,
    image: imageUri,
    attributes: [
      { trait_type: "Phase 1", value: "1x-2x: Sell back initial investment. Natural taper from ~100% to ~50%" },
      { trait_type: "Phase 2", value: "2x-5x: Compressed growth 50% to ~56.25%. Cliff jump to 62.5% at 5x" },
      { trait_type: "Phase 3", value: "5x-10x: Compressed growth 62.5% to ~68.75%. Cliff jump to 75% at 10x" },
      { trait_type: "Phase 4", value: "10x-15x: Compressed growth 75% to ~87.5%. Cliff jump to 100% at 15x" },
      { trait_type: "Phase 5", value: "15x+: 100% unlocked. No restrictions" },
      { trait_type: "Underwater Rule", value: "At or below entry price = always 100% sellable" },
      { trait_type: "Program", value: "Token-2022 Transfer Hook" },
    ],
    properties: { category: "currency" },
  };

  console.log("Uploading metadata JSON to Arweave...");
  const metadataUri = await umi.uploader.uploadJson(metadataJson);
  console.log("Metadata URI:", metadataUri);

  // Decide create vs update
  const mintPk = umiPublicKey(args.mint);
  let existingMetadata = null;
  try {
    existingMetadata = await fetchMetadataFromSeeds(umi, { mint: mintPk });
  } catch {
    // No existing metadata account — we'll create one
  }

  if (existingMetadata) {
    console.log("Existing metadata account found — calling updateV1...");
    await updateV1(umi, {
      mint: mintPk,
      data: {
        ...existingMetadata,
        name: args.name,
        symbol: args.symbol,
        uri: metadataUri,
      },
    }).sendAndConfirm(umi);
    console.log("✓ Metadata updated.");
  } else {
    console.log("No existing metadata account — calling createV1...");
    await createV1(umi, {
      mint: mintPk,
      name: args.name,
      symbol: args.symbol,
      uri: metadataUri,
      sellerFeeBasisPoints: { basisPoints: 0n, identifier: "%" as const, decimals: 2 },
      tokenStandard: TokenStandard.Fungible,
      splTokenProgram: SPL_TOKEN_2022_PROGRAM_ID,
    }).sendAndConfirm(umi);
    console.log("✓ Metadata created.");
  }

  console.log();
  console.log("Done. Note: Solscan and other explorers usually take a few");
  console.log("hours to re-index. The Skye website's metadataReader will");
  console.log("pick it up on the next page load (and cache it).");
  console.log();
  console.log("Image URI:    ", imageUri);
  console.log("Metadata URI: ", metadataUri);
}

main().catch((e) => {
  console.error("Failed:", e);
  process.exit(1);
});
