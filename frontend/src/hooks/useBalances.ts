import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { SKYE_MINT, DECIMALS } from "../constants";

export function useBalances() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [skyeBalance, setSkyeBalance] = useState<number | null>(null);

  useEffect(() => {
    if (!publicKey) {
      setSolBalance(null);
      setSkyeBalance(null);
      return;
    }

    let cancelled = false;

    async function fetch() {
      try {
        const sol = await connection.getBalance(publicKey!);
        if (!cancelled) setSolBalance(sol / LAMPORTS_PER_SOL);
      } catch { if (!cancelled) setSolBalance(null); }

      try {
        const ata = getAssociatedTokenAddressSync(
          SKYE_MINT, publicKey!, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
        );
        const account = await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
        if (!cancelled) setSkyeBalance(Number(account.amount) / 10 ** DECIMALS);
      } catch { if (!cancelled) setSkyeBalance(0); }
    }

    fetch();
    const interval = setInterval(fetch, 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [connection, publicKey]);

  return { solBalance, skyeBalance };
}
