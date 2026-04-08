/**
 * useDiscoveredTokens — shared, cached fetcher for the Discover and World
 * tabs. Both tabs walk the same set of recent curve-program signatures and
 * read the same curve PDAs, so each was making ~52 RPC calls on every
 * mount. Switching tabs unmounts the previous component and discards its
 * state, so users saw a 3-second blank-then-load every single time.
 *
 * This hook holds a single module-level cache shared across every consumer:
 *
 *   - First mount, anywhere: fetches from chain, populates cache, returns it.
 *   - Subsequent mounts (any tab): returns cached data SYNCHRONOUSLY on
 *     first render so the UI is instant.
 *   - Stale-while-revalidate: if the cache is older than `REFRESH_TTL`, a
 *     background fetch refreshes it without blocking the UI. All currently
 *     mounted consumers get notified via subscriber callbacks.
 *   - Concurrent fetches dedupe: if a fetch is already in flight, additional
 *     hook instances reuse the same promise.
 *
 * The hook returns the FULL set of non-test tokens (including SKYE). Each
 * consumer applies its own filters in render (DiscoverTab hides SKYE
 * because it lives on the Trade tab; WorldTab shows SKYE alongside the
 * community coins).
 */

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { Connection, PublicKey } from "@solana/web3.js";
import { getStoredTokens } from "../lib/launchStore";
import { fetchMetadataForMints } from "../lib/metadataReader";
import { SKYE_CURVE_ID, SKYE_MINT } from "../constants";

export interface DiscoveredTokenBase {
  // Identity
  mint: string;
  curve: string;
  creator: string;
  launchedAt: number;
  // Display (from launchStore + on-chain metadata enrichment)
  name: string;
  symbol: string;
  image: string;
  description: string;
  website: string;
  twitter: string;
  telegram: string;
  discord: string;
  // On-chain curve state (raw)
  realSol: number;     // lamports
  virtualSol: number;  // lamports
  virtualToken: number;// raw token units
  graduated: boolean;
}

// Truly dead test mints — never appear on either Discover or World.
// SKYE is NOT in this list (it lives in the World view but not Discover);
// DiscoverTab applies its own additional filter for SKYE in render.
const DEAD_MINTS = new Set([
  "HREtu5WXuKJP1L23shpNTP3U4Xtmfekv82Lyuq1vMrsd",
  "5BJcCPdZbxBMhodSZxUMowHSNY38dqhiRgSxDw8uLqZ1",
  "4w1DQR7HuVNdK6YDKvgyGSQ7A6Ba7ChWL4Hof1HKw1j",
  "6XByX9NXn1vvoyEYof6b6VEp6RVKGTKxdydurB6PoYtC", // HODL (original test)
  "652ZioC8L56aG51hoBLRsHsoqHnXPZU5FFseDS1EJkzK", // HODL (no on-chain metadata)
]);

const REFRESH_TTL_MS = 30_000;       // background refresh after this
const SIG_LIMIT = 50;                // signatures of curve program to walk

// ── Module-level cache + subscriber bus ─────────────────────────────────
let cache: { tokens: DiscoveredTokenBase[]; ts: number } | null = null;
let inFlight: Promise<DiscoveredTokenBase[]> | null = null;
const subscribers = new Set<(tokens: DiscoveredTokenBase[]) => void>();

function notifyAll(tokens: DiscoveredTokenBase[]) {
  for (const fn of subscribers) {
    try { fn(tokens); } catch {}
  }
}

