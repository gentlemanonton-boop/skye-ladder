/**
 * metadataService.ts — Upload metadata to Arweave + create Metaplex metadata account.
 *
 * Uses dynamic imports to avoid bundling Node.js-only dependencies (@irys/query)
 * at build time, which would break Vite's browser build.
 */

import type { WalletAdapter } from "@solana/wallet-adapter-base";
import { RPC_URL } from "../constants";

const SKYE_LADDER_ATTRIBUTES = [
  { trait_type: "Phase 1", value: "1x-2x: Sell back initial investment. Natural taper from ~100% to ~50%" },
  { trait_type: "Phase 2", value: "2x-5x: Compressed growth 50% to ~56.25%. Cliff jump to 62.5% at 5x" },
  { trait_type: "Phase 3", value: "5x-10x: Compressed growth 62.5% to ~68.75%. Cliff jump to 75% at 10x" },
  { trait_type: "Phase 4", value: "10x-15x: Compressed growth 75% to ~87.5%. Cliff jump to 100% at 15x" },
  { trait_type: "Phase 5", value: "15x+: 100% unlocked. No restrictions" },
  { trait_type: "Underwater Rule", value: "At or below entry price = always 100% sellable" },
  { trait_type: "Program", value: "Token-2022 Transfer Hook" },
];

export async function uploadAndCreateMetadata(opts: {
  wallet: WalletAdapter;
  mint: string;
  name: string;
  symbol: string;
  description: string;
  imageFile: File | null;
}): Promise<string> {
  // Dynamic imports to avoid Node.js stream dependency at build time
  const { createUmi } = await import("@metaplex-foundation/umi-bundle-defaults");
  const { mplTokenMetadata, createV1, TokenStandard } = await import("@metaplex-foundation/mpl-token-metadata");
  const { walletAdapterIdentity } = await import("@metaplex-foundation/umi-signer-wallet-adapters");
  const { irysUploader } = await import("@metaplex-foundation/umi-uploader-irys");
  const { publicKey: umiPublicKey, createGenericFile } = await import("@metaplex-foundation/umi");

  // Token-2022 program ID — required because all Skye Ladder mints use Token-2022
  // (TransferHook extension), and createV1 defaults to legacy SPL Token otherwise.
  const SPL_TOKEN_2022_PROGRAM_ID = umiPublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

  const umi = createUmi(RPC_URL)
    .use(mplTokenMetadata())
    .use(irysUploader())
    .use(walletAdapterIdentity(opts.wallet));

  let imageUri = "";
  if (opts.imageFile) {
    const imageBytes = new Uint8Array(await opts.imageFile.arrayBuffer());
    const file = createGenericFile(imageBytes, opts.imageFile.name, {
      contentType: opts.imageFile.type,
    });
    const [uploaded] = await umi.uploader.upload([file]);
    imageUri = uploaded;
  }

  const metadataJson = {
    name: opts.name,
    symbol: opts.symbol,
    description: opts.description || "",
    image: imageUri,
    attributes: SKYE_LADDER_ATTRIBUTES,
    properties: { category: "currency" },
  };

  const metadataUri = await umi.uploader.uploadJson(metadataJson);

  await createV1(umi, {
    mint: umiPublicKey(opts.mint),
    name: opts.name,
    symbol: opts.symbol,
    uri: metadataUri,
    sellerFeeBasisPoints: {
      basisPoints: 0n,
      identifier: "%" as const,
      decimals: 2,
    },
    tokenStandard: TokenStandard.Fungible,
    splTokenProgram: SPL_TOKEN_2022_PROGRAM_ID,
  }).sendAndConfirm(umi);

  return metadataUri;
}
