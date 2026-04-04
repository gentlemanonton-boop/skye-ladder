import { useEffect, useRef, useState, useMemo } from "react";
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
        layout: { background: { type: lc.ColorType.Solid, color: "#0f1218" }, textColor: "#6b7280", fontFamily: "Inter, sans-serif", fontSize: 11 },
        grid: { vertLines: { color: "#1f2937", style: lc.LineStyle.Dotted }, horzLines: { color: "#1f2937", style: lc.LineStyle.Dotted } },
        rightPriceScale: { borderColor: "#1f2937", scaleMargins: { top: 0.1, bottom: 0.1 } },
        timeScale: { borderColor: "#1f2937", timeVisible: true, secondsVisible: false },
        handleScroll: { vertTouchDrag: false },
        crosshair: { vertLine: { color: "#374151", labelBackgroundColor: "#374151" }, horzLine: { color: "#374151", labelBackgroundColor: "#374151" } },
      });
      const series = chart.addSeries(lc.AreaSeries, {
        lineColor: "#0ea5e9", topColor: "rgba(14,165,233,0.2)", bottomColor: "rgba(14,165,233,0.01)",
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
    seriesRef.current.applyOptions({ lineColor: c, topColor: up ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.15)", bottomColor: up ? "rgba(34,197,94,0.01)" : "rgba(239,68,68,0.01)" });
    seriesRef.current.setData(data.map((p: PricePoint) => ({ time: p.time as any, value: p.price })));
    chartRef.current?.timeScale().fitContent();
  }, [data, up]);

  return (
    <div className="space-y-0">
      {/* Stats */}
      <div className="bg-[#0f1218] rounded-t-2xl px-4 pt-4 pb-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <div>
            <span className="text-[18px] sm:text-[20px] font-bold text-white tabular-nums">{price.toExponential(4)}</span>
            <span className="text-[12px] text-gray-500 ml-1.5">SOL</span>
            <span className="text-[12px] text-gray-500 ml-1">({formatUsd(price * solUsd, 6)})</span>
          </div>
          <span className={`text-[13px] font-semibold tabular-nums ${up ? "text-green-400" : "text-red-400"}`}>
            {up ? "+" : ""}{chg.toFixed(2)}%
          </span>
          <div className="hidden sm:flex items-center gap-3 text-[11px] text-gray-500 ml-auto">
            <span>H <span className="text-gray-400">{hi.toExponential(3)}</span></span>
            <span>L <span className="text-gray-400">{lo.toExponential(3)}</span></span>
          </div>
        </div>
        {/* TF */}
        <div className="flex gap-1 mt-2">
          {(["1m", "5m", "15m", "1h"] as TF[]).map((t) => (
            <button key={t} onClick={() => setTf(t)}
              className={`px-3 py-1.5 text-[11px] font-semibold rounded-md transition ${tf === t ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"}`}>{t}</button>
          ))}
        </div>
      </div>
      {/* Chart */}
      <div ref={containerRef} className="w-full bg-[#0f1218] rounded-b-2xl" style={{ height: "300px" }} />
      {history.length < 2 && (
        <div className="bg-[#0f1218] rounded-b-2xl -mt-[300px] flex items-center justify-center" style={{ height: "300px" }}>
          <p className="text-gray-600 text-[13px]">Collecting price data... Chart fills as trades happen.</p>
        </div>
      )}
    </div>
  );
}
