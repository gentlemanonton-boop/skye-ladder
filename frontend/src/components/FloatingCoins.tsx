import { useEffect, useRef, useState } from "react";

interface MockToken {
  symbol: string;
  mc: number;
  logo: string;
  color: string;
}

const MOCK_TOKENS: MockToken[] = [
  { symbol: "SKYE", mc: 29_000, logo: "https://gateway.irys.xyz/YkvolVl__ug43pWw3H-cYF2vLN_zE_1LRt6FjcYmkcc", color: "#22c55e" },
  { symbol: "LUNA", mc: 50_000, logo: "", color: "#6366f1" },
  { symbol: "APEX", mc: 190_000, logo: "", color: "#f59e0b" },
  { symbol: "NEON", mc: 200_000, logo: "", color: "#06b6d4" },
  { symbol: "VOLT", mc: 758_000, logo: "", color: "#ec4899" },
  { symbol: "WAVE", mc: 950_000, logo: "", color: "#8b5cf6" },
  { symbol: "NOVA", mc: 1_000_000, logo: "", color: "#14b8a6" },
  { symbol: "BLZE", mc: 1_200_000, logo: "", color: "#f97316" },
  { symbol: "TITAN", mc: 26_300_000, logo: "", color: "#3b82f6" },
  { symbol: "OMEGA", mc: 293_000_000, logo: "", color: "#eab308" },
];

// Map MC to vertical position (0 = bottom, 100 = top)
// Use log scale so low MC tokens aren't all crammed at the bottom
function mcToY(mc: number): number {
  const minLog = Math.log10(10_000);    // $10K = bottom
  const maxLog = Math.log10(500_000_000); // $500M = top
  const log = Math.log10(Math.max(mc, 10_000));
  return ((log - minLog) / (maxLog - minLog)) * 100;
}

function formatMC(mc: number): string {
  if (mc >= 1_000_000) return `$${(mc / 1_000_000).toFixed(1)}M`;
  if (mc >= 1_000) return `$${(mc / 1_000).toFixed(0)}K`;
  return `$${mc}`;
}

interface CoinState {
  token: MockToken;
  x: number;        // horizontal position (%)
  baseY: number;    // base vertical position from MC (%)
  offsetY: number;  // current float offset
  driftSpeed: number;
  driftPhase: number;
  side: "left" | "right";
  size: number;
  opacity: number;
}

export function FloatingCoins() {
  const [coins, setCoins] = useState<CoinState[]>([]);
  const frameRef = useRef<number>(0);
  const startTime = useRef(Date.now());

  useEffect(() => {
    // Initialize coin positions
    const sorted = [...MOCK_TOKENS].sort((a, b) => a.mc - b.mc);
    const initial: CoinState[] = sorted.map((token, i) => {
      const side = i % 2 === 0 ? "left" : "right";
      // Spread horizontally within their side
      const xBase = side === "left" ? 3 + Math.random() * 10 : 87 + Math.random() * 10;
      const baseY = mcToY(token.mc);
      // Bigger MC = slightly larger coin
      const mcRatio = Math.log10(token.mc) / Math.log10(500_000_000);
      const size = 48 + mcRatio * 32;
      const opacity = 0.4 + mcRatio * 0.4;

      return {
        token,
        x: xBase,
        baseY,
        offsetY: 0,
        driftSpeed: 0.3 + Math.random() * 0.5,
        driftPhase: Math.random() * Math.PI * 2,
        side,
        size,
        opacity,
      };
    });
    setCoins(initial);

    // Animation loop
    function animate() {
      const elapsed = (Date.now() - startTime.current) / 1000;
      setCoins(prev => prev.map(coin => ({
        ...coin,
        offsetY: Math.sin(elapsed * coin.driftSpeed + coin.driftPhase) * 2.5
          + Math.sin(elapsed * coin.driftSpeed * 0.7 + coin.driftPhase * 1.3) * 1.5,
      })));
      frameRef.current = requestAnimationFrame(animate);
    }
    frameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameRef.current);
  }, []);

  return (
    <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
      {coins.map((coin, i) => {
        const y = 100 - coin.baseY - coin.offsetY; // invert: high MC = high on screen
        return (
          <div
            key={i}
            className="absolute transition-none"
            style={{
              left: `${coin.x}%`,
              top: `${y}%`,
              opacity: coin.opacity,
              transform: `translateY(${coin.offsetY * 3}px)`,
              willChange: "transform, top",
            }}
          >
            {/* Glow */}
            <div
              className="absolute rounded-full blur-xl"
              style={{
                width: coin.size * 2,
                height: coin.size * 2,
                top: -coin.size / 2,
                left: -coin.size / 2,
                background: coin.token.color,
                opacity: 0.3,
              }}
            />
            {/* Coin */}
            <div
              className="relative rounded-full flex items-center justify-center overflow-hidden border border-white/10"
              style={{
                width: coin.size,
                height: coin.size,
                background: `radial-gradient(circle at 30% 30%, ${coin.token.color}70, ${coin.token.color}30)`,
                boxShadow: `0 0 ${coin.size}px ${coin.token.color}40`,
              }}
            >
              {coin.token.logo ? (
                <img src={coin.token.logo} alt={coin.token.symbol} className="w-full h-full rounded-full" style={{ opacity: 0.9 }} />
              ) : (
                <span className="text-white font-bold" style={{ fontSize: coin.size * 0.3, opacity: 0.85 }}>
                  {coin.token.symbol.slice(0, 2)}
                </span>
              )}
            </div>
            {/* Label */}
            <div className="absolute left-1/2 -translate-x-1/2 mt-1.5 text-center whitespace-nowrap" style={{ opacity: 0.75 }}>
              <div className="text-white font-bold" style={{ fontSize: 10 }}>{coin.token.symbol}</div>
              <div className="text-white/70 font-medium" style={{ fontSize: 9 }}>{formatMC(coin.token.mc)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
