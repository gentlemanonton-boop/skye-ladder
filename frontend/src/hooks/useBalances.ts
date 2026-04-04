import { useEffect, useState, useCallback } from "react";
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
  balance: number;
  decimals: number;
  uiAmount: string;
  isNative?: boolean;
  isToken2022?: boolean;
  logo?: string;
}

// Known token metadata for display
const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number; logo?: string }> = {
  [NATIVE_MINT.toBase58()]: { symbol: "WSOL", decimals: 9 },
  [SKYE_MINT.toBase58()]: { symbol: "SKYE", decimals: DECIMALS },
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { symbol: "USDC", decimals: 6, logo: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png" },
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": { symbol: "USDT", decimals: 6, logo: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.png" },
  "So11111111111111111111111111111111111111112": { symbol: "WSOL", decimals: 9 },
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN": { symbol: "JUP", decimals: 6 },
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": { symbol: "BONK", decimals: 5 },
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": { symbol: "ETH", decimals: 8 },
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So": { symbol: "mSOL", decimals: 9 },
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn": { symbol: "jitoSOL", decimals: 9 },
  "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1": { symbol: "bSOL", decimals: 9 },
};

export function useBalances() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [skyeBalance, setSkyeBalance] = useState<number | null>(null);
  const [allTokens, setAllTokens] = useState<TokenBalance[]>([]);

  const fetchAll = useCallback(async () => {
    if (!publicKey) return;

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

    try {
      // SPL Token accounts
      const splAccounts = await connection.getTokenAccountsByOwner(publicKey, {
        programId: TOKEN_PROGRAM_ID,
      });

      for (const { account } of splAccounts.value) {
        try {
          const data = account.data;
          const mint = new PublicKey(data.slice(0, 32)).toBase58();
          const amount = Number(data.readBigUInt64LE(64));
          if (amount === 0) continue;

          const known = KNOWN_TOKENS[mint];
          const decimals = known?.decimals ?? 9;
          const uiAmount = amount / 10 ** decimals;

          tokens.push({
            mint,
            symbol: known?.symbol ?? mint.slice(0, 4) + "...",
            balance: amount,
            decimals,
            uiAmount: uiAmount < 0.001 ? uiAmount.toExponential(2) : uiAmount.toLocaleString(undefined, { maximumFractionDigits: 4 }),
            isNative: mint === NATIVE_MINT.toBase58(),
            logo: known?.logo,
          });
        } catch {}
      }
    } catch {}

    try {
      // Token-2022 accounts
      const t22Accounts = await connection.getTokenAccountsByOwner(publicKey, {
        programId: TOKEN_2022_PROGRAM_ID,
      });

      for (const { account } of t22Accounts.value) {
        try {
          const data = account.data;
          const mint = new PublicKey(data.slice(0, 32)).toBase58();
          const amount = Number(data.readBigUInt64LE(64));
          if (amount === 0) continue;

          const known = KNOWN_TOKENS[mint];
          const decimals = known?.decimals ?? 9;
          const uiAmount = amount / 10 ** decimals;

          tokens.push({
            mint,
            symbol: known?.symbol ?? mint.slice(0, 4) + "...",
            balance: amount,
            decimals,
            uiAmount: uiAmount < 0.001 ? uiAmount.toExponential(2) : uiAmount.toLocaleString(undefined, { maximumFractionDigits: 4 }),
            isToken2022: true,
            logo: known?.logo,
          });
        } catch {}
      }
    } catch {}

    // Sort: known tokens first, then by balance descending
    tokens.sort((a, b) => {
      const aKnown = KNOWN_TOKENS[a.mint] ? 1 : 0;
      const bKnown = KNOWN_TOKENS[b.mint] ? 1 : 0;
      if (aKnown !== bKnown) return bKnown - aKnown;
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
