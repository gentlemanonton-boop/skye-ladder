import { useEffect, useRef, useState, useMemo } from "react";
import { PublicKey } from "@solana/web3.js";
import { usePriceHistory, type PricePoint } from "../hooks/usePriceHistory";
import { useSolPrice } from "../hooks/useSolPrice";
import { useDiscoveredTokens } from "../hooks/useDiscoveredTokens";
import { formatUsd } from "../lib/format";
import { SKYE_MINT } from "../constants";

type TF = "30s" | "1m" | "5m" | "30m" | "1h" | "12h";
const TF_SEC: Record<TF, number> = { "30s": 30, "1m": 60, "5m": 300, "30m": 1800, "1h": 3600, "12h": 43200 };

function bucket(pts: PricePoint[], sec: number): PricePoint[] {
  if (!pts.length) return [];
  const out: PricePoint[] = [];
  let cur = Math.floor(pts[0].time / sec) * sec;
  let last = pts[0].price;
  for (const p of pts) {
    const b = Math.floor(p.time / sec) * sec;
    if (b !== cur) { out.push({ time: cur, price: last }); cur = b; }
    last = p.price;
  }
  out.push({ time: cur, price: last });
  return out;
}

export function ChartTab() {
  const { tokens: allTokens } = useDiscoveredTokens();
  const [selectedMint, setSelectedMint] = useState<string>(SKYE_MINT.toBase58());
  const mintPk = useMemo(() => new PublicKey(selectedMint), [selectedMint]);
  const { history, loading } = usePriceHistory(mintPk);
  const solUsd = useSolPrice();
  const [tf, setTf] = useState<TF>("5m");

  const tokenList = useMemo(() => {
    const skye = { mint: SKYE_MINT.toBase58(), name: "Skye", symbol: "SKYE", image: "" };
    const others = allTokens
      .filter(t => t.mint !== SKYE_MINT.toBase58())
      .map(t => ({ mint: t.mint, name: t.name, symbol: t.symbol, image: t.image }));
    return [skye, ...others];
  }, [allTokens]);

  const selectedToken = tokenList.find(t => t.mint === selectedMint) ?? tokenList[0];
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const seriesRef = useRef<any>(null);
  const roRef = useRef<ResizeObserver | null>(null);

  const data = useMemo(() => bucket(history, TF_SEC[tf]), [history, tf]);
  const price = history.length > 0 ? history[history.length - 1].price : 0;
  const now = Date.now() / 1000;
  const h24 = history.filter((p) => p.time > now - 86400);
  const open = h24.length > 0 ? h24[0].price : price;
  const chg = open > 0 ? ((price - open) / open) * 100 : 0;
  const hi = h24.length > 0 ? Math.max(...h24.map((p) => p.price)) : price;
  const lo = h24.length > 0 ? Math.min(...h24.map((p) => p.price)) : price;
  const up = chg >= 0;

  useEffect(() => {
    if (!containerRef.current) return;
    let destroyed = false;
    import("lightweight-charts").then((lc) => {
      if (destroyed || !containerRef.current) return;
      const isMobile = window.innerWidth < 640;
      const chart = lc.createChart(containerRef.current, {
        autoSize: true,
        layout: { background: { type: lc.ColorType.Solid, color: "transparent" }, textColor: "#9ca3af", fontFamily: "monospace", fontSize: isMobile ? 9 : 10 },
        grid: { vertLines: { color: "rgba(255,255,255,0.02)", style: lc.LineStyle.Dotted }, horzLines: { color: "rgba(255,255,255,0.02)", style: lc.LineStyle.Dotted } },
        rightPriceScale: { borderColor: "rgba(16,185,129,0.15)", scaleMargins: { top: 0.1, bottom: 0.1 }, minimumWidth: isMobile ? 60 : 80 },
        timeScale: { borderColor: "rgba(16,185,129,0.15)", timeVisible: true, secondsVisible: false, rightOffset: 5, barSpacing: isMobile ? 4 : 6 },
        handleScroll: { vertTouchDrag: false, horzTouchDrag: true, mouseWheel: true, pressedMouseMove: true },
        handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
        crosshair: { vertLine: { color: "rgba(16,185,129,0.3)", labelBackgroundColor: "rgba(9,9,11,0.9)" }, horzLine: { color: "rgba(16,185,129,0.3)", labelBackgroundColor: "rgba(9,9,11,0.9)" } },
      });
      const series = chart.addSeries(lc.AreaSeries, {
        lineColor: "#10b981", topColor: "rgba(16,185,129,0.1)", bottomColor: "rgba(16,185,129,0.01)",
        lineWidth: 2, priceFormat: { type: "price", precision: 12, minMove: 0.000000000001 },
      });
      chartRef.current = chart;
      seriesRef.current = series;
      roRef.current = new ResizeObserver((e) => { if (!destroyed) chart.applyOptions({ width: e[0].contentRect.width }); });
      roRef.current.observe(containerRef.current);
    });
    return () => { destroyed = true; roRef.current?.disconnect(); chartRef.current?.remove(); chartRef.current = null; seriesRef.current = null; };
  }, []);

  useEffect(() => {
    if (!seriesRef.current || !data.length) return;
    const c = up ? "#10b981" : "#ef4444";
    seriesRef.current.applyOptions({ lineColor: c, topColor: up ? "rgba(16,185,129,0.1)" : "rgba(239,68,68,0.1)", bottomColor: up ? "rgba(16,185,129,0.01)" : "rgba(239,68,68,0.01)" });
    seriesRef.current.setData(data.map((p: PricePoint) => ({ time: p.time as any, value: p.price })));
    chartRef.current?.timeScale().fitContent();
  }, [data, up]);

  return (
    <div className="space-y-0">
      {/* Token selector */}
      <div className="flex items-center gap-2 mb-3 overflow-x-auto pb-1">
        {tokenList.map(t => (
          <button key={t.mint} onClick={() => setSelectedMint(t.mint)}
            className={`flex items-center gap-2 px-3 py-2 rounded-xl text-[12px] font-semibold whitespace-nowrap transition ${
              selectedMint === t.mint
                ? "bg-skye-500/20 text-skye-400 border border-skye-500/30"
                : "bg-surface-1 text-ink-faint border border-white/[0.06] hover:text-white hover:border-white/10"
            }`}>
            {t.image && <img src={t.image} alt="" className="w-5 h-5 rounded-full object-cover flex-shrink-0" />}
            <span>${t.symbol}</span>
          </button>
        ))}
      </div>

      {/* Stats */}
      <div className="bg-surface-1 border border-white/[0.06] rounded-b-none p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div>
            <span className="text-[18px] sm:text-[22px] font-semibold tracking-tight text-white">{price.toFixed(12).replace(/0+$/, "0")}</span>
            <span className="text-[11px] text-ink-faint ml-2">SOL</span>
            <span className="text-[11px] text-ink-faint ml-1">({formatUsd(price * solUsd, 6)})</span>
          </div>
          <span className={`text-[13px] font-medium ${up ? "text-skye-400" : "text-rose-400"}`}>
            {up ? "+" : ""}{chg.toFixed(2)}%
          </span>
          <div className="hidden sm:flex items-center gap-4 text-ink-faint ml-auto">
            <span className="font-pixel text-[11px]">H <span className="text-ink-faint">{hi.toFixed(10).replace(/0+$/, "0")}</span></span>
            <span className="font-pixel text-[11px]">L <span className="text-ink-faint">{lo.toFixed(10).replace(/0+$/, "0")}</span></span>
          </div>
        </div>

        {/* Timeframe toggles */}
        <div className="flex gap-1.5 mt-3 overflow-x-auto">
          {(["30s", "1m", "5m", "30m", "1h", "12h"] as TF[]).map((t) => (
            <button key={t} onClick={() => setTf(t)}
              className={`px-2.5 sm:px-3 py-1.5 font-pixel text-[7px] rounded-full transition-all duration-200 min-h-[32px] whitespace-nowrap ${
                tf === t
                  ? "bg-skye-500/[0.12] text-skye-400 border border-skye-500/20"
                  : "bg-surface-2 text-ink-faint hover:text-ink-secondary border border-white/[0.06]"
              }`}>{t}</button>
          ))}
        </div>
      </div>

      {/* Chart area */}
      <div className="rounded-b-2xl overflow-hidden bg-surface-0 border border-white/[0.06] border-t-0 relative">
        <div ref={containerRef} className="w-full h-[280px] sm:h-[320px]" style={{ touchAction: "pan-x pinch-zoom" }} />

        {history.length < 2 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center space-y-2">
              <p className="font-pixel text-[8px] text-skye-400 animate-pulse">
                {loading ? "LOADING CHART HISTORY" : "WAITING FOR FIRST TRADE"}
              </p>
              <p className="text-[11px] text-ink-faint">
                {loading ? "Reading recent trades from chain..." : "Chart fills as trades happen"}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
