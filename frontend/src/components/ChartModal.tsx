import React, { useEffect, useRef, useState, useMemo } from "react";
import { usePriceHistory, type PricePoint } from "../hooks/usePriceHistory";
import { useSolPrice } from "../hooks/useSolPrice";
import { formatUsd } from "../lib/format";

type TF = "1m" | "5m" | "15m" | "1h";
const TF_SEC: Record<TF, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600 };

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

// The actual chart — isolated in its own error boundary
function ChartInner({ onClose }: { onClose: () => void }) {
  const history = usePriceHistory();
  const solUsd = useSolPrice();
  const [tf, setTf] = useState<TF>("5m");
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const seriesRef = useRef<any>(null);

  const data = useMemo(() => bucket(history, TF_SEC[tf]), [history, tf]);
  const price = history.length > 0 ? history[history.length - 1].price : 0;
  const now = Date.now() / 1000;
  const h24 = history.filter((p) => p.time > now - 86400);
  const open = h24.length > 0 ? h24[0].price : price;
  const chg = open > 0 ? ((price - open) / open) * 100 : 0;
  const hi = h24.length > 0 ? Math.max(...h24.map((p) => p.price)) : price;
  const lo = h24.length > 0 ? Math.min(...h24.map((p) => p.price)) : price;
  const up = chg >= 0;

  // Create chart — dynamic import to avoid SSR / global scope issues
  useEffect(() => {
    if (!containerRef.current) return;
    let destroyed = false;

    import("lightweight-charts").then((lc) => {
      if (destroyed || !containerRef.current) return;

      const chart = lc.createChart(containerRef.current, {
        layout: {
          background: { type: lc.ColorType.Solid, color: "#0f1218" },
          textColor: "#6b7280",
          fontFamily: "Inter, sans-serif",
          fontSize: 11,
        },
        grid: {
          vertLines: { color: "#1f2937", style: lc.LineStyle.Dotted },
          horzLines: { color: "#1f2937", style: lc.LineStyle.Dotted },
        },
        rightPriceScale: { borderColor: "#1f2937", scaleMargins: { top: 0.1, bottom: 0.1 } },
        timeScale: { borderColor: "#1f2937", timeVisible: true, secondsVisible: false },
        handleScroll: { vertTouchDrag: false },
        crosshair: {
          vertLine: { color: "#374151", labelBackgroundColor: "#374151" },
          horzLine: { color: "#374151", labelBackgroundColor: "#374151" },
        },
      });

      const series = chart.addSeries(lc.AreaSeries, {
        lineColor: "#0ea5e9",
        topColor: "rgba(14,165,233,0.2)",
        bottomColor: "rgba(14,165,233,0.01)",
        lineWidth: 2,
        priceFormat: { type: "price", precision: 12, minMove: 0.000000000001 },
      });

      chartRef.current = chart;
      seriesRef.current = series;

      const ro = new ResizeObserver((e) => chart.applyOptions({ width: e[0].contentRect.width }));
      ro.observe(containerRef.current);

      return () => { ro.disconnect(); };
    });

    return () => { destroyed = true; chartRef.current?.remove(); chartRef.current = null; seriesRef.current = null; };
  }, []);

  // Update data
  useEffect(() => {
    if (!seriesRef.current || !data.length) return;
    const c = up ? "#22c55e" : "#ef4444";
    seriesRef.current.applyOptions({
      lineColor: c,
      topColor: up ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.15)",
      bottomColor: up ? "rgba(34,197,94,0.01)" : "rgba(239,68,68,0.01)",
    });
    seriesRef.current.setData(data.map((p: PricePoint) => ({ time: p.time as any, value: p.price })));
    chartRef.current?.timeScale().fitContent();
  }, [data, up]);

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="absolute bottom-0 left-0 right-0 bg-[#0f1218] rounded-t-[20px] shadow-elevated flex flex-col animate-sheet"
        style={{ height: "75vh", maxHeight: "75vh" }}>
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-gray-600" />
        </div>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2">
          <div>
            <span className="text-[18px] font-bold text-white tabular-nums">{price.toExponential(4)}</span>
            <span className="text-[12px] text-gray-500 ml-1.5">SOL</span>
            <span className="text-[12px] text-gray-500 ml-1">({formatUsd(price * solUsd, 6)})</span>
            <span className={`text-[13px] font-semibold ml-3 ${up ? "text-green-400" : "text-red-400"}`}>
              {up ? "+" : ""}{chg.toFixed(2)}%
            </span>
          </div>
          <button onClick={onClose} className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-800 transition">
            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {/* Stats */}
        <div className="flex items-center gap-4 px-4 pb-2 text-[11px] text-gray-500">
          <span>H <span className="text-gray-400">{hi.toExponential(3)}</span></span>
          <span>L <span className="text-gray-400">{lo.toExponential(3)}</span></span>
        </div>
        {/* TF toggles */}
        <div className="flex gap-1 px-4 pb-2">
          {(["1m", "5m", "15m", "1h"] as TF[]).map((t) => (
            <button key={t} onClick={() => setTf(t)}
              className={`px-3 py-1.5 text-[11px] font-semibold rounded-md transition ${
                tf === t ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"
              }`}>{t}</button>
          ))}
        </div>
        {/* Chart area */}
        <div ref={containerRef} className="flex-1 w-full min-h-0" />
        {history.length < 2 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <p className="text-gray-600 text-[13px]">Collecting price data... Chart fills as trades happen.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// Error boundary wrapper
class ChartBoundary extends React.Component<{ children: React.ReactNode }, { err: boolean }> {
  state = { err: false };
  static getDerivedStateFromError() { return { err: true }; }
  render() { return this.state.err ? null : this.props.children; }
}

// Exported button + modal
export function ChartButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} title="Price Chart"
        className="w-9 h-9 flex items-center justify-center rounded-xl bg-gray-100 hover:bg-gray-200 transition-colors">
        <svg className="w-4 h-4 text-ink-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4v16" />
        </svg>
      </button>
      {open && (
        <ChartBoundary>
          <ChartInner onClose={() => setOpen(false)} />
        </ChartBoundary>
      )}
    </>
  );
}
