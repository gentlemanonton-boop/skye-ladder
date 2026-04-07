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
            { icon: "💎", text: "Diamond hands get rewarded from fee vaults at 15x" },
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
        <div className="flex justify-center gap-6">
          <a href="https://github.com/gentlemanonton-boop/skye-ladder" target="_blank" rel="noopener noreferrer"
            className="text-[13px] text-skye-400 hover:underline font-semibold">GitHub</a>
          <a href="https://x.com/Skyefallgg" target="_blank" rel="noopener noreferrer"
            className="text-[13px] text-skye-400 hover:underline font-semibold">X</a>
          <a href="https://solscan.io/token/5GtUWP1x4LpKjAzGBZg9sy9TbTqjY2bvJfgfC7aUmAfF" target="_blank" rel="noopener noreferrer"
            className="text-[13px] text-skye-400 hover:underline font-semibold">Solscan</a>
        </div>
      </div>

      {/* Bottom pixel bar */}
      <div className="h-2 rounded-full overflow-hidden" style={{
        background: "repeating-linear-gradient(90deg, rgba(34,197,94,0.3) 0px, rgba(34,197,94,0.3) 4px, transparent 4px, transparent 8px)",
      }} />
    </div>
  );
}
