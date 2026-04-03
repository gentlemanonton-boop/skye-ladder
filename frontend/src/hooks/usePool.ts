import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import { getPoolPDA } from "../lib/pda";
import ammIdl from "../idl/skye_amm.json";
import { SKYE_AMM_PROGRAM_ID } from "../constants";

export interface PoolState {
  skyeAmount: number;
  wsolAmount: number;
  feeBps: number;
  skyeReserve: string;
  wsolReserve: string;
}

export function usePool() {
  const { connection } = useConnection();
  const [pool, setPool] = useState<PoolState | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const [poolPDA] = getPoolPDA();

    async function fetch() {
      try {
        const provider = new AnchorProvider(
          connection,
          { publicKey: null, signTransaction: null, signAllTransactions: null } as any,
          { commitment: "confirmed" }
        );
        const program = new Program(ammIdl as any, provider);
        const account = await program.account.pool.fetch(poolPDA);
        setPool({
          skyeAmount: Number(account.skyeAmount),
          wsolAmount: Number(account.wsolAmount),
          feeBps: account.feeBps,
          skyeReserve: account.skyeReserve.toBase58(),
          wsolReserve: account.wsolReserve.toBase58(),
        });
      } catch (e) {
        console.error("Failed to fetch pool:", e);
      }
      setLoading(false);
    }

    fetch();

    const sub = connection.onAccountChange(poolPDA, () => fetch(), "confirmed");
    return () => { connection.removeAccountChangeListener(sub); };
  }, [connection]);

  return { pool, loading };
}
