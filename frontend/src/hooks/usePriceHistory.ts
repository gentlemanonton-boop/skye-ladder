import { useEffect, useRef, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { getCurvePDA } from "../lib/pda";
import { SKYE_MINT } from "../constants";

export interface PricePoint {
  time: number;
  price: number;
}

export interface PriceHistoryState {
  history: PricePoint[];
  loading: boolean;
}

// Why no localStorage anymore:
//
// The previous version cached points in localStorage per browser. That meant
// every device showed a different chart based on when it first visited the
// site — new visitors saw "LOADING PRICE DATA" until trades happened to fire
// while they were watching.
//
// This version reconstructs the chart from chain on every load. We fetch
// recent signatures of the curve PDA, look at each transaction's
// `postTokenBalances` for the curve's WSOL and token reserves, and compute
//   price = (real_sol + initial_virtual_sol) / real_token
// which is exactly what `virtual_sol / virtual_token` would give (because
// virtual_sol - real_sol is the constant `INITIAL_VIRTUAL_SOL` set at launch).
//
// Result: every visitor sees the same chart on first load, and live updates
// continue to flow in via the curve account subscription.
//
// Tuning:
//   - HISTORY_LIMIT is small (50). Each entry costs one getTransaction call,
//     which on the public RPC is ~50–200ms each plus rate limits. 50 entries
//     gives ~10s of load time worst case and a useful recent chart. We don't
//     need a multi-day chart on first load — the live subscription extends
//     it from there.
//   - BATCH is small (10) so we don't fan out so wide that the RPC starts
//     dropping requests. Public Solana RPC throttles aggressively above ~25
//     concurrent.
//   - After each batch we publish a partial update so the user sees the
//     chart filling in instead of staring at a "LOADING" state for the
//     whole window.

const HISTORY_LIMIT = 50;
const BATCH = 10;

export function usePriceHistory(mint?: PublicKey): PriceHistoryState {
  const { connection } = useConnection();
  const [history, setHistory] = useState<PricePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const ref = useRef(history);
  ref.current = history;
  const activeMint = mint ?? SKYE_MINT;

  useEffect(() => {
    let cancelled = false;
    setHistory([]);
    setLoading(true);
    ref.current = [];
    const [curvePDA] = getCurvePDA(activeMint);
    const tokenReserve = getAssociatedTokenAddressSync(
      activeMint, curvePDA, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const wsolReserve = getAssociatedTokenAddressSync(
      NATIVE_MINT, curvePDA, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const tokenReserveStr = tokenReserve.toBase58();
    const wsolReserveStr = wsolReserve.toBase58();

    function readPriceFromCurveData(data: Buffer): number | null {
      if (data.length < 184) return null;
      try {
        const skye = Number(data.readBigUInt64LE(168));
        const wsol = Number(data.readBigUInt64LE(176));
        if (skye > 0 && wsol > 0) return wsol / skye;
      } catch {}
      return null;
    }

    function appendLive(price: number) {
      const now = Math.floor(Date.now() / 1000);
      const last = ref.current[ref.current.length - 1];
      if (last && now - last.time < 5) return;
      const next = [...ref.current, { time: now, price }];
      ref.current = next;
      setHistory(next);
    }

    function publishPoints(newPoints: PricePoint[]) {
      // Merge with anything already in state, dedupe by second, sort.
      const seen = new Map<number, number>();
      for (const p of ref.current) seen.set(p.time, p.price);
      for (const p of newPoints) seen.set(p.time, p.price);
      const merged = [...seen.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([time, price]) => ({ time, price }));
      ref.current = merged;
      setHistory(merged);
    }

    async function backfill() {
      try {
        // 1) Read current curve to derive (a) initialVirtualSol and (b) a
        //    seed point so the chart never starts blank.
        const curveInfo = await connection.getAccountInfo(curvePDA);
        if (cancelled || !curveInfo || curveInfo.data.length < 192) {
          if (!cancelled) setLoading(false);
          return;
        }
        const currentVirtualSol = Number(curveInfo.data.readBigUInt64LE(176));
        const currentVirtualToken = Number(curveInfo.data.readBigUInt64LE(168));
        const currentRealSol = Number(curveInfo.data.readBigUInt64LE(184));
        const initialVirtualSol = currentVirtualSol - currentRealSol;

        // Seed with the current price as a single point, anchored to "now".
        // This is replaced/extended once the historical sigs land, but it
        // means the loading screen flips to "have data" immediately.
        if (currentVirtualToken > 0) {
          publishPoints([{
            time: Math.floor(Date.now() / 1000),
            price: currentVirtualSol / currentVirtualToken,
          }]);
        }

        // 2) Fetch recent signatures of the curve PDA.
        const sigs = await connection.getSignaturesForAddress(curvePDA, { limit: HISTORY_LIMIT });
        if (cancelled) return;
        // Reverse so we walk chronologically (oldest -> newest).
        const sigsChronological = [...sigs].reverse();

        // 3) Pull transactions in small batches and publish partial updates
        //    after each batch. The user sees the chart filling in instead
        //    of waiting on a frozen loader.
        for (let i = 0; i < sigsChronological.length; i += BATCH) {
          if (cancelled) return;
          const batch = sigsChronological.slice(i, i + BATCH);
          const txs = await Promise.all(
            batch.map(s =>
              connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 })
                .catch(() => null)
            )
          );
          if (cancelled) return;

          const batchPoints: PricePoint[] = [];
          for (let j = 0; j < txs.length; j++) {
            const tx = txs[j];
            if (!tx?.meta) continue;
            if (tx.meta.err) continue;

            const blockTime = tx.blockTime ?? batch[j].blockTime;
            if (!blockTime) continue;

            // Resolve account-key list. v0 messages need getAccountKeys();
            // legacy messages have a plain accountKeys array. We try the
            // method first then fall back to the array.
            const msg = tx.transaction.message as any;
            let allKeys: PublicKey[] | undefined;
            try {
              if (typeof msg.getAccountKeys === "function") {
                const keysObj = msg.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
                allKeys = [
                  ...keysObj.staticAccountKeys,
                  ...(keysObj.accountKeysFromLookups?.writable ?? []),
                  ...(keysObj.accountKeysFromLookups?.readonly ?? []),
                ];
              }
            } catch {
              // fall through
            }
            if (!allKeys && Array.isArray(msg.accountKeys)) {
              allKeys = msg.accountKeys;
            }
            if (!allKeys) continue;

            let realSol: number | null = null;
            let realToken: number | null = null;
            for (const tb of tx.meta.postTokenBalances ?? []) {
              const key = allKeys[tb.accountIndex];
              const addr = key?.toBase58?.();
              if (!addr) continue;
              if (addr === wsolReserveStr) realSol = Number(tb.uiTokenAmount.amount);
              else if (addr === tokenReserveStr) realToken = Number(tb.uiTokenAmount.amount);
            }

            if (realSol !== null && realToken !== null && realToken > 0) {
              const virtualSol = realSol + initialVirtualSol;
              const price = virtualSol / realToken;
              batchPoints.push({ time: blockTime, price });
            }
          }

          if (batchPoints.length > 0) publishPoints(batchPoints);
        }
      } catch (err) {
        console.error("Failed to backfill price history:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    backfill();

    // Live subscription for new trades after backfill completes (or runs in
    // parallel with it — `appendLive` only adds points newer than what
    // backfill produces).
    const sub = connection.onAccountChange(curvePDA, (info) => {
      const p = readPriceFromCurveData(info.data as Buffer);
      if (p) appendLive(p);
    }, "confirmed");

    return () => {
      cancelled = true;
      connection.removeAccountChangeListener(sub);
    };
  }, [connection, activeMint.toBase58()]);

  return { history, loading };
}
