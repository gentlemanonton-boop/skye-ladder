import { PublicKey } from "@solana/web3.js";
import {
  SKYE_LADDER_PROGRAM_ID,
  SKYE_MINT,
} from "../constants";
import { getConfigPDA, getExtraMetasPDA, getPoolPDA, getWalletRecordPDA } from "./pda";

export interface ExtraAccountMeta {
  pubkey: PublicKey;
  isSigner: boolean;
  isWritable: boolean;
}

/**
 * Manually derive the transfer hook extra accounts.
 *
 * The SPL helper `createTransferCheckedWithTransferHookInstruction` reads
 * on-chain account data to resolve seed-based PDAs. This fails when the
 * user's token account doesn't exist yet (e.g., first buy).
 *
 * Since we know the ExtraAccountMetaList structure, we derive everything
 * client-side without any RPC calls:
 *
 *   [0] Config PDA (read-only)
 *   [1] Sender WalletRecord PDA (writable)
 *   [2] Receiver WalletRecord PDA (writable)
 *   [3] Pool PDA / price source (read-only)
 *   [4] Skye Ladder program (read-only)
 *   [5] ExtraAccountMetaList PDA (read-only)
 */
export function deriveHookAccounts(
  senderOwner: PublicKey,
  receiverOwner: PublicKey,
): ExtraAccountMeta[] {
  const [configPDA] = getConfigPDA();
  const [senderWR] = getWalletRecordPDA(senderOwner);
  const [receiverWR] = getWalletRecordPDA(receiverOwner);
  const [poolPDA] = getPoolPDA();
  const [extraMetasPDA] = getExtraMetasPDA();

  return [
    { pubkey: configPDA, isSigner: false, isWritable: false },
    { pubkey: senderWR, isSigner: false, isWritable: true },
    { pubkey: receiverWR, isSigner: false, isWritable: true },
    { pubkey: poolPDA, isSigner: false, isWritable: false },
    { pubkey: SKYE_LADDER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: extraMetasPDA, isSigner: false, isWritable: false },
  ];
}
