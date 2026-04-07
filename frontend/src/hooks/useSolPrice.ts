import { useEffect, useState } from "react";

const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";
const CACHE_KEY = "skye_sol_usd_cache";
const REFRESH_MS = 60_000;

function loadCached(): number {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const cached = parseFloat(raw);
      if (cached > 0) return cached;
    }
  } catch {}
  return 80; // last-resort fallback (close to current SOL price)
}

export function useSolPrice() {
  const [price, setPrice] = useState(loadCached);

  useEffect(() => {
    let cancelled = false;

    async function fetch_() {
      try {
        const res = await fetch(COINGECKO_URL);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data?.solana?.usd) {
          const newPrice = data.solana.usd;
          setPrice(newPrice);
          try { localStorage.setItem(CACHE_KEY, newPrice.toString()); } catch {}
        }
      } catch { /* keep cached price, don't reset */ }
    }

    fetch_();
    const interval = setInterval(fetch_, REFRESH_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  return price;
}
