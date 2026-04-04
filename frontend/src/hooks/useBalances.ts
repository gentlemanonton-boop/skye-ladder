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
  try {
    const res = await fetch("https://token.jup.ag/all");
    const tokens: JupiterToken[] = await res.json();
    jupiterCache = new Map(tokens.map(t => [t.address, t]));
  } catch {
    jupiterCache = new Map();
  }
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
  logoURI: "https://gateway.irys.xyz/YkvolVl__ug43pWw3H-cYF2vLN_zE_1LRt6FjcYmkcc",
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

    function lookupMeta(mint: string): { symbol: string; name: string; decimals: number; logo?: string } {
      if (mint === SKYE_MINT.toBase58()) {
        return { symbol: SKYE_META.symbol, name: SKYE_META.name, decimals: SKYE_META.decimals, logo: SKYE_META.logoURI };
      }
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

    function parseAccounts(accounts: { account: { data: Buffer } }[], isT22: boolean) {
      for (const { account } of accounts) {
        try {
          const data = account.data;
          const mint = new PublicKey(data.slice(0, 32)).toBase58();
          const amount = Number(data.readBigUInt64LE(64));
          if (amount === 0) continue;

          const meta = lookupMeta(mint);
          const uiAmount = amount / 10 ** meta.decimals;

          tokens.push({
            mint,
            symbol: meta.symbol,
            name: meta.name,
            balance: amount,
            decimals: meta.decimals,
            uiAmount: uiAmount < 0.001 ? uiAmount.toExponential(2) : uiAmount.toLocaleString(undefined, { maximumFractionDigits: 4 }),
            isNative: mint === NATIVE_MINT.toBase58(),
            isToken2022: isT22,
            logo: meta.logo,
          });
        } catch {}
      }
    }

    try {
      const splAccounts = await connection.getTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID });
      parseAccounts(splAccounts.value as any, false);
    } catch {}

    try {
      const t22Accounts = await connection.getTokenAccountsByOwner(publicKey, { programId: TOKEN_2022_PROGRAM_ID });
      parseAccounts(t22Accounts.value as any, true);
    } catch {}

    // Fetch USD prices from Jupiter for all mints
    try {
      const mints = tokens.map(t => t.mint);
      if (mints.length > 0) {
        // Jupiter price API accepts up to 100 mints
        const chunks = [];
        for (let i = 0; i < mints.length; i += 100) {
          chunks.push(mints.slice(i, i + 100));
        }
        for (const chunk of chunks) {
          const ids = chunk.join(",");
          const priceRes = await fetch(`https://api.jup.ag/price/v2?ids=${ids}`);
          const priceData = await priceRes.json();
          if (priceData?.data) {
            for (const token of tokens) {
              const p = priceData.data[token.mint];
              if (p?.price) {
                const uiVal = token.balance / 10 ** token.decimals;
                token.usdValue = uiVal * parseFloat(p.price);
              }
            }
          }
        }
      }
    } catch {}

    // Sort: by USD value descending (unknown value last)
    tokens.sort((a, b) => {
      const aVal = a.usdValue ?? -1;
      const bVal = b.usdValue ?? -1;
      return bVal - aVal;
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
