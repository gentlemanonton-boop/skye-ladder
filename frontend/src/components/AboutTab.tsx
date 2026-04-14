const Icon = ({ d, color = "currentColor" }: { d: string; color?: string }) => (
  <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

const icons = {
  skull: "M12 2a8 8 0 00-8 8c0 3.5 2 6.5 5 7.5V20h6v-2.5c3-1 5-4 5-7.5a8 8 0 00-8-8zm-2 14v2m4-2v2m-5-7h.01M15 11h.01",
  refresh: "M4 4v5h5M20 20v-5h-5M4 9a8 8 0 0113.6-4.3M20 15a8 8 0 01-13.6 4.3",
  door: "M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3",
  trendDown: "M23 18l-9-9-5 5L1 6",
  lock: "M12 15v2m-6-6V7a6 6 0 1112 0v4M5 11h14a2 2 0 012 2v7a2 2 0 01-2 2H5a2 2 0 01-2-2v-7a2 2 0 012-2z",
  chart: "M3 3v18h18M7 16l4-4 4 4 5-5",
  swim: "M2 12h2a4 4 0 004-4V6m10 6h2a4 4 0 004-4V6M6 20a4 4 0 004-4v-4m4 8a4 4 0 004-4v-4",
  arrowUp: "M12 19V5m-7 7l7-7 7 7",
};

export function AboutTab() {
  return (
    <div className="space-y-8">
      {/* Problem + Fix side by side on desktop */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

      {/* The Problem */}
      <div className="glass p-6">
        <h3 className="font-pixel text-[8px] text-rose-400/80 uppercase tracking-[0.2em] mb-5">The Problem</h3>
        <div className="stagger-in space-y-3">
          {[
            { icon: icons.skull, color: "#f87171", text: "95% of Solana tokens die below $300K MC" },
            { icon: icons.refresh, color: "#fb923c", text: "Same pattern every time: snipe → accumulate → dump at 2-4x → chart dies" },
            { icon: icons.door, color: "#fbbf24", text: "Early flippers exit into buy volume, creating an artificial ceiling" },
            { icon: icons.trendDown, color: "#f87171", text: "New buyers see the dump, panic sell, project is dead" },
          ].map((item, i) => (
            <div key={i} className="frost rounded-2xl px-6 py-5 hover:-translate-y-1 hover:shadow-lg transition-all duration-300 group flex items-start gap-3">
              <div className="group-hover:scale-125 transition-transform duration-300">
                <Icon d={item.icon} color={item.color} />
              </div>
              <span className="text-[13px] sm:text-[14px] text-ink-secondary">{item.text}</span>
            </div>
          ))}
        </div>
      </div>

      {/* The Fix */}
      <div className="glass p-6">
        <h3 className="font-pixel text-[8px] text-skye-400/80 uppercase tracking-[0.2em] mb-5">The Fix</h3>
        <div className="stagger-in space-y-3">
          {[
            { icon: icons.lock, color: "#10b981", text: "Token-2022 Transfer Hook — sell restrictions enforced at the protocol level, not by trust" },
            { icon: icons.chart, color: "#34d399", text: "5 unlock phases from 1x to 15x — you earn your exit" },
            { icon: icons.swim, color: "#6ee7b7", text: "Underwater? Sell 100%. No one is EVER trapped" },
            { icon: icons.arrowUp, color: "#10b981", text: "Compressed growth between milestones — flippers can't game the ladder" },
          ].map((item, i) => (
            <div key={i} className="bg-skye-500/[0.03] border-l-2 border-skye-500/30 rounded-2xl px-6 py-5 hover:-translate-y-1 hover:shadow-lg transition-all duration-300 group flex items-start gap-3">
              <div className="group-hover:scale-125 transition-transform duration-300">
                <Icon d={item.icon} color={item.color} />
              </div>
              <span className="text-[13px] sm:text-[14px] text-ink-secondary">{item.text}</span>
            </div>
          ))}
        </div>
      </div>

      </div>{/* close grid */}

      {/* The Ladder */}
      <div className="glass p-6 overflow-hidden">
        <h3 className="font-pixel text-[8px] text-amber-400/80 uppercase tracking-[0.2em] mb-5">The Ladder</h3>
        <div className="scan-line relative space-y-3">
          {[
            { phase: "P1", range: "1x → 2x",  desc: "Get your money back",          pct: "~100% → ~50%",  stripeColor: "border-l-amber-500"   },
            { phase: "P2", range: "2x → 5x",  desc: "Compressed, cliff 62.5% at 5x",  pct: "50% → ~56.25%", stripeColor: "border-l-lime-500"    },
            { phase: "P3", range: "5x → 10x", desc: "Compressed, cliff 75% at 10x",   pct: "62.5% → ~68.75%", stripeColor: "border-l-emerald-500" },
            { phase: "P4", range: "10x → 15x",desc: "Compressed, cliff 100% at 15x",  pct: "75% → ~87.5%",  stripeColor: "border-l-cyan-500"    },
            { phase: "P5", range: "15x+",     desc: "Fully unlocked",                 pct: "100%",           stripeColor: "border-l-skye-500"    },
          ].map((p, i) => (
            <div key={i} className={`flex items-center gap-3 bg-surface-2 rounded-2xl px-5 py-4 border-l-[3px] border-y border-r border-white/[0.06] transition-all duration-200 ${p.stripeColor}`}>
              <span className="bg-white/[0.06] rounded-full px-2 py-0.5 font-pixel text-[8px] text-ink-faint flex-shrink-0">{p.phase}</span>
              <span className="font-pixel text-[8px] sm:text-[9px] text-gradient w-24 sm:w-28">{p.range}</span>
              <span className="text-[12px] sm:text-[13px] text-ink-tertiary flex-1">{p.desc}</span>
              <span className="font-pixel text-[9px] text-skye-400">{p.pct}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Social Links */}
      <div className="glass p-6 text-center dot-grid">
        <div className="flex justify-center items-center gap-3">
          <a href="https://github.com/gentlemanonton-boop/skye-ladder" target="_blank" rel="noopener noreferrer"
            aria-label="GitHub" title="GitHub"
            className="btn-glow p-2.5 rounded-xl bg-surface-2 hover:bg-surface-3 border border-white/[0.06] text-skye-400/80 hover:text-skye-400 transition-all duration-250 hover:-translate-y-1">
            <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
            </svg>
          </a>
          <a href="https://x.com/Skyefallgg" target="_blank" rel="noopener noreferrer"
            aria-label="X (Twitter)" title="X (Twitter)"
            className="btn-glow p-2.5 rounded-xl bg-surface-2 hover:bg-surface-3 border border-white/[0.06] text-skye-400/80 hover:text-skye-400 transition-all duration-250 hover:-translate-y-1">
            <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
            </svg>
          </a>
          <a href="https://t.me/skyefallgg" target="_blank" rel="noopener noreferrer"
            aria-label="Telegram" title="Telegram"
            className="btn-glow p-2.5 rounded-xl bg-surface-2 hover:bg-surface-3 border border-white/[0.06] text-skye-400/80 hover:text-skye-400 transition-all duration-250 hover:-translate-y-1">
            <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M11.944 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 01.171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
            </svg>
          </a>
          <a href="https://solscan.io/token/5GtUWP1x4LpKjAzGBZg9sy9TbTqjY2bvJfgfC7aUmAfF" target="_blank" rel="noopener noreferrer"
            aria-label="Solscan" title="View on Solscan"
            className="btn-glow p-2.5 rounded-xl bg-surface-2 hover:bg-surface-3 border border-white/[0.06] transition-all duration-250 hover:-translate-y-1">
            <img src="https://solscan.io/favicon.ico" alt="Solscan" className="w-8 h-8 rounded opacity-80 hover:opacity-100 transition-opacity" />
          </a>
        </div>
      </div>

      <div className="pixel-bar h-2 rounded-full overflow-hidden" />
    </div>
  );
}
