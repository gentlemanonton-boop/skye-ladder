import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { SKYE_AMM_PROGRAM_ID } from "../constants";
import { parseTradeLogs } from "../lib/parseTrade";

export interface TradeEvent {
  signature: string;
  type: "buy" | "sell";
  skyeAmount: number; // raw
  solAmount: number; // lamports
  timestamp: number;
}

const BATCH_SIZE = 10;

export function useActivity() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [trades, setTrades] = useState<TradeEvent[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!publicKey) { setTrades([]); return; }

    let cancelled = false;

    async function fetchTrades() {
      setLoading(true);
      try {
        const sigs = await connection.getSignaturesForAddress(publicKey!, { limit: 40 });

        const results: TradeEvent[] = [];
        // Batch transaction fetches instead of sequential
        for (let i = 0; i < sigs.length && results.length < 20; i += BATCH_SIZE) {
          if (cancelled) break;
          const batch = sigs.slice(i, i + BATCH_SIZE);
          const txs = await Promise.allSettled(
            batch.map(s => connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }))
          );

          for (let j = 0; j < batch.length; j++) {
            if (cancelled || results.length >= 20) break;
            const result = txs[j];
            if (result.status !== "fulfilled" || !result.value?.meta?.logMessages) continue;

            const logs = result.value.meta.logMessages;
            if (!logs.find(l => l.includes(SKYE_AMM_PROGRAM_ID.toBase58()))) continue;

            const parsed = parseTradeLogs(logs);
            if (parsed) {
              results.push({
                signature: batch[j].signature,
                type: parsed.type,
                solAmount: parsed.solAmount,
                skyeAmount: parsed.skyeAmount,
                timestamp: batch[j].blockTime || 0,
              });
            }
          }
        }
        if (!cancelled) setTrades(results);
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false);
    }

    fetchTrades();
    return () => { cancelled = true; };
  }, [connection, publicKey]);

  return { trades, loading };
}
