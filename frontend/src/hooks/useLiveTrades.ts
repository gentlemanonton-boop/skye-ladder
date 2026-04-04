import { useEffect, useRef, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { SKYE_AMM_PROGRAM_ID } from "../constants";

export interface LiveTrade {
  id: string;
  type: "buy" | "sell";
  skyeAmount: number; // raw
  solAmount: number; // lamports
  timestamp: number;
  signature: string;
}

const MAX_TRADES = 15;

export function useLiveTrades() {
  const { connection } = useConnection();
  const [trades, setTrades] = useState<LiveTrade[]>([]);
  const tradesRef = useRef(trades);
  tradesRef.current = trades;
  const seenRef = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;

    // Poll recent signatures for the AMM program
    async function poll() {
      try {
        const sigs = await connection.getSignaturesForAddress(
          SKYE_AMM_PROGRAM_ID, { limit: 5 }, "confirmed"
        );

        for (const s of sigs) {
          if (cancelled || seenRef.current.has(s.signature)) continue;
          seenRef.current.add(s.signature);

          try {
            const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
            if (!tx?.meta?.logMessages) continue;

            const logs = tx.meta.logMessages;
            const buyLog = logs.find(l => l.includes("BUY:") && l.includes("WSOL"));
            const sellLog = logs.find(l => l.includes("SELL:") && l.includes("SKYE"));

            if (buyLog) {
              const m = buyLog.match(/BUY: (\d+) WSOL -> (\d+) SKYE/);
              if (m) {
                const trade: LiveTrade = {
                  id: s.signature,
                  type: "buy",
                  solAmount: parseInt(m[1]),
                  skyeAmount: parseInt(m[2]),
                  timestamp: s.blockTime || Math.floor(Date.now() / 1000),
                  signature: s.signature,
                };
                if (!cancelled) {
                  setTrades(prev => [trade, ...prev].slice(0, MAX_TRADES));
                }
              }
            } else if (sellLog) {
              const m = sellLog.match(/SELL: (\d+) SKYE -> (\d+) WSOL/);
              if (m) {
                const trade: LiveTrade = {
                  id: s.signature,
                  type: "sell",
                  skyeAmount: parseInt(m[1]),
                  solAmount: parseInt(m[2]),
                  timestamp: s.blockTime || Math.floor(Date.now() / 1000),
                  signature: s.signature,
                };
                if (!cancelled) {
                  setTrades(prev => [trade, ...prev].slice(0, MAX_TRADES));
                }
              }
            }
          } catch { /* skip failed fetches */ }
        }
      } catch { /* ignore */ }
    }

    // Initial load
    poll();
    // Poll every 8 seconds
    const interval = setInterval(poll, 8000);

    return () => { cancelled = true; clearInterval(interval); };
  }, [connection]);

  return trades;
}
