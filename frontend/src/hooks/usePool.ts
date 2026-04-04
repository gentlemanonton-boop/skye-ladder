import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { getCurvePDA } from "../lib/pda";

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
    const [curvePDA] = getCurvePDA();

    async function fetchCurve() {
      try {
        const info = await connection.getAccountInfo(curvePDA);
        if (!info || info.data.length < 184) {
          setError("Curve not found");
          setLoading(false);
          return;
        }
        const d = info.data;
        setPool({
          skyeAmount: Number(d.readBigUInt64LE(168)),
          wsolAmount: Number(d.readBigUInt64LE(176)),
          feeBps: 100,
          skyeReserve: curvePDA.toBase58(),
          wsolReserve: curvePDA.toBase58(),
        });
        setError(null);
      } catch (e: any) {
        console.error("Failed to fetch curve:", e);
        setError(e?.message || "Failed to load");
      }
      setLoading(false);
    }

    fetchCurve();
    const sub = connection.onAccountChange(curvePDA, () => fetchCurve(), "confirmed");
    return () => { connection.removeAccountChangeListener(sub); };
  }, [connection]);

  return { pool, loading, error };
}
