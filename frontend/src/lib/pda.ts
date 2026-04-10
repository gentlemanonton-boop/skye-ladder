import { PublicKey } from "@solana/web3.js";
import { SKYE_AMM_PROGRAM_ID, SKYE_CURVE_ID, SKYE_LADDER_PROGRAM_ID, SKYE_MINT, WSOL_MINT } from "../constants";

// Lazily cached PDA derivations for deterministic addresses.
// These never change, so we compute once and reuse.

let _curvePDA: [PublicKey, number] | null = null;
export function getCurvePDA(): [PublicKey, number] {
  if (!_curvePDA) {
    _curvePDA = PublicKey.findProgramAddressSync(
      [Buffer.from("curve"), SKYE_MINT.toBuffer()],
      SKYE_CURVE_ID
    );
  }
  return _curvePDA;
}

let _poolPDA: [PublicKey, number] | null = null;
export function getPoolPDA(): [PublicKey, number] {
  if (!_poolPDA) {
    _poolPDA = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), SKYE_MINT.toBuffer(), WSOL_MINT.toBuffer()],
      SKYE_AMM_PROGRAM_ID
    );
  }
  return _poolPDA;
}

let _configPDA: [PublicKey, number] | null = null;
export function getConfigPDA(): [PublicKey, number] {
  if (!_configPDA) {
    _configPDA = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), SKYE_MINT.toBuffer()],
      SKYE_LADDER_PROGRAM_ID
    );
  }
  return _configPDA;
}

let _extraMetasPDA: [PublicKey, number] | null = null;
export function getExtraMetasPDA(): [PublicKey, number] {
  if (!_extraMetasPDA) {
    _extraMetasPDA = PublicKey.findProgramAddressSync(
      [Buffer.from("extra-account-metas"), SKYE_MINT.toBuffer()],
      SKYE_LADDER_PROGRAM_ID
    );
  }
  return _extraMetasPDA;
}

const _walletRecordCache = new Map<string, [PublicKey, number]>();
export function getWalletRecordPDA(wallet: PublicKey): [PublicKey, number] {
  const key = wallet.toBase58();
  let cached = _walletRecordCache.get(key);
  if (!cached) {
    cached = PublicKey.findProgramAddressSync(
      [Buffer.from("wallet"), wallet.toBuffer(), SKYE_MINT.toBuffer()],
      SKYE_LADDER_PROGRAM_ID
    );
    _walletRecordCache.set(key, cached);
  }
  return cached;
}
