import { useEffect, useState, useRef } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useSolPrice } from "../hooks/useSolPrice";
import { getStoredTokens } from "../lib/launchStore";
import { formatUsd } from "../lib/format";
import { SKYE_CURVE_ID } from "../constants";

interface WorldToken {
  mint: string;
  name: string;
  symbol: string;
  image: string;
  mc: number;        // MC in USD
  mcSol: number;
  realSol: number;
  graduated: boolean;
}

// MC zones (USD)
const ZONES = [
  { name: "CHAOS", min: 0, max: 10_000, color: "rgba(34,197,94,0.15)", label: "< $10K" },
  { name: "STORM", min: 10_000, max: 100_000, color: "rgba(147,51,234,0.1)", label: "$10K - $100K" },
  { name: "CLOUDS", min: 100_000, max: 1_000_000, color: "rgba(59,130,246,0.08)", label: "$100K - $1M" },
  { name: "HEAVEN", min: 1_000_000, max: Infinity, color: "rgba(234,179,8,0.1)", label: "$1M+" },
];

const WORLD_HEIGHT = 2400; // px total height of the world

// Map MC (USD) to Y position (bottom = 0, top = WORLD_HEIGHT)
function mcToY(mc: number): number {
  const minLog = Math.log10(1000);       // $1K = very bottom
  const maxLog = Math.log10(500_000_000); // $500M = very top
  const log = Math.log10(Math.max(mc, 1000));
  const pct = Math.min(1, Math.max(0, (log - minLog) / (maxLog - minLog)));
  return pct * (WORLD_HEIGHT - 120) + 60; // 60px padding top/bottom
}

function getZone(mc: number): string {
  if (mc >= 1_000_000) return "HEAVEN";
  if (mc >= 100_000) return "CLOUDS";
  if (mc >= 10_000) return "STORM";
  return "CHAOS";
}

function getZoneGlow(zone: string): string {
  switch (zone) {
    case "HEAVEN": return "0 0 40px rgba(234,179,8,0.5), 0 0 80px rgba(234,179,8,0.2)";
    case "CLOUDS": return "0 0 30px rgba(59,130,246,0.4), 0 0 60px rgba(59,130,246,0.15)";
    case "STORM": return "0 0 25px rgba(147,51,234,0.4), 0 0 50px rgba(147,51,234,0.15)";
    default: return "0 0 20px rgba(239,68,68,0.4), 0 0 40px rgba(239,68,68,0.15)";
  }
}

