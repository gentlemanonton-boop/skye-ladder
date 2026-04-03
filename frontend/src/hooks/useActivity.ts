import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { SKYE_MINT, SKYE_AMM_PROGRAM_ID } from "../constants";
import { getPoolPDA } from "../lib/pda";

export interface TradeEvent {
  signature: string;
  type: "buy" | "sell";
  skyeAmount: number; // raw
  solAmount: number; // lamports
  timestamp: number;
}

export function useActivity() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [trades, setTrades] = useState<TradeEvent[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!publicKey) { setTrades([]); return; }

    let cancelled = false;

    async function fetch() {
      setLoading(true);
      try {
        const sigs = await connection.getSignaturesForAddress(publicKey!, { limit: 40 });

        const results: TradeEvent[] = [];
        for (const s of sigs) {
          if (cancelled || results.length >= 20) break;
          try {
            const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
            if (!tx?.meta?.logMessages) continue;

            const logs = tx.meta.logMessages;
            const buyLog = logs.find(l => l.includes("BUY:") && l.includes("WSOL"));
            const sellLog = logs.find(l => l.includes("SELL:") && l.includes("SKYE"));
            const ammLog = logs.find(l => l.includes(SKYE_AMM_PROGRAM_ID.toBase58()));

            if (!ammLog) continue;

            if (buyLog) {
              // "BUY: 1000000 WSOL -> 26386938300541 SKYE"
              const m = buyLog.match(/BUY: (\d+) WSOL -> (\d+) SKYE/);
              if (m) {
                results.push({
                  signature: s.signature,
                  type: "buy",
                  solAmount: parseInt(m[1]),
                  skyeAmount: parseInt(m[2]),
                  timestamp: s.blockTime || 0,
                });
              }
            } else if (sellLog) {
              const m = sellLog.match(/SELL: (\d+) SKYE -> (\d+) WSOL/);
              if (m) {
                results.push({
                  signature: s.signature,
                  type: "sell",
                  skyeAmount: parseInt(m[1]),
                  solAmount: parseInt(m[2]),
                  timestamp: s.blockTime || 0,
                });
              }
            }
          } catch { /* skip failed fetches */ }
        }
        if (!cancelled) setTrades(results);
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false);
    }

    fetch();
    return () => { cancelled = true; };
  }, [connection, publicKey]);

  return { trades, loading };
}
