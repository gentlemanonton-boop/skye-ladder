/**
 * metadataReader.ts — Read Metaplex Token Metadata for one or more mints.
 *
 * Strategy:
 *  1. Derive the Metaplex metadata PDA for each mint.
 *  2. Batch-fetch the PDAs via getMultipleAccountsInfo.
 *  3. Borsh-parse each account to extract the off-chain JSON URI.
 *  4. Fetch each URI in parallel and return { name, symbol, image, description }.
 *
 * Results are cached in memory + localStorage. Arweave content is immutable, so
 * no TTL is needed — once an image URL resolves, we can keep it forever.
 */

import { PublicKey, Connection } from "@solana/web3.js";

export const METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

export interface OnChainTokenMetadata {
  mint: string;
  name: string;
  symbol: string;
  image: string;
  description: string;
}

const CACHE_KEY = "skye_metadata_cache_v1";
const memCache = new Map<string, OnChainTokenMetadata>();

function loadDiskCache(): Record<string, OnChainTokenMetadata> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveDiskCache(cache: Record<string, OnChainTokenMetadata>) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {}
}

// Hydrate memory cache from disk on module load
{
  const disk = loadDiskCache();
  for (const [k, v] of Object.entries(disk)) memCache.set(k, v);
}

function findMetadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID
  )[0];
}

/**
 * Parse the on-chain Metaplex Metadata account.
 *
 * Layout (borsh):
 *   key: u8                           — 1 byte
 *   update_authority: pubkey          — 32 bytes
 *   mint: pubkey                      — 32 bytes
 *   data:
 *     name: string                    — 4 byte len + bytes (puffed to 32)
 *     symbol: string                  — 4 byte len + bytes (puffed to 10)
 *     uri: string                     — 4 byte len + bytes (puffed to 200)
 *     ...
 *
 * Metaplex puffs strings with \0 padding to their max length, so we strip
 * trailing nulls after decoding.
 */
function parseMetadataAccount(
  data: Buffer
): { name: string; symbol: string; uri: string } | null {
  try {
    let offset = 1 + 32 + 32;
    const decoder = new TextDecoder();

    const readString = (): string => {
      const len = data.readUInt32LE(offset);
      offset += 4;
      const bytes = data.slice(offset, offset + len);
      offset += len;
      return decoder.decode(bytes).replace(/\0+$/, "").trim();
    };

    const name = readString();
    const symbol = readString();
    const uri = readString();

    return { name, symbol, uri };
  } catch {
    return null;
  }
}

/**
 * Fetch metadata for a list of mints. Returns a Map keyed by mint address.
 * Mints with no on-chain metadata (or unreachable URIs) are simply omitted —
 * callers should fall back to whatever local data they have.
 */
export async function fetchMetadataForMints(
  connection: Connection,
  mints: string[]
): Promise<Map<string, OnChainTokenMetadata>> {
  const result = new Map<string, OnChainTokenMetadata>();
  const toFetch: string[] = [];

  for (const m of mints) {
    const cached = memCache.get(m);
    if (cached) result.set(m, cached);
    else toFetch.push(m);
  }

  if (toFetch.length === 0) return result;

  const pdas = toFetch.map(m => findMetadataPda(new PublicKey(m)));
  const accounts = await connection.getMultipleAccountsInfo(pdas);

  const parsed = toFetch.map((mint, i) => {
    const acc = accounts[i];
    if (!acc) return null;
    const p = parseMetadataAccount(Buffer.from(acc.data));
    if (!p) return null;
    return { mint, ...p };
  });

  const jsonResults = await Promise.allSettled(
    parsed.map(p =>
      p && p.uri
        ? fetch(p.uri).then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          })
        : Promise.reject()
    )
  );

  const diskCache = loadDiskCache();
  let cacheChanged = false;

  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    if (!p) continue;
    const jsonResult = jsonResults[i];

    let image = "";
    let description = "";
    let name = p.name;
    let symbol = p.symbol;

    if (jsonResult.status === "fulfilled" && jsonResult.value) {
      const j = jsonResult.value;
      image = j.image || "";
      description = j.description || "";
      if (j.name) name = j.name;
      if (j.symbol) symbol = j.symbol;
    }

    const meta: OnChainTokenMetadata = {
      mint: p.mint, name, symbol, image, description,
    };

    // Cache if we have at least a name (on-chain metadata exists)
    if (name) {
      memCache.set(p.mint, meta);
      diskCache[p.mint] = meta;
      cacheChanged = true;
    }

    result.set(p.mint, meta);
  }

  if (cacheChanged) saveDiskCache(diskCache);

  return result;
}