export function WorldTab() {
  const { connection } = useConnection();
  const solUsd = useSolPrice();
  const [tokens, setTokens] = useState<WorldToken[]>([]);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [time, setTime] = useState(0);

  // Animation loop for floating
  useEffect(() => {
    let raf: number;
    const start = Date.now();
    function tick() {
      setTime((Date.now() - start) / 1000);
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Load tokens from curve program
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const stored = getStoredTokens();
        const EXCLUDED = new Set([
          "HREtu5WXuKJP1L23shpNTP3U4Xtmfekv82Lyuq1vMrsd",
          "5BJcCPdZbxBMhodSZxUMowHSNY38dqhiRgSxDw8uLqZ1",
          "4w1DQR7HuVNdK6YDKvgyGSQ7A6Ba7ChWL4Hof1HKw1j",
          "5GtUWP1x4LpKjAzGBZg9sy9TbTqjY2bvJfgfC7aUmAfF",
        ]);

        const sigs = await connection.getSignaturesForAddress(SKYE_CURVE_ID, { limit: 50 });
        const txResults = await Promise.allSettled(
          sigs.map(s => connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }))
        );

        const onChainMints: string[] = [];
        for (const result of txResults) {
          if (cancelled) break;
          if (result.status !== "fulfilled" || !result.value?.meta?.logMessages) continue;
          const l = result.value.meta.logMessages.find(l => l.includes("Token launched:"));
          if (!l) continue;
          const m = l.match(/mint=([A-Za-z0-9]+)/);
          if (m && !EXCLUDED.has(m[1])) onChainMints.push(m[1]);
        }

        const allMints = [...new Set([...stored.map(s => s.mint), ...onChainMints])].filter(m => !EXCLUDED.has(m));

        const curvePDAs = allMints.map(mintStr =>
          PublicKey.findProgramAddressSync([Buffer.from("curve"), new PublicKey(mintStr).toBuffer()], SKYE_CURVE_ID)[0]
        );
        const curveAccounts = await connection.getMultipleAccountsInfo(curvePDAs);

        const results: WorldToken[] = [];
        for (let i = 0; i < allMints.length; i++) {
          const mintStr = allMints[i];
          const info = stored.find(s => s.mint === mintStr);
          const acct = curveAccounts[i];
          if (!acct || acct.data.length < 210) continue;

          const virtualToken = Number(acct.data.readBigUInt64LE(168));
          const virtualSol = Number(acct.data.readBigUInt64LE(176));
          const realSol = Number(acct.data.readBigUInt64LE(184));
          const graduated = acct.data[210] === 1;

          if (virtualToken <= 0 || virtualSol <= 0) continue;

          const price = virtualSol / virtualToken;
          const mcSol = price * 1e9;
          const mc = mcSol * solUsd;

          results.push({
            mint: mintStr,
            name: info?.name || mintStr.slice(0, 6) + "...",
            symbol: info?.symbol || "???",
            image: info?.image || "",
            mc, mcSol, realSol, graduated,
          });
        }

        if (!cancelled) setTokens(results);
      } catch {}
      if (!cancelled) setLoading(false);
    }
    load();
    const interval = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [connection, solUsd]);

  // Auto-scroll to middle on load
  useEffect(() => {
    if (!loading && scrollRef.current) {
      scrollRef.current.scrollTop = WORLD_HEIGHT * 0.4;
    }
  }, [loading]);

  // Assign horizontal positions (deterministic from mint)
  function getX(mint: string): number {
    let hash = 0;
    for (let i = 0; i < mint.length; i++) hash = ((hash << 5) - hash + mint.charCodeAt(i)) | 0;
    return 10 + (Math.abs(hash) % 70); // 10-80% horizontal range
  }

  return (
    <div className="glass overflow-hidden rounded-xl" style={{ height: "75vh" }}>
      <div ref={scrollRef} className="relative overflow-y-auto overflow-x-hidden h-full" style={{ scrollBehavior: "smooth" }}>
        {/* World container */}
        <div className="relative w-full" style={{ height: WORLD_HEIGHT }}>

          {/* Environment layers (bottom to top) */}
          {/* Chaos - bottom */}
          <div className="absolute inset-x-0 bottom-0" style={{ height: "30%", background: "linear-gradient(to top, rgba(0,0,0,0.9) 0%, rgba(22,163,74,0.15) 30%, rgba(147,51,234,0.1) 70%, transparent 100%)" }} />
          <div className="absolute inset-x-0 bottom-0" style={{ height: "25%", background: "radial-gradient(ellipse at 50% 100%, rgba(239,68,68,0.2) 0%, rgba(234,88,12,0.1) 40%, transparent 70%)" }} />

          {/* Storm - lower middle */}
          <div className="absolute inset-x-0" style={{ top: "45%", height: "25%", background: "linear-gradient(to top, rgba(88,28,135,0.1) 0%, rgba(59,130,246,0.05) 50%, transparent 100%)" }} />

          {/* Clouds - upper middle */}
          <div className="absolute inset-x-0" style={{ top: "20%", height: "25%", background: "linear-gradient(to top, rgba(59,130,246,0.05) 0%, rgba(255,255,255,0.03) 50%, transparent 100%)" }} />

          {/* Heaven - top */}
          <div className="absolute inset-x-0 top-0" style={{ height: "20%", background: "linear-gradient(to bottom, rgba(234,179,8,0.15) 0%, rgba(255,255,255,0.05) 40%, transparent 100%)" }} />
          <div className="absolute inset-x-0 top-0" style={{ height: "8%", background: "radial-gradient(ellipse at 50% 0%, rgba(234,179,8,0.3) 0%, transparent 70%)" }} />

          {/* Zone labels */}
          {ZONES.map((z, i) => {
            const yPct = [85, 60, 35, 12][i];
            return (
              <div key={z.name} className="absolute left-3 pointer-events-none" style={{ top: `${100 - yPct}%` }}>
                <div className="flex items-center gap-2 opacity-30">
                  <div className="w-8 border-t border-white/20" />
                  <span className="font-pixel text-[7px] text-white/40 tracking-widest">{z.name}</span>
                  <span className="text-[9px] text-white/20">{z.label}</span>
                </div>
              </div>
            );
          })}

          {/* Floating particles */}
          {[...Array(20)].map((_, i) => {
            const x = (i * 37 + 13) % 100;
            const baseY = (i * 53 + 7) % 100;
            const speed = 0.2 + (i % 5) * 0.1;
            const size = 1 + (i % 3);
            const y = baseY + Math.sin(time * speed + i) * 2;
            const opacity = 0.05 + (i % 4) * 0.03;
            return (
              <div key={i} className="absolute rounded-full bg-white pointer-events-none"
                style={{ left: `${x}%`, top: `${y}%`, width: size, height: size, opacity }} />
            );
          })}

          {/* Token Islands */}
          {tokens.map((token, idx) => {
            const y = WORLD_HEIGHT - mcToY(token.mc);
            const x = getX(token.mint);
            const zone = getZone(token.mc);
            const floatOffset = Math.sin(time * 0.5 + idx * 1.7) * 8 + Math.sin(time * 0.3 + idx * 2.3) * 4;
            const isHeaven = zone === "HEAVEN";
            const isChaos = zone === "CHAOS";

            return (
              <div
                key={token.mint}
                className="absolute transition-all duration-1000"
                style={{
                  left: `${x}%`,
                  top: y + floatOffset,
                  transform: "translate(-50%, -50%)",
                  zIndex: isHeaven ? 20 : 10,
                }}
              >
                {/* Island platform */}
                <div className="relative group cursor-pointer">
                  {/* Glow */}
                  <div className="absolute -inset-4 rounded-full blur-xl opacity-60 pointer-events-none"
                    style={{ background: isHeaven ? "rgba(234,179,8,0.3)" : isChaos ? "rgba(239,68,68,0.2)" : "rgba(147,51,234,0.2)" }} />

                  {/* Island body */}
                  <div className="relative rounded-2xl border border-white/10 backdrop-blur-sm px-3 py-2 min-w-[100px]"
                    style={{
                      background: isHeaven ? "rgba(234,179,8,0.15)" : isChaos ? "rgba(20,10,10,0.8)" : "rgba(15,15,30,0.8)",
                      boxShadow: getZoneGlow(zone),
                    }}
                  >
                    <div className="flex items-center gap-2">
                      {/* Token image */}
                      <div className="w-8 h-8 rounded-full overflow-hidden flex-shrink-0 bg-white/10 flex items-center justify-center">
                        {token.image ? (
                          <img src={token.image} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <span className="font-pixel text-[7px] text-white/60">{token.symbol.slice(0, 2)}</span>
                        )}
                      </div>
                      <div>
                        <div className="text-[11px] font-bold text-white leading-tight">{token.name}</div>
                        <div className="text-[9px] text-white/50">${token.symbol}</div>
                      </div>
                    </div>

                    {/* MC */}
                    <div className="mt-1.5 flex items-center justify-between gap-3">
                      <span className={`font-pixel text-[8px] ${isHeaven ? "text-yellow-300" : isChaos ? "text-red-400" : "text-purple-300"}`}>
                        {formatUsd(token.mc, token.mc >= 1000 ? 0 : 2)}
                      </span>
                      {token.graduated && (
                        <span className="font-pixel text-[6px] bg-yellow-500/20 text-yellow-300 px-1 py-0.5 rounded">GRAD</span>
                      )}
                    </div>

                    {/* SOL raised bar */}
                    <div className="mt-1 h-1 bg-white/5 rounded-full overflow-hidden">
                      <div className="h-full rounded-full"
                        style={{
                          width: `${Math.min(100, (token.realSol / 1e9 / 85) * 100)}%`,
                          background: isHeaven ? "linear-gradient(90deg, #eab308, #fbbf24)" : isChaos ? "linear-gradient(90deg, #ef4444, #f97316)" : "linear-gradient(90deg, #8b5cf6, #6366f1)",
                        }}
                      />
                    </div>
                    <div className="text-[7px] text-white/30 mt-0.5">{(token.realSol / 1e9).toFixed(1)} SOL</div>
                  </div>

                  {/* Island base (floating rock) */}
                  <div className="mx-auto -mt-1 opacity-40" style={{
                    width: "80%", height: 8,
                    background: "radial-gradient(ellipse, rgba(100,100,100,0.5) 0%, transparent 70%)",
                    borderRadius: "50%",
                  }} />
                </div>
              </div>
            );
          })}

          {/* Empty state */}
          {!loading && tokens.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center space-y-3">
                <p className="font-pixel text-[10px] text-white/30">THE SKY IS EMPTY</p>
                <p className="text-[13px] text-white/20">Launch a token to place the first island</p>
              </div>
            </div>
          )}

          {loading && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center space-y-3">
                <div className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse mx-auto" />
                <p className="font-pixel text-[8px] text-yellow-400/60">BUILDING WORLD...</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Zone indicator (fixed overlay) */}
      <div className="absolute right-3 top-1/2 -translate-y-1/2 flex flex-col items-center gap-1 pointer-events-none">
        <div className="w-1 h-16 rounded-full bg-gradient-to-b from-yellow-400/30 via-blue-400/20 via-purple-500/20 to-red-500/30" />
        <span className="font-pixel text-[6px] text-white/20 mt-1">MC</span>
      </div>
    </div>
  );
}
