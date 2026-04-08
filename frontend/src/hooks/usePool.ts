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
        // Need at least up through fee_bps at offset 208 (u16, ends at 210).
        if (!info || info.data.length < 210) {
          setError("Curve not found");
          setLoading(false);
          return;
        }
        const d = info.data;
        // Curve struct layout (programs/skye-curve/src/state.rs):
        //   168: virtual_token_reserve (u64)
        //   176: virtual_sol_reserve   (u64)
        //   208: fee_bps               (u16)  ← was hardcoded to 100, now read live
        setPool({
          skyeAmount: Number(d.readBigUInt64LE(168)),
          wsolAmount: Number(d.readBigUInt64LE(176)),
          feeBps: d.readUInt16LE(208),
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
