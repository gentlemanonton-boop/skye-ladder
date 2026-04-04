import { useEffect, useRef, useState, useMemo } from "react";
import { usePriceHistory, type PricePoint } from "../hooks/usePriceHistory";
import { useSolPrice } from "../hooks/useSolPrice";
import { formatUsd } from "../lib/format";

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
  const history = usePriceHistory();
  const solUsd = useSolPrice();
  const [tf, setTf] = useState<TF>("5m");
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
      const chart = lc.createChart(containerRef.current, {
        layout: { background: { type: lc.ColorType.Solid, color: "transparent" }, textColor: "#9ca3af", fontFamily: "'Press Start 2P', monospace", fontSize: 8 },
        grid: { vertLines: { color: "rgba(34,197,94,0.08)", style: lc.LineStyle.Dotted }, horzLines: { color: "rgba(34,197,94,0.08)", style: lc.LineStyle.Dotted } },
        rightPriceScale: { borderColor: "rgba(34,197,94,0.15)", scaleMargins: { top: 0.1, bottom: 0.1 } },
        timeScale: { borderColor: "rgba(34,197,94,0.15)", timeVisible: true, secondsVisible: false },
        handleScroll: { vertTouchDrag: false },
        crosshair: { vertLine: { color: "rgba(34,197,94,0.3)", labelBackgroundColor: "rgba(10,10,20,0.9)" }, horzLine: { color: "rgba(34,197,94,0.3)", labelBackgroundColor: "rgba(10,10,20,0.9)" } },
      });
      const series = chart.addSeries(lc.AreaSeries, {
        lineColor: "#22c55e", topColor: "rgba(34,197,94,0.15)", bottomColor: "rgba(34,197,94,0.01)",
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
    const c = up ? "#22c55e" : "#ef4444";
    seriesRef.current.applyOptions({ lineColor: c, topColor: up ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.1)", bottomColor: up ? "rgba(34,197,94,0.01)" : "rgba(239,68,68,0.01)" });
    seriesRef.current.setData(data.map((p: PricePoint) => ({ time: p.time as any, value: p.price })));
    chartRef.current?.timeScale().fitContent();
  }, [data, up]);

  return (
    <div className="space-y-0">
      {/* Stats */}
      <div className="glass rounded-b-none p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div>
            <span className="font-pixel text-[12px] sm:text-[14px] text-ink-primary">{price.toExponential(4)}</span>
            <span className="text-[11px] text-ink-faint ml-2">SOL</span>
            <span className="text-[11px] text-ink-faint ml-1">({formatUsd(price * solUsd, 6)})</span>
          </div>
          <span className={`font-pixel text-[10px] sm:text-[11px] ${up ? "text-skye-400" : "text-rose-400"}`}>
            {up ? "+" : ""}{chg.toFixed(2)}%
          </span>
          <div className="hidden sm:flex items-center gap-4 text-ink-faint ml-auto">
            <span className="font-pixel text-[8px]">H <span className="text-ink-tertiary">{hi.toExponential(3)}</span></span>
            <span className="font-pixel text-[8px]">L <span className="text-ink-tertiary">{lo.toExponential(3)}</span></span>
          </div>
        </div>

        {/* Timeframe toggles - pixel style */}
        <div className="flex gap-1.5 mt-3 overflow-x-auto">
          {(["30s", "1m", "5m", "30m", "1h", "12h"] as TF[]).map((t) => (
            <button key={t} onClick={() => setTf(t)}
              className={`px-2.5 sm:px-3 py-1.5 font-pixel text-[7px] sm:text-[8px] rounded-md transition-all min-h-[32px] whitespace-nowrap ${
                tf === t
                  ? "bg-skye-500/20 text-skye-400 border border-skye-500/30"
                  : "text-ink-faint hover:text-ink-tertiary border border-transparent hover:border-white/5"
              }`}>{t}</button>
          ))}
        </div>
      </div>

      {/* Chart area */}
      <div className="glass rounded-t-none border-t-0 overflow-hidden relative">
        <div ref={containerRef} className="w-full" style={{ height: "300px" }} />

        {history.length < 2 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center space-y-2">
              <p className="font-pixel text-[8px] text-skye-400 animate-pulse">LOADING PRICE DATA</p>
              <p className="text-[11px] text-ink-faint">Chart fills as trades happen</p>
            </div>
          </div>
        )}

        {/* Pixel corner decorations */}
        <div className="absolute top-2 left-2 w-3 h-3 border-l-2 border-t-2 border-skye-500/20 pointer-events-none" />
        <div className="absolute top-2 right-2 w-3 h-3 border-r-2 border-t-2 border-skye-500/20 pointer-events-none" />
        <div className="absolute bottom-2 left-2 w-3 h-3 border-l-2 border-b-2 border-skye-500/20 pointer-events-none" />
        <div className="absolute bottom-2 right-2 w-3 h-3 border-r-2 border-b-2 border-skye-500/20 pointer-events-none" />
      </div>
    </div>
  );
}
