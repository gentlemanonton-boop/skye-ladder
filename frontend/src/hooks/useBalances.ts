import { useEffect, useState, useCallback, useRef } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, getAccount,
  ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT,
} from "@solana/spl-token";
import { SKYE_MINT, DECIMALS } from "../constants";

export interface TokenBalance {
  mint: string;
  symbol: string;
  name: string;
  balance: number;
  decimals: number;
  uiAmount: string;
  usdValue?: number;
  isNative?: boolean;
  isToken2022?: boolean;
  logo?: string;
}

interface JupiterToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI: string;
}

// Jupiter token list cache — fetched once per session
let jupiterCache: Map<string, JupiterToken> | null = null;
let jupiterFetching = false;
const jupiterWaiters: Array<() => void> = [];

async function getJupiterTokens(): Promise<Map<string, JupiterToken>> {
  if (jupiterCache) return jupiterCache;

  if (jupiterFetching) {
    return new Promise((resolve) => {
      jupiterWaiters.push(() => resolve(jupiterCache!));
    });
  }

  jupiterFetching = true;
  // No external token list fetch — hardcoded metadata covers all major tokens.
  // Jupiter's token list endpoints are unreliable (DNS failures, auth changes).
  jupiterCache = new Map();
  jupiterFetching = false;
  jupiterWaiters.forEach(fn => fn());
  jupiterWaiters.length = 0;
  return jupiterCache;
}

// Hardcoded fallback for SKYE (not on Jupiter)
const SKYE_META = {
  address: SKYE_MINT.toBase58(),
  symbol: "SKYE",
  name: "Skye",
  decimals: DECIMALS,
  logoURI: "/logo.jpeg",
};

export function useBalances() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [skyeBalance, setSkyeBalance] = useState<number | null>(null);
  const [allTokens, setAllTokens] = useState<TokenBalance[]>([]);
  const jupRef = useRef<Map<string, JupiterToken>>(new Map());

  const fetchAll = useCallback(async () => {
    if (!publicKey) return;

    // Ensure Jupiter metadata is loaded
    if (jupRef.current.size === 0) {
      jupRef.current = await getJupiterTokens();
    }
    const jup = jupRef.current;

    // Hardcoded metadata for common tokens — never depends on Jupiter API
    const HARDCODED: Record<string, { symbol: string; name: string; decimals: number; logo?: string }> = {
      [SKYE_MINT.toBase58()]: { symbol: "SKYE", name: "Skye", decimals: DECIMALS, logo: SKYE_META.logoURI },
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { symbol: "USDC", name: "USD Coin", decimals: 6, logo: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png" },
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": { symbol: "USDT", name: "Tether", decimals: 6, logo: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.png" },
      "So11111111111111111111111111111111111111112": { symbol: "WSOL", name: "Wrapped SOL", decimals: 9, logo: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png" },
      "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN": { symbol: "JUP", name: "Jupiter", decimals: 6 },
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": { symbol: "BONK", name: "Bonk", decimals: 5 },
      "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So": { symbol: "mSOL", name: "Marinade SOL", decimals: 9 },
      "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn": { symbol: "jitoSOL", name: "Jito SOL", decimals: 9 },
      "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": { symbol: "ETH", name: "Ethereum (Wormhole)", decimals: 8 },
    };

    function lookupMeta(mint: string): { symbol: string; name: string; decimals: number; logo?: string } {
      const hc = HARDCODED[mint];
      if (hc) return hc;
      const j = jup.get(mint);
      if (j) return { symbol: j.symbol, name: j.name, decimals: j.decimals, logo: j.logoURI };
      return { symbol: mint.slice(0, 4) + "...", name: "Unknown Token", decimals: 9 };
    }

    // Fetch SOL balance
    try {
      const sol = await connection.getBalance(publicKey);
      setSolBalance(sol / LAMPORTS_PER_SOL);
    } catch { setSolBalance(null); }

    // Fetch SKYE specifically (Token-2022)
    try {
      const ata = getAssociatedTokenAddressSync(
        SKYE_MINT, publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const account = await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
      setSkyeBalance(Number(account.amount) / 10 ** DECIMALS);
    } catch { setSkyeBalance(0); }

    // Fetch ALL token accounts (SPL + Token-2022)
    const tokens: TokenBalance[] = [];

    // Collect raw token accounts first (mint + amount), then batch-fetch decimals
    const rawTokens: { mint: string; amount: number; isT22: boolean }[] = [];

    function collectAccounts(accounts: { account: { data: Buffer } }[], isT22: boolean) {
      for (const { account } of accounts) {
        try {
          const data = account.data;
          const mint = new PublicKey(data.slice(0, 32)).toBase58();
          const amount = Number(data.readBigUInt64LE(64));
          if (amount === 0) continue;
          rawTokens.push({ mint, amount, isT22 });
        } catch {}
      }
    }

    try {
      const splAccounts = await connection.getTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID });
      collectAccounts(splAccounts.value as any, false);
    } catch {}

    try {
      const t22Accounts = await connection.getTokenAccountsByOwner(publicKey, { programId: TOKEN_2022_PROGRAM_ID });
      collectAccounts(t22Accounts.value as any, true);
    } catch {}

    // Batch-fetch mint accounts to get real decimals
    const unknownMints = rawTokens
      .filter(t => !HARDCODED[t.mint])
      .map(t => t.mint);
    const mintDecimals: Record<string, number> = {};
    if (unknownMints.length > 0) {
      try {
        const uniqueMints = [...new Set(unknownMints)];
        // Batch in groups of 100
        for (let i = 0; i < uniqueMints.length; i += 100) {
          const batch = uniqueMints.slice(i, i + 100).map(m => new PublicKey(m));
          const infos = await connection.getMultipleAccountsInfo(batch);
          for (let j = 0; j < batch.length; j++) {
            const info = infos[j];
            if (info && info.data.length >= 45) {
              mintDecimals[batch[j].toBase58()] = info.data[44];
            }
          }
        }
      } catch {}
    }

    // Build final token list with correct decimals
    for (const { mint, amount, isT22 } of rawTokens) {
      const meta = lookupMeta(mint);
      const decimals = HARDCODED[mint] ? meta.decimals : (mintDecimals[mint] ?? meta.decimals);
      const uiAmount = amount / 10 ** decimals;

      tokens.push({
        mint,
        symbol: meta.symbol,
        name: meta.name,
        balance: amount,
        decimals,
        uiAmount: uiAmount < 0.001 ? uiAmount.toExponential(2) : uiAmount.toLocaleString(undefined, { maximumFractionDigits: 4 }),
        isNative: mint === NATIVE_MINT.toBase58(),
        isToken2022: isT22,
        logo: meta.logo,
      });
    }

    // Sort: tokens with logos first, then by raw balance descending
    tokens.sort((a, b) => {
      const aHasLogo = a.logo ? 1 : 0;
      const bHasLogo = b.logo ? 1 : 0;
      if (aHasLogo !== bHasLogo) return bHasLogo - aHasLogo;
      return b.balance - a.balance;
    });

    setAllTokens(tokens);
  }, [connection, publicKey]);

  useEffect(() => {
    if (!publicKey) {
      setSolBalance(null);
      setSkyeBalance(null);
      setAllTokens([]);
      return;
    }

    fetchAll();
    const interval = setInterval(fetchAll, 15000);
    return () => clearInterval(interval);
  }, [publicKey, fetchAll]);

  return { solBalance, skyeBalance, allTokens, refreshBalances: fetchAll };
}
