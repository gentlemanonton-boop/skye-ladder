import { useEffect, useRef, useState, useMemo } from "react";
import { createChart, ColorType, LineStyle, type IChartApi, type ISeriesApi, type LineData, type Time } from "lightweight-charts";
import { usePriceHistory, type PricePoint } from "../hooks/usePriceHistory";
import { useSolPrice } from "../hooks/useSolPrice";
import { formatUsd } from "../lib/format";

type Timeframe = "1m" | "5m" | "15m" | "1h";

const TF_SECONDS: Record<Timeframe, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
};

function bucketize(points: PricePoint[], tfSec: number): PricePoint[] {
  if (points.length === 0) return [];
  const buckets: PricePoint[] = [];
  let currentBucket = Math.floor(points[0].time / tfSec) * tfSec;
  let lastPrice = points[0].price;

  for (const p of points) {
    const bucket = Math.floor(p.time / tfSec) * tfSec;
    if (bucket !== currentBucket) {
      buckets.push({ time: currentBucket, price: lastPrice });
      currentBucket = bucket;
    }
    lastPrice = p.price;
  }
  buckets.push({ time: currentBucket, price: lastPrice });
  return buckets;
}

export function PriceChart() {
  const history = usePriceHistory();
  const solUsd = useSolPrice();
  const [tf, setTf] = useState<Timeframe>("5m");
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);

  const bucketed = useMemo(() => bucketize(history, TF_SECONDS[tf]), [history, tf]);

  // Current price stats
  const currentPrice = history.length > 0 ? history[history.length - 1].price : 0;
  const currentUsd = currentPrice * solUsd;

  // 24h stats
  const now = Date.now() / 1000;
  const h24Points = history.filter((p) => p.time > now - 86400);
  const openPrice = h24Points.length > 0 ? h24Points[0].price : currentPrice;
  const change24h = openPrice > 0 ? ((currentPrice - openPrice) / openPrice) * 100 : 0;
  const high24h = h24Points.length > 0 ? Math.max(...h24Points.map((p) => p.price)) : currentPrice;
  const low24h = h24Points.length > 0 ? Math.min(...h24Points.map((p) => p.price)) : currentPrice;
  const isUp = change24h >= 0;

  // Create chart once
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#0f1218" },
        textColor: "#6b7280",
        fontFamily: "Inter, -apple-system, sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#1f2937", style: LineStyle.Dotted },
        horzLines: { color: "#1f2937", style: LineStyle.Dotted },
      },
      crosshair: {
        vertLine: { color: "#374151", labelBackgroundColor: "#374151" },
        horzLine: { color: "#374151", labelBackgroundColor: "#374151" },
      },
      rightPriceScale: {
        borderColor: "#1f2937",
        scaleMargins: { top: 0.15, bottom: 0.1 },
      },
      timeScale: {
        borderColor: "#1f2937",
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: { vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: false },
    });

    const series = chart.addAreaSeries({
      lineColor: "#0ea5e9",
      topColor: "rgba(14, 165, 233, 0.25)",
      bottomColor: "rgba(14, 165, 233, 0.02)",
      lineWidth: 2,
      priceFormat: { type: "price", precision: 12, minMove: 0.000000000001 },
      crosshairMarkerBackgroundColor: "#0ea5e9",
      crosshairMarkerBorderColor: "#fff",
      crosshairMarkerBorderWidth: 2,
      crosshairMarkerRadius: 4,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect;
      chart.applyOptions({ width });
    });
    ro.observe(chartContainerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Update data
  useEffect(() => {
    if (!seriesRef.current || bucketed.length === 0) return;

    const color = isUp ? "#22c55e" : "#ef4444";
    seriesRef.current.applyOptions({
      lineColor: color,
      topColor: isUp ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.2)",
      bottomColor: isUp ? "rgba(34,197,94,0.02)" : "rgba(239,68,68,0.02)",
    });

    const lineData: LineData[] = bucketed.map((p) => ({
      time: p.time as Time,
      value: p.price,
    }));

    seriesRef.current.setData(lineData);
    chartRef.current?.timeScale().fitContent();
  }, [bucketed, isUp]);

  return (
    <div className="bg-[#0f1218] rounded-2xl border border-gray-800/60 overflow-hidden shadow-card">
      {/* Stats bar */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pt-3 pb-2">
        <div>
          <span className="text-[18px] sm:text-[20px] font-bold text-white tabular-nums">
            {currentPrice.toExponential(4)}
          </span>
          <span className="text-[12px] text-gray-500 ml-1.5">SOL</span>
          <span className="text-[12px] text-gray-500 ml-1">({formatUsd(currentUsd, 6)})</span>
        </div>
        <span className={`text-[13px] font-semibold tabular-nums ${isUp ? "text-green-400" : "text-red-400"}`}>
          {isUp ? "+" : ""}{change24h.toFixed(2)}%
        </span>
        <div className="hidden sm:flex items-center gap-3 text-[11px] text-gray-500 ml-auto">
          <span>H <span className="text-gray-400">{high24h.toExponential(3)}</span></span>
          <span>L <span className="text-gray-400">{low24h.toExponential(3)}</span></span>
        </div>
      </div>

      {/* Timeframe toggles */}
      <div className="flex gap-1 px-4 pb-2">
        {(["1m", "5m", "15m", "1h"] as Timeframe[]).map((t) => (
          <button
            key={t}
            onClick={() => setTf(t)}
            className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-all ${
              tf === t
                ? "bg-gray-700 text-white"
                : "text-gray-500 hover:text-gray-300 hover:bg-gray-800/50"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Chart */}
      <div
        ref={chartContainerRef}
        className="w-full"
        style={{ height: "260px" }}
      />

      {/* Empty state */}
      {history.length < 2 && (
        <div className="text-center text-[12px] text-gray-600 py-4 -mt-[260px] relative z-10">
          Collecting price data... Chart populates as trades happen.
        </div>
      )}
    </div>
  );
}
