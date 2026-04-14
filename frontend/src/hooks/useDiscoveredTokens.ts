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
  "5o35mhPhmhbcvd6wJTzwTzrwCYyJNodCUwjecwN86VSn", // test launch (no hook config)
  "HTPUwZ7RMsFHdderwwW3DzgYQhDnSPnZQ3mXhsnkNN5R", // test launch (no hook config)
  "G6gXhANJNjPbdoa4EnTn12VZjWJQYa79Nbi3UFCoEGZC", // failed launch (no pool)
  "2xdcq2KYoRT6e5Z3qRDeCucJXPF5u5988VpJJQ26oDsX", // failed launch (no pool)
  "DXSnfYZ4xkMiziCb8gcQKC8ZAtt7y7DFYMCRJrV18a3G", // failed launch (no pool)
  "7phvGL1U9T1Xn8df426fTT81JdfmNNmATrWyB76G18Bj", // failed launch (no pool)
  "GkSdENrVHAThJr39RKGS3hcRV5hqmfBjJUXJAp9nxQ2V", // failed launch (no mint, no pool)
  "GkSdENrVHATh26ca7cbVerXgQk9V4ECUuLfc6oHWdgSS", // duplicate zoomer
  "EbjHFdcf3XKpfP8Vqwq3fkphMAnwfXx44WyftFnN7jSL", // looksmaxxing test (no image)
  "6VS9dRiXtK93ic2WucNbfovY2GeyUxtPhvnkvMF8Czcd", // looksmaxxing test (no image)
]);

const REFRESH_TTL_MS = 30_000;       // in-memory token cache: background refresh after this
const MINT_CACHE_KEY = "skye_discovered_mints_v1";

// ── Module-level cache + subscriber bus ─────────────────────────────────
let cache: { tokens: DiscoveredTokenBase[]; ts: number } | null = null;
let inFlight: Promise<DiscoveredTokenBase[]> | null = null;
const subscribers = new Set<(tokens: DiscoveredTokenBase[]) => void>();

function notifyAll(tokens: DiscoveredTokenBase[]) {
  for (const fn of subscribers) {
    try { fn(tokens); } catch {}
  }
}

// ── Mint list persistence (separate from in-memory token cache) ─────────
//
// The slow part of the fetch is walking recent program signatures to find
// new mints. We persist the discovered mints in localStorage so visits
// after the first one can skip that walk entirely and only do a single
// getMultipleAccountsInfo call (~300ms instead of ~3s).
//
// Convergence: once any browser sees a mint, it's cached forever for
// that browser. Different browsers eventually converge on the full set
// after a few visits as the background refresh adds new mints.

function loadMintCache(): string[] {
  try {
    const raw = localStorage.getItem(MINT_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveMintCache(mints: string[]) {
  try { localStorage.setItem(MINT_CACHE_KEY, JSON.stringify(mints)); } catch {}
}

// Enumerate ALL curve accounts via getProgramAccounts. Filters by exact
// account size (284 bytes) to skip LaunchpadConfig and other non-curve
// accounts. Extracts the mint pubkey from each curve's data.
async function discoverNewMints(connection: Connection): Promise<string[]> {
  const accounts = await connection.getProgramAccounts(SKYE_CURVE_ID, {
    filters: [{ dataSize: 284 }],
    dataSlice: { offset: 40, length: 32 }, // just the mint field
  });
  return accounts
    .map(a => new PublicKey(a.account.data).toBase58())
    .filter(m => !DEAD_MINTS.has(m));
}

async function doFetch(connection: Connection): Promise<DiscoveredTokenBase[]> {
  const stored = getStoredTokens();
  const cachedMints = loadMintCache();

  // Build the candidate mint list from three sources:
  //   1. Persisted mint cache (the fast path — no RPC call needed)
  //   2. The launching browser's localStorage (for tokens this browser
  //      launched but hasn't fully synced yet)
  //   3. SKYE itself (always present in the World view)
  //
  // If the persisted cache is empty, we walk signatures synchronously.
  // Otherwise we kick off the discovery walk in the background and merge
  // any newly found mints into the cache for next time.
  let onChainMints: string[];
  if (cachedMints.length === 0) {
    // Cold cache: do the slow walk inline
    onChainMints = await discoverNewMints(connection);
    saveMintCache(onChainMints);
  } else {
    // Warm cache: use it now, kick off a background refresh
    onChainMints = cachedMints;
    // fire-and-forget — updates the cache so the NEXT visit catches new launches
    discoverNewMints(connection).then(fresh => {
      const merged = [...new Set([...cachedMints, ...fresh])];
      if (merged.length !== cachedMints.length) {
        saveMintCache(merged);
        // If new mints were discovered, kick the in-memory cache to refetch
        // so the user sees them within ~30s without a manual refresh.
        cache = null;
      }
    }).catch(() => {});
  }

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

  // 5) Enrich with on-chain Metaplex metadata + Vercel Blob fallback.
  if (results.length > 0) {
    // First try Metaplex on-chain metadata
    try {
      const meta = await fetchMetadataForMints(connection, results.map(r => r.mint));
      for (const t of results) {
        const m = meta.get(t.mint);
        if (!m) continue;
        if (m.image && !t.image) t.image = m.image;
        if (m.name && (!t.name || t.name === t.mint.slice(0, 6) + "...")) t.name = m.name;
        if (m.symbol && (!t.symbol || t.symbol === "???")) t.symbol = m.symbol;
        if (m.description && !t.description) t.description = m.description;
      }
    } catch { /* best-effort */ }

    // Fallback: fetch from Vercel Blob API for tokens still missing data
    const needsEnrichment = results.filter(
      t => !t.image || !t.name || t.name === t.mint.slice(0, 6) + "..." || t.symbol === "???"
    );
    if (needsEnrichment.length > 0) {
      await Promise.allSettled(needsEnrichment.map(async t => {
        try {
          const res = await fetch(`/api/token-metadata?mint=${t.mint}`);
          if (!res.ok) return;
          const m = await res.json();
          if (m.image && !t.image) t.image = m.image;
          if (m.name && (!t.name || t.name === t.mint.slice(0, 6) + "...")) t.name = m.name;
          if (m.symbol && (!t.symbol || t.symbol === "???")) t.symbol = m.symbol;
          if (m.description && !t.description) t.description = m.description;
        } catch { /* best-effort */ }
      }));
    }
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
