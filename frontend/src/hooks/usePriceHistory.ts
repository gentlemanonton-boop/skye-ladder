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

const HISTORY_LIMIT = 500; // recent signatures to walk back through
const BATCH = 25;

export function usePriceHistory() {
  const { connection } = useConnection();
  const [history, setHistory] = useState<PricePoint[]>([]);
  const ref = useRef(history);
  ref.current = history;

  useEffect(() => {
    let cancelled = false;
    const [curvePDA] = getCurvePDA();
    const tokenReserve = getAssociatedTokenAddressSync(
      SKYE_MINT, curvePDA, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
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

    async function backfill() {
      try {
        // 1) Read current curve to derive the constant offset between
        //    virtual_sol_reserve (curve account field) and real_sol_reserve
        //    (the actual WSOL balance in the curve's WSOL ATA). The
        //    difference is INITIAL_VIRTUAL_SOL, set once at launch and
        //    never changed.
        const curveInfo = await connection.getAccountInfo(curvePDA);
        if (cancelled || !curveInfo || curveInfo.data.length < 192) return;
        const currentVirtualSol = Number(curveInfo.data.readBigUInt64LE(176));
        const currentRealSol = Number(curveInfo.data.readBigUInt64LE(184));
        const initialVirtualSol = currentVirtualSol - currentRealSol;

        // 2) Fetch recent signatures of the curve PDA. Anything that
        //    mutates the curve (buy/sell/launch/graduate) shows up here.
        const sigs = await connection.getSignaturesForAddress(curvePDA, { limit: HISTORY_LIMIT });
        if (cancelled) return;
        // Reverse so we walk chronologically (oldest -> newest).
        const sigsChronological = [...sigs].reverse();

        const points: PricePoint[] = [];

        // 3) Pull transactions in batches via Promise.all so we don't wait
        //    serially. Public RPC will rate-limit if we go too wide.
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

          for (let j = 0; j < txs.length; j++) {
            const tx = txs[j];
            if (!tx?.meta) continue;
            // Skip failed txs — they didn't change state.
            if (tx.meta.err) continue;

            const blockTime = tx.blockTime ?? batch[j].blockTime;
            if (!blockTime) continue;

            // 4) Find the post-balances for the curve's two reserves.
            //    `postTokenBalances` entries reference accounts by index
            //    into the tx's account-keys list, so we resolve via the
            //    message helper that handles legacy + v0 + lookup tables.
            const accountKeysObj = (tx.transaction.message as any).getAccountKeys?.({
              accountKeysFromLookups: tx.meta.loadedAddresses,
            });
            const allKeys: PublicKey[] = accountKeysObj
              ? [
                  ...accountKeysObj.staticAccountKeys,
                  ...(accountKeysObj.accountKeysFromLookups?.writable ?? []),
                  ...(accountKeysObj.accountKeysFromLookups?.readonly ?? []),
                ]
              : ((tx.transaction.message as any).accountKeys ?? []);

            let realSol: number | null = null;
            let realToken: number | null = null;
            for (const tb of tx.meta.postTokenBalances ?? []) {
              const addr = allKeys[tb.accountIndex]?.toBase58?.();
              if (!addr) continue;
              if (addr === wsolReserveStr) realSol = Number(tb.uiTokenAmount.amount);
              else if (addr === tokenReserveStr) realToken = Number(tb.uiTokenAmount.amount);
            }

            if (realSol !== null && realToken !== null && realToken > 0) {
              const virtualSol = realSol + initialVirtualSol;
              const price = virtualSol / realToken;
              points.push({ time: blockTime, price });
            }
          }
        }

        if (cancelled) return;

        // De-dup by second (multiple ixs in the same block share blockTime).
        // Keep the latest within each second.
        const dedup = new Map<number, number>();
        for (const p of points) dedup.set(p.time, p.price);
        const sorted = [...dedup.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([time, price]) => ({ time, price }));

        // Merge with anything the live subscription has already pushed in
        // (the subscription may fire while backfill is still running).
        const liveTail = ref.current.filter(p =>
          sorted.length === 0 || p.time > sorted[sorted.length - 1].time
        );
        const merged = [...sorted, ...liveTail];

        ref.current = merged;
        setHistory(merged);
      } catch (err) {
        console.error("Failed to backfill price history:", err);
      }
    }

    backfill();

    // Live subscription for new trades after backfill completes.
    const sub = connection.onAccountChange(curvePDA, (info) => {
      const p = readPriceFromCurveData(info.data as Buffer);
      if (p) appendLive(p);
    }, "confirmed");

    return () => {
      cancelled = true;
      connection.removeAccountChangeListener(sub);
    };
  }, [connection]);

  return history;
}
