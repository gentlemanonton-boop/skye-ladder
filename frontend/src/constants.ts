import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";

export const RPC_URL =
  import.meta.env.VITE_RPC_URL || "https://solana-rpc.publicnode.com";

export const SKYE_LADDER_PROGRAM_ID = new PublicKey(
  "4THAwb6WSpDyyqMHnJL2VBjU7TCLfLLGC5jtuCiyX5Rz"
);
export const SKYE_AMM_PROGRAM_ID = new PublicKey(
  "GRBvJRRJfV3CzRLocGcr3NTptWQpu1G4nW9Jpff5TFoX"
);
export const SKYE_MINT = new PublicKey(
  "5GtUWP1x4LpKjAzGBZg9sy9TbTqjY2bvJfgfC7aUmAfF"
);
export const WSOL_MINT = NATIVE_MINT;
export const DECIMALS = 9;
export const TOTAL_SUPPLY = 1_000_000_000;
export const PRICE_SCALE = 1e18;
