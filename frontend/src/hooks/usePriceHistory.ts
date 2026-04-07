import { useEffect, useRef, useState, useCallback } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { getCurvePDA } from "../lib/pda";

export interface PricePoint {
  time: number;
  price: number;
}

const STORAGE_KEY = "skye_price_history_v4";
const MAX_POINTS = 50000; // ~6 days at 10s intervals

function load(): PricePoint[] {
  try {
    // Migrate from v3 if exists
    const v3 = localStorage.getItem("skye_price_history_v3");
    const raw = localStorage.getItem(STORAGE_KEY) || v3;
    if (v3) { localStorage.removeItem("skye_price_history_v3"); }
    if (!raw) return [];
    return JSON.parse(raw) as PricePoint[];
  } catch { return []; }
}

function save(pts: PricePoint[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pts.slice(-MAX_POINTS))); } catch {}
}

export function usePriceHistory() {
  const { connection } = useConnection();
  const [history, setHistory] = useState<PricePoint[]>(load);
  const ref = useRef(history);
  ref.current = history;

  const add = useCallback((price: number) => {
    const now = Math.floor(Date.now() / 1000);
    const last = ref.current[ref.current.length - 1];
    if (last && now - last.time < 5) return;
    const next = [...ref.current, { time: now, price }].slice(-MAX_POINTS);
    ref.current = next;
    setHistory(next);
    save(next);
  }, []);

  useEffect(() => {
    const [poolPDA] = getCurvePDA();

    // Read price from raw account data — no Anchor deserialization needed
    function readPrice(data: Buffer): number | null {
      if (data.length < 184) return null;
      try {
        const skye = Number(data.readBigUInt64LE(168));
        const wsol = Number(data.readBigUInt64LE(176));
        if (skye > 0 && wsol > 0) return wsol / skye;
      } catch {}
      return null;
    }

    // Initial fetch
    connection.getAccountInfo(poolPDA).then((info) => {
      if (info?.data) {
        const p = readPrice(info.data as Buffer);
        if (p) add(p);
      }
    }).catch(() => {});

    // Subscribe
    const sub = connection.onAccountChange(poolPDA, (info) => {
      const p = readPrice(info.data as Buffer);
      if (p) add(p);
    }, "confirmed");

    return () => { connection.removeAccountChangeListener(sub); };
  }, [connection, add]);

  return history;
}
