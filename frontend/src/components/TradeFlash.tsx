import { useEffect, useState } from "react";
import { useLiveTrades, type LiveTrade } from "../hooks/useLiveTrades";

interface Flash {
  id: number;
  type: "buy" | "sell";
  amount: string;
}

let flashId = 0;

export function TradeFlash() {
  const trades = useLiveTrades();
  const [flashes, setFlashes] = useState<Flash[]>([]);
  const [lastSeen, setLastSeen] = useState<string | null>(null);

  // Convert new trades into flash notifications
  useEffect(() => {
    if (trades.length === 0) return;
    const latest = trades[0];
    if (latest.signature === lastSeen) return;
    setLastSeen(latest.signature);

    if (latest.type === "buy") {
      const sol = (latest.solAmount / 1e9).toFixed(3);
      setFlashes(prev => [...prev, { id: ++flashId, type: "buy", amount: sol + " SOL" }]);
    } else {
      const tokens = latest.skyeAmount / 1e9;
      const display = tokens >= 1e6 ? (tokens/1e6).toFixed(1)+"M" : tokens >= 1e3 ? (tokens/1e3).toFixed(1)+"K" : tokens.toFixed(0);
      setFlashes(prev => [...prev, { id: ++flashId, type: "sell", amount: display + " SKYE" }]);
    }
  }, [trades, lastSeen]);

  // Auto-remove flashes after animation
  useEffect(() => {
    if (flashes.length === 0) return;
    const timer = setTimeout(() => setFlashes(prev => prev.slice(1)), 3000);
    return () => clearTimeout(timer);
  }, [flashes]);

  if (flashes.length === 0) return null;

  const flash = flashes[0];

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
      <div className={`trade-flash ${flash.type === "buy" ? "flash-buy" : "flash-sell"}`}>
        {/* Pixel energy ring */}
        <div className="flash-ring" />
        <div className="flash-ring flash-ring-2" />

        {/* Core */}
        <div className="flash-core">
          <span className="font-pixel text-[8px] sm:text-[9px] tracking-wider">
            {flash.type === "buy" ? "BUY" : "SELL"}
          </span>
          <span className="text-[11px] sm:text-[12px] font-bold mt-0.5">
            {flash.amount}
          </span>
        </div>

        {/* Pixel particles */}
        {[...Array(8)].map((_, i) => (
          <div key={i} className={`flash-particle particle-${i}`} />
        ))}
      </div>
    </div>
  );
}
