export function AboutTab() {
  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="glass p-6 sm:p-8 text-center space-y-4">
        <h2 className="font-pixel text-[14px] sm:text-[16px] text-skye-400 leading-relaxed tracking-wide">
          WHY SKYE EXISTS
        </h2>
        <p className="text-[15px] sm:text-[17px] text-ink-primary font-semibold leading-relaxed max-w-md mx-auto">
          Every token on Solana dies the same way. Flippers accumulate at low MC, dump at 2-4x, and kill the chart before it ever gets a chance.
        </p>
        <p className="text-[13px] text-ink-tertiary max-w-sm mx-auto">
          Skye fixes this with math, not promises.
        </p>
      </div>

      {/* The Problem */}
      <div className="glass p-6">
        <h3 className="font-pixel text-[10px] sm:text-[11px] text-rose-400 mb-4 tracking-wider">THE PROBLEM</h3>
        <div className="space-y-3">
          {[
            { icon: "💀", text: "95% of Solana tokens die below $300K MC" },
            { icon: "🔄", text: "Same pattern every time: snipe → accumulate → dump at 2-4x → chart dies" },
            { icon: "🚪", text: "Early flippers exit into buy volume, creating an artificial ceiling" },
            { icon: "📉", text: "New buyers see the dump, panic sell, project is dead" },
          ].map((item, i) => (
            <div key={i} className="flex items-start gap-3 bg-white/3 rounded-xl px-4 py-3 border border-white/5">
              <span className="text-[18px] flex-shrink-0">{item.icon}</span>
              <span className="text-[13px] sm:text-[14px] text-ink-secondary">{item.text}</span>
            </div>
          ))}
        </div>
      </div>

      {/* The Solution */}
      <div className="glass p-6">
        <h3 className="font-pixel text-[10px] sm:text-[11px] text-skye-400 mb-4 tracking-wider">THE FIX</h3>
        <div className="space-y-3">
          {[
            { icon: "🔒", text: "Token-2022 Transfer Hook — sell restrictions enforced at the protocol level, not by trust" },
            { icon: "📊", text: "5 unlock phases from 1x to 15x — you earn your exit" },
            { icon: "🏊", text: "Underwater? Sell 100%. No one is EVER trapped" },
            { icon: "⬆️", text: "Compressed growth between milestones — flippers can't game the ladder" },
          ].map((item, i) => (
            <div key={i} className="flex items-start gap-3 bg-skye-500/5 rounded-xl px-4 py-3 border border-skye-500/10">
              <span className="text-[18px] flex-shrink-0">{item.icon}</span>
              <span className="text-[13px] sm:text-[14px] text-ink-secondary">{item.text}</span>
            </div>
          ))}
        </div>
      </div>

      {/* How it works - pixel style */}
      <div className="glass p-6 overflow-hidden relative">
        <h3 className="font-pixel text-[10px] sm:text-[11px] text-amber-400 mb-5 tracking-wider">THE LADDER</h3>
        <div className="space-y-2">
          {[
            { phase: "P1", range: "1x → 2x", desc: "Get your money back", pct: "~100% → ~50%", color: "from-amber-500/20 to-amber-500/5" },
            { phase: "P2", range: "2x → 5x", desc: "Compressed, cliff 62.5% at 5x", pct: "50% → ~56.25%", color: "from-lime-500/20 to-lime-500/5" },
            { phase: "P3", range: "5x → 10x", desc: "Compressed, cliff 75% at 10x", pct: "62.5% → ~68.75%", color: "from-emerald-500/20 to-emerald-500/5" },
            { phase: "P4", range: "10x → 15x", desc: "Compressed, cliff 100% at 15x", pct: "75% → ~87.5%", color: "from-cyan-500/20 to-cyan-500/5" },
            { phase: "P5", range: "15x+", desc: "FULLY UNLOCKED", pct: "100%", color: "from-skye-500/20 to-skye-500/5" },
          ].map((p, i) => (
            <div key={i} className={`flex items-center gap-3 rounded-xl px-4 py-3 bg-gradient-to-r ${p.color} border border-white/5`}>
              <span className="font-pixel text-[9px] text-ink-faint w-8">{p.phase}</span>
              <span className="font-pixel text-[8px] sm:text-[9px] text-ink-secondary w-24 sm:w-28">{p.range}</span>
              <span className="text-[12px] sm:text-[13px] text-ink-tertiary flex-1">{p.desc}</span>
              <span className="font-pixel text-[8px] text-skye-400">{p.pct}</span>
            </div>
          ))}
        </div>
        {/* Pixel decoration */}
        <div className="absolute -right-2 -bottom-2 w-16 h-16 opacity-10" style={{
          background: "repeating-conic-gradient(rgba(34,197,94,0.5) 0% 25%, transparent 0% 50%) 0 0 / 8px 8px",
        }} />
      </div>

      {/* Links */}
      <div className="glass p-6 text-center">
        <div className="flex justify-center items-center gap-5">
          <a href="https://github.com/gentlemanonton-boop/skye-ladder" target="_blank" rel="noopener noreferrer"
            aria-label="GitHub" title="GitHub"
            className="text-skye-400/80 hover:text-skye-400 transition-colors">
            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
            </svg>
          </a>
          <a href="https://x.com/Skyefallgg" target="_blank" rel="noopener noreferrer"
            aria-label="X (Twitter)" title="X (Twitter)"
            className="text-skye-400/80 hover:text-skye-400 transition-colors">
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
            </svg>
          </a>
          <a href="https://t.me/skyefallgg" target="_blank" rel="noopener noreferrer"
            aria-label="Telegram" title="Telegram"
            className="text-skye-400/80 hover:text-skye-400 transition-colors">
            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M11.944 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 01.171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
            </svg>
          </a>
          <a href="https://solscan.io/token/5GtUWP1x4LpKjAzGBZg9sy9TbTqjY2bvJfgfC7aUmAfF" target="_blank" rel="noopener noreferrer"
            aria-label="Solscan" title="View on Solscan">
            <img src="https://solscan.io/favicon.ico" alt="Solscan" className="w-6 h-6 rounded opacity-80 hover:opacity-100 transition-opacity" />
          </a>
        </div>
      </div>

      {/* Bottom pixel bar */}
      <div className="h-2 rounded-full overflow-hidden" style={{
        background: "repeating-linear-gradient(90deg, rgba(34,197,94,0.3) 0px, rgba(34,197,94,0.3) 4px, transparent 4px, transparent 8px)",
      }} />
    </div>
  );
}
