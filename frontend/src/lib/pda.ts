import { PublicKey } from "@solana/web3.js";
import { SKYE_AMM_PROGRAM_ID, SKYE_LADDER_PROGRAM_ID, SKYE_MINT, WSOL_MINT } from "../constants";

export function getPoolPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), SKYE_MINT.toBuffer(), WSOL_MINT.toBuffer()],
    SKYE_AMM_PROGRAM_ID
  );
}

export function getLpAuthority(poolPDA: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lp-authority"), poolPDA.toBuffer()],
    SKYE_AMM_PROGRAM_ID
  );
}

export function getConfigPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config"), SKYE_MINT.toBuffer()],
    SKYE_LADDER_PROGRAM_ID
  );
}

export function getExtraMetasPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), SKYE_MINT.toBuffer()],
    SKYE_LADDER_PROGRAM_ID
  );
}

export function getWalletRecordPDA(wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("wallet"), wallet.toBuffer(), SKYE_MINT.toBuffer()],
    SKYE_LADDER_PROGRAM_ID
  );
}
