import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { getWalletRecordPDA } from "../lib/pda";
import type { Position } from "../lib/unlock";

/**
 * Read WalletRecord positions directly from raw account data.
 * No Anchor deserialization — immune to IDL/struct mismatches.
 *
 * Layout after 8-byte discriminator:
 *   owner: 32 bytes (offset 8)
 *   mint: 32 bytes (offset 40)
 *   position_count: u8 (offset 72)
 *   positions: Vec<Position> → 4-byte LE length, then N × 38 bytes
 *
 * Position (38 bytes):
 *   entry_price: u64 (8)
 *   initial_sol: u64 (8)
 *   token_balance: u64 (8)
 *   unlocked_bps: u32 (4)
 *   original_balance: u64 (8)
 *   sold_before_5x: bool (1)
 *   claimed: bool (1)
 */
function parsePositions(data: Buffer): Position[] {
  if (data.length < 77) return []; // 8 disc + 32 owner + 32 mint + 1 count + 4 vec len

  const vecLen = data.readUInt32LE(73);
  const positions: Position[] = [];
  let offset = 77;

  for (let i = 0; i < vecLen; i++) {
    if (offset + 38 > data.length) break;

    const entryPrice = Number(data.readBigUInt64LE(offset)); offset += 8;
    const initialSol = Number(data.readBigUInt64LE(offset)); offset += 8;
    const tokenBalance = Number(data.readBigUInt64LE(offset)); offset += 8;
    const unlockedBps = data.readUInt32LE(offset); offset += 4;
    const originalBalance = Number(data.readBigUInt64LE(offset)); offset += 8;
    offset += 1; // sold_before_5x
    offset += 1; // claimed

    if (tokenBalance > 0) {
      positions.push({ entryPrice, initialSol, tokenBalance, unlockedBps, originalBalance });
    }
  }

  return positions;
}

export function useWalletRecord() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!publicKey) {
      setPositions([]);
      return;
    }

    const [wrPDA] = getWalletRecordPDA(publicKey);

    async function fetch() {
      setLoading(true);
      try {
        const info = await connection.getAccountInfo(wrPDA);
        if (info && info.data) {
          const parsed = parsePositions(info.data as Buffer);
          setPositions(parsed);
        } else {
          setPositions([]);
        }
      } catch {
        setPositions([]);
      }
      setLoading(false);
    }

    fetch();

    const sub = connection.onAccountChange(wrPDA, (info) => {
      if (info.data) {
        const parsed = parsePositions(info.data as Buffer);
        setPositions(parsed);
      }
    }, "confirmed");
    return () => { connection.removeAccountChangeListener(sub); };
  }, [connection, publicKey]);

  return { positions, loading };
}
