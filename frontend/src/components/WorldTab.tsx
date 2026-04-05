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
  mc: number;
  mcSol: number;
  realSol: number;
  graduated: boolean;
}

const WORLD_HEIGHT = 3000;

function mcToY(mc: number): number {
  const minLog = Math.log10(500);
  const maxLog = Math.log10(500_000_000);
  const log = Math.log10(Math.max(mc, 500));
  const pct = Math.min(1, Math.max(0, (log - minLog) / (maxLog - minLog)));
  return pct * (WORLD_HEIGHT - 200) + 100;
}

function getZone(mc: number): "CHAOS" | "STORM" | "CLOUDS" | "HEAVEN" {
  if (mc >= 1_000_000) return "HEAVEN";
  if (mc >= 100_000) return "CLOUDS";
  if (mc >= 10_000) return "STORM";
  return "CHAOS";
}

export function WorldTab() {
  const { connection } = useConnection();
  const solUsd = useSolPrice();
  const [tokens, setTokens] = useState<WorldToken[]>([]);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [time, setTime] = useState(0);

  // Animation
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

  // Load tokens
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

  // Scroll to bottom (chaos) on load
  useEffect(() => {
    if (!loading && scrollRef.current) {
      scrollRef.current.scrollTop = WORLD_HEIGHT;
    }
  }, [loading]);

  function getX(mint: string): number {
    let hash = 0;
    for (let i = 0; i < mint.length; i++) hash = ((hash << 5) - hash + mint.charCodeAt(i)) | 0;
    return 12 + (Math.abs(hash) % 66);
  }

  return (
    <div className="overflow-hidden rounded-xl relative" style={{ height: "80vh" }}>
      <div ref={scrollRef} className="relative overflow-y-auto overflow-x-hidden h-full">
        <div className="relative w-full" style={{ height: WORLD_HEIGHT }}>

          {/* ═══ HEAVEN — top ═══ */}
          <div className="absolute inset-x-0 top-0" style={{
            height: "22%",
            background: "linear-gradient(to bottom, rgba(255,223,100,0.35) 0%, rgba(234,179,8,0.2) 30%, rgba(255,255,255,0.08) 60%, transparent 100%)",
          }} />
          <div className="absolute inset-x-0 top-0" style={{
            height: "10%",
            background: "radial-gradient(ellipse at 50% 0%, rgba(255,223,100,0.5) 0%, rgba(234,179,8,0.2) 40%, transparent 70%)",
          }} />
          {/* Halo ring */}
          <div className="absolute top-[3%] left-1/2 -translate-x-1/2 w-48 h-12 rounded-full pointer-events-none"
            style={{ border: "2px solid rgba(234,179,8,0.3)", boxShadow: "0 0 30px rgba(234,179,8,0.2), inset 0 0 30px rgba(234,179,8,0.1)" }} />

          {/* ═══ CLOUDS — upper middle ═══ */}
          <div className="absolute inset-x-0" style={{
            top: "22%", height: "28%",
            background: "linear-gradient(to bottom, rgba(100,180,255,0.12) 0%, rgba(59,130,246,0.08) 40%, rgba(147,130,220,0.06) 80%, transparent 100%)",
          }} />
          {/* Cloud wisps */}
          {[15, 25, 32, 38].map((y, i) => (
            <div key={`cloud${i}`} className="absolute pointer-events-none opacity-[0.06]" style={{
              top: `${y}%`, left: `${10 + i * 20}%`, width: "30%", height: "4%",
              background: "radial-gradient(ellipse, white 0%, transparent 70%)",
              borderRadius: "50%",
            }} />
          ))}

          {/* ═══ STORM — lower middle ═══ */}
          <div className="absolute inset-x-0" style={{
            top: "50%", height: "25%",
            background: "linear-gradient(to bottom, rgba(88,28,135,0.15) 0%, rgba(147,51,234,0.12) 40%, rgba(100,20,80,0.1) 70%, transparent 100%)",
          }} />
          {/* Lightning bolts */}
          {[0, 1, 2].map(i => {
            const visible = Math.sin(time * 0.4 + i * 2.5) > 0.92;
            return visible ? (
              <div key={`bolt${i}`} className="absolute pointer-events-none" style={{
                top: `${55 + i * 5}%`, left: `${20 + i * 25}%`,
                width: 2, height: 60,
                background: "linear-gradient(to bottom, rgba(168,85,247,0.8), rgba(168,85,247,0) )",
                transform: `rotate(${-10 + i * 15}deg)`,
                filter: "blur(1px)",
              }} />
            ) : null;
          })}

          {/* ═══ CHAOS — bottom ═══ */}
          <div className="absolute inset-x-0 bottom-0" style={{
            height: "30%",
            background: "linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(20,5,0,0.8) 20%, rgba(50,10,0,0.4) 50%, rgba(80,20,40,0.15) 80%, transparent 100%)",
          }} />
          {/* Green toxic fog */}
          <div className="absolute inset-x-0 bottom-0" style={{
            height: "20%",
            background: "radial-gradient(ellipse at 50% 100%, rgba(34,197,94,0.3) 0%, rgba(22,163,74,0.15) 40%, transparent 70%)",
          }} />
          {/* Fire glow */}
          <div className="absolute inset-x-0 bottom-0" style={{
            height: "15%",
            background: "radial-gradient(ellipse at 30% 100%, rgba(239,68,68,0.25) 0%, transparent 50%), radial-gradient(ellipse at 70% 100%, rgba(249,115,22,0.2) 0%, transparent 50%)",
          }} />
          {/* Ember particles */}
          {[...Array(12)].map((_, i) => {
            const x = (i * 31 + 17) % 90 + 5;
            const baseY = 82 + (i % 4) * 4;
            const drift = Math.sin(time * 0.8 + i * 1.3) * 3;
            const flicker = 0.3 + Math.sin(time * 3 + i * 2) * 0.3;
            return (
              <div key={`ember${i}`} className="absolute rounded-full pointer-events-none"
                style={{
                  left: `${x}%`, top: `${baseY + drift}%`,
                  width: 3 + (i % 3), height: 3 + (i % 3),
                  background: i % 3 === 0 ? "rgba(249,115,22,0.8)" : "rgba(239,68,68,0.6)",
                  opacity: flicker,
                  boxShadow: "0 0 6px rgba(249,115,22,0.5)",
                }} />
            );
          })}

          {/* ═══ Zone labels ═══ */}
          {[
            { name: "HEAVEN", y: 8, color: "text-yellow-400/60" },
            { name: "CLOUDS", y: 33, color: "text-blue-300/40" },
            { name: "STORM", y: 58, color: "text-purple-400/40" },
            { name: "CHAOS", y: 83, color: "text-red-400/40" },
          ].map(z => (
            <div key={z.name} className="absolute left-4 pointer-events-none" style={{ top: `${z.y}%` }}>
              <div className="flex items-center gap-2">
                <div className="w-12 border-t border-white/10" />
                <span className={`font-pixel text-[9px] tracking-[0.2em] ${z.color}`}>{z.name}</span>
              </div>
            </div>
          ))}

          {/* ═══ Ambient particles ═══ */}
          {[...Array(30)].map((_, i) => {
            const x = (i * 37 + 13) % 100;
            const baseY = (i * 47 + 11) % 95;
            const speed = 0.15 + (i % 7) * 0.05;
            const size = 1 + (i % 3);
            const y = baseY + Math.sin(time * speed + i) * 1.5;
            const opacity = 0.03 + (baseY < 30 ? 0.06 : baseY > 70 ? 0.02 : 0.04);
            const color = baseY < 20 ? "bg-yellow-300" : baseY > 75 ? "bg-orange-400" : baseY > 50 ? "bg-purple-400" : "bg-blue-300";
            return (
              <div key={`p${i}`} className={`absolute rounded-full ${color} pointer-events-none`}
                style={{ left: `${x}%`, top: `${y}%`, width: size, height: size, opacity }} />
            );
          })}

          {/* ═══ Token Islands ═══ */}
          {tokens.map((token, idx) => {
            const y = WORLD_HEIGHT - mcToY(token.mc);
            const x = getX(token.mint);
            const zone = getZone(token.mc);
            const floatY = Math.sin(time * 0.4 + idx * 1.7) * 10 + Math.sin(time * 0.25 + idx * 2.3) * 6;
            const floatX = Math.sin(time * 0.3 + idx * 3.1) * 3;

            const colors = {
              HEAVEN: { bg: "rgba(60,50,10,0.85)", border: "rgba(234,179,8,0.4)", glow: "0 0 30px rgba(234,179,8,0.4), 0 0 60px rgba(234,179,8,0.15)", mc: "text-yellow-300", bar: "linear-gradient(90deg, #eab308, #fbbf24)" },
              CLOUDS: { bg: "rgba(15,25,50,0.85)", border: "rgba(59,130,246,0.3)", glow: "0 0 25px rgba(59,130,246,0.3), 0 0 50px rgba(59,130,246,0.1)", mc: "text-blue-300", bar: "linear-gradient(90deg, #3b82f6, #60a5fa)" },
              STORM:  { bg: "rgba(25,10,40,0.85)", border: "rgba(147,51,234,0.3)", glow: "0 0 25px rgba(147,51,234,0.3), 0 0 50px rgba(147,51,234,0.1)", mc: "text-purple-300", bar: "linear-gradient(90deg, #8b5cf6, #a78bfa)" },
              CHAOS:  { bg: "rgba(30,8,8,0.9)", border: "rgba(239,68,68,0.3)", glow: "0 0 20px rgba(239,68,68,0.3), 0 0 40px rgba(239,68,68,0.1)", mc: "text-red-300", bar: "linear-gradient(90deg, #ef4444, #f97316)" },
            }[zone];

            return (
              <div key={token.mint} className="absolute" style={{
                left: `${x}%`, top: y + floatY,
                transform: `translate(-50%, -50%) translateX(${floatX}px)`,
                zIndex: zone === "HEAVEN" ? 20 : 10,
                transition: "top 2s ease-out",
              }}>
                <div className="relative group cursor-pointer">
                  {/* Outer glow */}
                  <div className="absolute -inset-6 rounded-full blur-2xl pointer-events-none" style={{
                    background: zone === "HEAVEN" ? "rgba(234,179,8,0.2)" : zone === "CHAOS" ? "rgba(239,68,68,0.15)" : zone === "STORM" ? "rgba(147,51,234,0.15)" : "rgba(59,130,246,0.12)",
                  }} />

                  {/* Island card */}
                  <div className="relative rounded-2xl border backdrop-blur-md px-4 py-3 min-w-[130px] max-w-[180px]" style={{
                    background: colors.bg,
                    borderColor: colors.border,
                    boxShadow: colors.glow,
                  }}>
                    {/* Header */}
                    <div className="flex items-center gap-2.5">
                      <div className="w-10 h-10 rounded-xl overflow-hidden flex-shrink-0 bg-white/10 flex items-center justify-center">
                        {token.image ? (
                          <img src={token.image} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <span className="font-pixel text-[8px] text-white/60">{token.symbol.slice(0, 2)}</span>
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="text-[12px] font-bold text-white leading-tight truncate">{token.name}</div>
                        <div className="text-[10px] text-white/40">${token.symbol}</div>
                      </div>
                    </div>

                    {/* MC */}
                    <div className="mt-2 flex items-center justify-between">
                      <span className={`font-pixel text-[10px] ${colors.mc}`}>
                        {formatUsd(token.mc, token.mc >= 1000 ? 0 : 2)}
                      </span>
                      {token.graduated && (
                        <span className="font-pixel text-[7px] bg-yellow-500/20 text-yellow-300 px-1.5 py-0.5 rounded">GRAD</span>
                      )}
                    </div>

                    {/* Progress bar */}
                    <div className="mt-1.5 h-1.5 bg-white/5 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{
                        width: `${Math.min(100, (token.realSol / 1e9 / 85) * 100)}%`,
                        background: colors.bar,
                      }} />
                    </div>
                    <div className="text-[8px] text-white/25 mt-0.5 tabular-nums">{(token.realSol / 1e9).toFixed(1)} / 85 SOL</div>
                  </div>

                  {/* Shadow under island */}
                  <div className="mx-auto -mt-1" style={{
                    width: "70%", height: 10,
                    background: "radial-gradient(ellipse, rgba(0,0,0,0.4) 0%, transparent 70%)",
                    borderRadius: "50%",
                  }} />
                </div>
              </div>
            );
          })}

          {/* Empty state */}
          {!loading && tokens.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center space-y-4">
                <div className="font-pixel text-[14px] text-white/20 tracking-wider">THE SKY IS EMPTY</div>
                <div className="text-[14px] text-white/15">Launch a token to place the first island</div>
              </div>
            </div>
          )}

          {loading && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center space-y-3">
                <div className="w-3 h-3 rounded-full bg-yellow-400 animate-pulse mx-auto" />
                <p className="font-pixel text-[10px] text-yellow-400/50 tracking-wider">BUILDING WORLD...</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right edge — vertical MC scale */}
      <div className="absolute right-3 top-4 bottom-4 flex flex-col items-center justify-between pointer-events-none">
        <span className="font-pixel text-[7px] text-yellow-400/40">$500M</span>
        <div className="flex-1 w-[2px] my-2 rounded-full bg-gradient-to-b from-yellow-400/20 via-blue-400/10 via-purple-500/10 to-red-500/20" />
        <span className="font-pixel text-[7px] text-red-400/40">$1K</span>
      </div>
    </div>
  );
}
