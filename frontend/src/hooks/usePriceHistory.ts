import { useEffect, useRef, useState, useCallback } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import { getPoolPDA } from "../lib/pda";
import ammIdl from "../idl/skye_amm.json";

export interface PricePoint {
  time: number; // unix seconds
  price: number; // raw ratio (wsolAmount / skyeAmount)
}

const STORAGE_KEY = "skye_price_history";
const MAX_POINTS = 8640; // ~24h at 10s intervals

function loadFromStorage(): PricePoint[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PricePoint[];
    // Prune points older than 24h
    const cutoff = Date.now() / 1000 - 86400;
    return parsed.filter((p) => p.time > cutoff);
  } catch {
    return [];
  }
}

function saveToStorage(points: PricePoint[]) {
  try {
    // Keep only last MAX_POINTS
    const trimmed = points.slice(-MAX_POINTS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch { /* quota exceeded — ignore */ }
}

export function usePriceHistory() {
  const { connection } = useConnection();
  const [history, setHistory] = useState<PricePoint[]>(loadFromStorage);
  const historyRef = useRef(history);
  historyRef.current = history;

  const addPoint = useCallback((price: number) => {
    const now = Math.floor(Date.now() / 1000);
    const last = historyRef.current[historyRef.current.length - 1];
    // Dedupe: minimum 5s between points
    if (last && now - last.time < 5) return;
    const next = [...historyRef.current, { time: now, price }].slice(-MAX_POINTS);
    historyRef.current = next;
    setHistory(next);
    saveToStorage(next);
  }, []);

  useEffect(() => {
    const [poolPDA] = getPoolPDA();

    // Initial fetch
    async function fetchOnce() {
      try {
        const provider = new AnchorProvider(
          connection,
          { publicKey: null, signTransaction: null, signAllTransactions: null } as any,
          { commitment: "confirmed" }
        );
        const program = new Program(ammIdl as any, provider);
        const account = await program.account.pool.fetch(poolPDA);
        const price = Number(account.wsolAmount) / Number(account.skyeAmount);
        if (price > 0) addPoint(price);
      } catch { /* ignore */ }
    }

    fetchOnce();

    // Subscribe to pool changes
    const sub = connection.onAccountChange(
      poolPDA,
      (accountInfo) => {
        try {
          // Read skye_amount (offset 200) and wsol_amount (offset 208) directly from raw data
          const data = accountInfo.data;
          if (data.length < 216) return;
          const skyeAmount = Number(data.readBigUInt64LE(200));
          const wsolAmount = Number(data.readBigUInt64LE(208));
          if (skyeAmount > 0 && wsolAmount > 0) {
            addPoint(wsolAmount / skyeAmount);
          }
        } catch { /* ignore parse errors */ }
      },
      "confirmed"
    );

    return () => { connection.removeAccountChangeListener(sub); };
  }, [connection, addPoint]);

  return history;
}
