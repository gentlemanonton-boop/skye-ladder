import { useEffect, useRef, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { SKYE_AMM_PROGRAM_ID } from "../constants";
import { parseTradeLogs } from "../lib/parseTrade";

export interface LiveTrade {
  id: string;
  type: "buy" | "sell";
  skyeAmount: number; // raw
  solAmount: number; // lamports
  timestamp: number;
  signature: string;
}

const MAX_TRADES = 15;
const MAX_SEEN = 100;

export function useLiveTrades() {
  const { connection } = useConnection();
  const [trades, setTrades] = useState<LiveTrade[]>([]);
  const tradesRef = useRef(trades);
  tradesRef.current = trades;
  const seenRef = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const sigs = await connection.getSignaturesForAddress(
          SKYE_AMM_PROGRAM_ID, { limit: 5 }, "confirmed"
        );

        const newSigs = sigs.filter(s => !seenRef.current.has(s.signature));
        if (newSigs.length === 0) return;

        const txs = await Promise.allSettled(
          newSigs.map(s => connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }))
        );

        for (let i = 0; i < newSigs.length; i++) {
          if (cancelled) break;
          const s = newSigs[i];
          seenRef.current.add(s.signature);

          const result = txs[i];
          if (result.status !== "fulfilled" || !result.value?.meta?.logMessages) continue;

          const parsed = parseTradeLogs(result.value.meta.logMessages);
          if (parsed) {
            const trade: LiveTrade = {
              id: s.signature,
              type: parsed.type,
              solAmount: parsed.solAmount,
              skyeAmount: parsed.skyeAmount,
              timestamp: s.blockTime || Math.floor(Date.now() / 1000),
              signature: s.signature,
            };
            if (!cancelled) {
              setTrades(prev => [trade, ...prev].slice(0, MAX_TRADES));
            }
          }
        }

        // Trim seen set to prevent unbounded growth
        if (seenRef.current.size > MAX_SEEN) {
          const arr = [...seenRef.current];
          seenRef.current = new Set(arr.slice(-MAX_SEEN / 2));
        }
      } catch { /* ignore */ }
    }

    poll();
    const interval = setInterval(poll, 8000);

    return () => { cancelled = true; clearInterval(interval); };
  }, [connection]);

  return trades;
}
