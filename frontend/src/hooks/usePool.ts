import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getCurvePDA, getPoolPDA } from "../lib/pda";

export interface PoolState {
  skyeAmount: number;
  wsolAmount: number;
  feeBps: number;
  skyeReserve: string;
  wsolReserve: string;
  graduated: boolean;
  poolPDA?: string;
  teamWallet?: string;
  skyeReserveKey?: string;
  wsolReserveKey?: string;
}

export function usePool() {
  const { connection } = useConnection();
  const [pool, setPool] = useState<PoolState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const [curvePDA] = getCurvePDA();
    let ammSub: number | null = null;

    async function fetchCurve() {
      try {
        const info = await connection.getAccountInfo(curvePDA);
        if (!info || info.data.length < 211) {
          setError("Curve not found");
          setLoading(false);
          return;
        }
        const d = info.data;
        const graduated = d[210] !== 0;

        if (!graduated) {
          setPool({
            skyeAmount: Number(d.readBigUInt64LE(168)),
            wsolAmount: Number(d.readBigUInt64LE(176)),
            feeBps: d.readUInt16LE(208),
            skyeReserve: curvePDA.toBase58(),
            wsolReserve: curvePDA.toBase58(),
            graduated: false,
          });
          setError(null);
          setLoading(false);
          return;
        }

        const [ammPoolPDA] = getPoolPDA();
        const ammInfo = await connection.getAccountInfo(ammPoolPDA);
        if (!ammInfo || ammInfo.data.length < 252) {
          setError("AMM pool not found");
          setLoading(false);
          return;
        }
        const ad = ammInfo.data;
        const skyeReserveKey = new PublicKey(ad.subarray(104, 136));
        const wsolReserveKey = new PublicKey(ad.subarray(136, 168));
        const teamWallet = new PublicKey(ad.subarray(220, 252));

        setPool({
          skyeAmount: Number(ad.readBigUInt64LE(200)),
          wsolAmount: Number(ad.readBigUInt64LE(208)),
          feeBps: ad.readUInt16LE(216),
          skyeReserve: skyeReserveKey.toBase58(),
          wsolReserve: wsolReserveKey.toBase58(),
          graduated: true,
          poolPDA: ammPoolPDA.toBase58(),
          teamWallet: teamWallet.toBase58(),
          skyeReserveKey: skyeReserveKey.toBase58(),
          wsolReserveKey: wsolReserveKey.toBase58(),
        });
        setError(null);

        if (ammSub === null) {
          ammSub = connection.onAccountChange(ammPoolPDA, () => fetchCurve(), "confirmed");
        }
      } catch (e: any) {
        console.error("Failed to fetch pool:", e);
        setError(e?.message || "Failed to load");
      }
      setLoading(false);
    }

    fetchCurve();
    const curveSub = connection.onAccountChange(curvePDA, () => fetchCurve(), "confirmed");
    return () => {
      connection.removeAccountChangeListener(curveSub);
      if (ammSub !== null) connection.removeAccountChangeListener(ammSub);
    };
  }, [connection]);

  return { pool, loading, error };
}
