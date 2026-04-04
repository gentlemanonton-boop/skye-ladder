import { useLiveTrades, type LiveTrade } from "../hooks/useLiveTrades";

function timeAgo(ts: number): string {
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function formatCompact(raw: number, decimals: number): string {
  const human = raw / 10 ** decimals;
  if (human >= 1_000_000) return (human / 1_000_000).toFixed(1) + "M";
  if (human >= 1_000) return (human / 1_000).toFixed(1) + "K";
  return human.toFixed(1);
}

export function LiveFeed() {
  const trades = useLiveTrades();

  if (trades.length === 0) return null;

  return (
    <div className="glass p-3 sm:p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-2 h-2 rounded-full bg-skye-400 animate-pulse" />
        <span className="font-pixel text-[8px] sm:text-[9px] text-skye-400 tracking-wider">LIVE TRADES</span>
      </div>

      <div className="space-y-1.5 max-h-[280px] overflow-y-auto overscroll-contain">
        {trades.map((t, i) => (
          <a
            key={t.id}
            href={`https://solscan.io/tx/${t.signature}`}
            target="_blank"
            rel="noopener noreferrer"
            className={`flex items-center gap-2 sm:gap-3 px-2.5 sm:px-3 py-2 rounded-lg hover:bg-white/5 transition-all ${
              i === 0 ? "animate-slideIn" : ""
            }`}
          >
            {/* Buy/Sell indicator */}
            <div className={`font-pixel text-[7px] sm:text-[8px] w-8 text-center py-1 rounded ${
              t.type === "buy"
                ? "bg-skye-500/15 text-skye-400"
                : "bg-rose-500/15 text-rose-400"
            }`}>
              {t.type === "buy" ? "BUY" : "SELL"}
            </div>

            {/* Amount */}
            <div className="flex-1 min-w-0">
              <span className={`text-[12px] sm:text-[13px] font-semibold ${
                t.type === "buy" ? "text-skye-400" : "text-rose-400"
              }`}>
                {t.type === "buy" ? "+" : "-"}{formatCompact(t.skyeAmount, 9)} SKYE
              </span>
            </div>

            {/* SOL amount */}
            <span className="text-[11px] sm:text-[12px] text-ink-faint tabular-nums">
              {(t.solAmount / 1e9).toFixed(4)} SOL
            </span>

            {/* Time */}
            <span className="font-pixel text-[7px] text-ink-faint w-6 text-right">
              {timeAgo(t.timestamp)}
            </span>
          </a>
        ))}
      </div>

      {/* Pixel bottom bar */}
      <div className="mt-3 h-px" style={{
        background: "repeating-linear-gradient(90deg, rgba(34,197,94,0.2) 0px, rgba(34,197,94,0.2) 3px, transparent 3px, transparent 6px)",
      }} />
    </div>
  );
}
