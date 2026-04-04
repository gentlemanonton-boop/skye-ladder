import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import { getPoolPDA } from "../lib/pda";
import ammIdl from "../idl/skye_amm.json";

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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const [poolPDA] = getPoolPDA();

    async function fetchPool() {
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
        setError(null);
      } catch (e: any) {
        console.error("Failed to fetch pool:", e);
        setError(e?.message || "Failed to load pool data");
      }
      setLoading(false);
    }

    fetchPool();

    const sub = connection.onAccountChange(poolPDA, () => fetchPool(), "confirmed");
    return () => { connection.removeAccountChangeListener(sub); };
  }, [connection]);

  return { pool, loading, error };
}
