import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import { getWalletRecordPDA } from "../lib/pda";
import ladderIdl from "../idl/skye_ladder.json";
import type { Position } from "../lib/unlock";

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
        const provider = new AnchorProvider(
          connection,
          { publicKey: null, signTransaction: null, signAllTransactions: null } as any,
          { commitment: "confirmed" }
        );
        const program = new Program(ladderIdl as any, provider);
        const account = await program.account.walletRecord.fetch(wrPDA);

        const positions: Position[] = (account.positions as any[]).map((p) => ({
          entryPrice: Number(p.entryPrice),
          initialSol: Number(p.initialSol || p.initialUsd || 0),
          tokenBalance: Number(p.tokenBalance),
          unlockedBps: p.unlockedBps,
          originalBalance: Number(p.originalBalance || 0),
        }));

        setPositions(positions);
      } catch {
        setPositions([]);
      }
      setLoading(false);
    }

    fetch();

    const sub = connection.onAccountChange(wrPDA, () => fetch(), "confirmed");
    return () => { connection.removeAccountChangeListener(sub); };
  }, [connection, publicKey]);

  return { positions, loading };
}