async function doFetch(connection: Connection): Promise<DiscoveredTokenBase[]> {
  const stored = getStoredTokens();

  // 1) Walk recent curve-program signatures and pull the launches out of
  //    the log messages. This is the same approach both tabs used before.
  const sigs = await connection.getSignaturesForAddress(SKYE_CURVE_ID, { limit: SIG_LIMIT });
  const txResults = await Promise.allSettled(
    sigs.map(s => connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }))
  );

  const onChainMints: string[] = [];
  for (const result of txResults) {
    if (result.status !== "fulfilled" || !result.value?.meta?.logMessages) continue;
    const launchedLog = result.value.meta.logMessages.find(l => l.includes("Token launched:"));
    if (!launchedLog) continue;
    const m = launchedLog.match(/mint=([A-Za-z0-9]+)/);
    if (m && !DEAD_MINTS.has(m[1])) onChainMints.push(m[1]);
  }

  // 2) Combine on-chain launches with anything in this browser's local
  //    launchStore (so the launching browser sees its own tokens even if
  //    they fall off the recent-50 signature window). Always include SKYE
  //    so the World view has the official coin.
  const allMints = [
    ...new Set([SKYE_MINT.toBase58(), ...stored.map(s => s.mint), ...onChainMints]),
  ].filter(m => !DEAD_MINTS.has(m));

  // 3) Batch-fetch all curve PDAs in a single getMultipleAccountsInfo.
  const curvePDAs = allMints.map(mintStr =>
    PublicKey.findProgramAddressSync([Buffer.from("curve"), new PublicKey(mintStr).toBuffer()], SKYE_CURVE_ID)[0]
  );
  const curveAccounts = await connection.getMultipleAccountsInfo(curvePDAs);

  // 4) Build the base list. Skip anything where the curve doesn't exist or
  //    has no liquidity yet — those are dead/unfunded.
  const results: DiscoveredTokenBase[] = [];
  for (let i = 0; i < allMints.length; i++) {
    const mintStr = allMints[i];
    const acct = curveAccounts[i];
    if (!acct || acct.data.length < 211) continue;

    const virtualToken = Number(acct.data.readBigUInt64LE(168));
    const virtualSol = Number(acct.data.readBigUInt64LE(176));
    const realSol = Number(acct.data.readBigUInt64LE(184));
    const graduated = acct.data[210] === 1;
    if (virtualToken <= 0 || virtualSol <= 0) continue;

    const creator = new PublicKey(acct.data.slice(8, 40)).toBase58();
    const info = stored.find(s => s.mint === mintStr);

    results.push({
      mint: mintStr,
      curve: curvePDAs[i].toBase58(),
      creator: creator || info?.creator || "",
      launchedAt: info?.launchedAt || 0,
      name: info?.name || mintStr.slice(0, 6) + "...",
      symbol: info?.symbol || "???",
      image: info?.image || "",
      description: info?.description || "",
      website: info?.website || "",
      twitter: info?.twitter || "",
      telegram: info?.telegram || "",
      discord: info?.discord || "",
      realSol, virtualSol, virtualToken, graduated,
    });
  }

  // 5) Enrich with on-chain Metaplex metadata. fetchMetadataForMints
  //    has its own in-memory + localStorage cache so this is cheap on
  //    repeat calls.
  if (results.length > 0) {
    try {
      const meta = await fetchMetadataForMints(connection, results.map(r => r.mint));
      for (const t of results) {
        const m = meta.get(t.mint);
        if (!m || !m.image) continue;
        // Prefer launchStore values if they exist (they were set by the
        // launching user). Otherwise use the on-chain metadata so that
        // visitors who never launched the token still see the image.
        if (!t.image) t.image = m.image;
        if (!t.name || t.name === t.mint.slice(0, 6) + "...") t.name = m.name || t.name;
        if (!t.symbol || t.symbol === "???") t.symbol = m.symbol || t.symbol;
        if (!t.description) t.description = m.description;
      }
    } catch { /* enrichment is best-effort */ }
  }

  return results;
}

function fetchAndCache(connection: Connection): Promise<DiscoveredTokenBase[]> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const tokens = await doFetch(connection);
      cache = { tokens, ts: Date.now() };
      notifyAll(tokens);
      return tokens;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export interface UseDiscoveredTokensState {
  tokens: DiscoveredTokenBase[];
  loading: boolean;
}

export function useDiscoveredTokens(): UseDiscoveredTokensState {
  const { connection } = useConnection();
  // Initialize from cache synchronously so the first render is instant
  // when there's already cached data from a previous tab visit.
  const [tokens, setTokens] = useState<DiscoveredTokenBase[]>(() => cache?.tokens ?? []);
  const [loading, setLoading] = useState<boolean>(() => cache === null);

  useEffect(() => {
    let active = true;

    const onUpdate = (next: DiscoveredTokenBase[]) => {
      if (!active) return;
      setTokens(next);
      setLoading(false);
    };
    subscribers.add(onUpdate);

    // If we have cache, surface it immediately (in case it changed between
    // mount and effect run).
    if (cache) {
      setTokens(cache.tokens);
      setLoading(false);
    }

    // Decide whether to fetch:
    //   - No cache → fetch and show loading until done
    //   - Cache stale → fetch in background, keep showing cached data
    //   - Cache fresh → no fetch
    const stale = !cache || (Date.now() - cache.ts) > REFRESH_TTL_MS;
    if (stale) {
      if (!cache) setLoading(true);
      fetchAndCache(connection).catch(() => {
        if (active) setLoading(false);
      });
    }

    return () => {
      active = false;
      subscribers.delete(onUpdate);
    };
  }, [connection]);

  return { tokens, loading };
}
