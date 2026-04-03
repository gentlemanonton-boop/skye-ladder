import { useEffect, useState } from "react";

const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";
const FALLBACK_PRICE = 140;
const REFRESH_MS = 60_000;

export function useSolPrice() {
  const [price, setPrice] = useState(FALLBACK_PRICE);

  useEffect(() => {
    let cancelled = false;

    async function fetch_() {
      try {
        const res = await fetch(COINGECKO_URL);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data?.solana?.usd) {
          setPrice(data.solana.usd);
        }
      } catch { /* use fallback */ }
    }

    fetch_();
    const interval = setInterval(fetch_, REFRESH_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  return price;
}
