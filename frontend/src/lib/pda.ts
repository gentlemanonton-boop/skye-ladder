import { PublicKey } from "@solana/web3.js";
import { SKYE_AMM_PROGRAM_ID, SKYE_CURVE_ID, SKYE_LADDER_PROGRAM_ID, SKYE_MINT, WSOL_MINT } from "../constants";

const _curvePDACache = new Map<string, [PublicKey, number]>();
export function getCurvePDA(mint?: PublicKey): [PublicKey, number] {
  const m = mint ?? SKYE_MINT;
  const key = m.toBase58();
  let cached = _curvePDACache.get(key);
  if (!cached) {
    cached = PublicKey.findProgramAddressSync(
      [Buffer.from("curve"), m.toBuffer()],
      SKYE_CURVE_ID
    );
    _curvePDACache.set(key, cached);
  }
  return cached;
}

const _poolPDACache = new Map<string, [PublicKey, number]>();
export function getPoolPDA(mint?: PublicKey): [PublicKey, number] {
  const m = mint ?? SKYE_MINT;
  const key = m.toBase58();
  let cached = _poolPDACache.get(key);
  if (!cached) {
    cached = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), m.toBuffer(), WSOL_MINT.toBuffer()],
      SKYE_AMM_PROGRAM_ID
    );
    _poolPDACache.set(key, cached);
  }
  return cached;
}

export function getPoolPDAForMint(mint: PublicKey): [PublicKey, number] {
  return getPoolPDA(mint);
}

const _configPDACache = new Map<string, [PublicKey, number]>();
export function getConfigPDA(mint?: PublicKey): [PublicKey, number] {
  const m = mint ?? SKYE_MINT;
  const key = m.toBase58();
  let cached = _configPDACache.get(key);
  if (!cached) {
    cached = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), m.toBuffer()],
      SKYE_LADDER_PROGRAM_ID
    );
    _configPDACache.set(key, cached);
  }
  return cached;
}

const _extraMetasPDACache = new Map<string, [PublicKey, number]>();
export function getExtraMetasPDA(mint?: PublicKey): [PublicKey, number] {
  const m = mint ?? SKYE_MINT;
  const key = m.toBase58();
  let cached = _extraMetasPDACache.get(key);
  if (!cached) {
    cached = PublicKey.findProgramAddressSync(
      [Buffer.from("extra-account-metas"), m.toBuffer()],
      SKYE_LADDER_PROGRAM_ID
    );
    _extraMetasPDACache.set(key, cached);
  }
  return cached;
}

const _walletRecordCache = new Map<string, [PublicKey, number]>();
export function getWalletRecordPDA(wallet: PublicKey, mint?: PublicKey): [PublicKey, number] {
  const m = mint ?? SKYE_MINT;
  const key = wallet.toBase58() + ":" + m.toBase58();
  let cached = _walletRecordCache.get(key);
  if (!cached) {
    cached = PublicKey.findProgramAddressSync(
      [Buffer.from("wallet"), wallet.toBuffer(), m.toBuffer()],
      SKYE_LADDER_PROGRAM_ID
    );
    _walletRecordCache.set(key, cached);
  }
  return cached;
}
