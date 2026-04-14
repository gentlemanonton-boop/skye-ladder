import { useState } from "react";
import { enrichPosition, type Position } from "../lib/unlock";

interface Props { positions: Position[]; currentPrice: number; }

const TIERS = [
  { phase: 1, title: "Get Your Money Back", range: "1x \u2013 2x",
    unlock: "~100% at entry \u2192 50% at 2x", growth: "Natural taper as price rises",
    example: "Buy at $100 \u2192 at 1.5x ($150), sell $100 worth (66.7% of tokens)",
    accentActive: "bg-sky-500/[0.04] border-sky-500/20", dot: "bg-sky-400", dotGlow: "shadow-[0_0_6px_theme(colors.sky.400)]", badge: "bg-gradient-to-r from-skye-500 to-emerald-500", ring: "ring-sky-500/15",
    hoverGrad: "before:from-sky-500/[0.03]" },
  { phase: 2, title: "Compressed Growth", range: "2x \u2013 5x",
    unlock: "50% at 2x \u2192 ~56.25% at 4.99x", growth: "Half rate between milestones, cliff jump to 62.5% at 5x",
    example: "At 3.5x: 53.1% unlocked. At 4.99x: ~56.25%. NOT 62.5% until exactly 5x",
    accentActive: "bg-cyan-500/[0.04] border-cyan-500/20", dot: "bg-cyan-400", dotGlow: "shadow-[0_0_6px_theme(colors.cyan.400)]", badge: "bg-gradient-to-r from-skye-500 to-emerald-500", ring: "ring-cyan-500/15",
    hoverGrad: "before:from-cyan-500/[0.03]" },
  { phase: 3, title: "Compressed Growth", range: "5x \u2013 10x",
    unlock: "62.5% at 5x \u2192 ~68.75% at 9.99x", growth: "Half rate between milestones, cliff jump to 75% at 10x",
    example: "At 7.5x: 65.6% unlocked. At 9.99x: ~68.75%. NOT 75% until exactly 10x",
    accentActive: "bg-blue-500/[0.04] border-blue-500/20", dot: "bg-blue-400", dotGlow: "shadow-[0_0_6px_theme(colors.blue.400)]", badge: "bg-gradient-to-r from-skye-500 to-emerald-500", ring: "ring-blue-500/15",
    hoverGrad: "before:from-blue-500/[0.03]" },
  { phase: 4, title: "Final Stretch", range: "10x \u2013 15x",
    unlock: "75% at 10x \u2192 ~87.5% at 14.99x", growth: "Half rate between milestones, cliff jump to 100% at 15x",
    example: "At 12.5x: 81.25% unlocked. At 14.99x: 87.5%. NOT 100% until exactly 15x",
    accentActive: "bg-indigo-500/[0.04] border-indigo-500/20", dot: "bg-indigo-400", dotGlow: "shadow-[0_0_6px_theme(colors.indigo.400)]", badge: "bg-gradient-to-r from-skye-500 to-emerald-500", ring: "ring-indigo-500/15",
    hoverGrad: "before:from-indigo-500/[0.03]" },
  { phase: 5, title: "Fully Unlocked", range: "15x+",
    unlock: "100% unlocked \u2014 cliff jump at 15x", growth: "No restrictions. All sell limits removed",
    example: "The 15x milestone unlocks everything. Sell any amount at any time.",
    accentActive: "bg-emerald-500/[0.04] border-emerald-500/20", dot: "bg-emerald-400", dotGlow: "shadow-[0_0_6px_theme(colors.emerald.400)]", badge: "bg-gradient-to-r from-skye-500 to-emerald-500", ring: "ring-emerald-500/15",
    hoverGrad: "before:from-emerald-500/[0.03]" },
];

function getActive(mult: number): number {
  if (mult <= 1) return 0;
  if (mult < 2) return 1;
  if (mult < 5) return 2;
  if (mult < 10) return 3;
  if (mult < 15) return 4;
  return 5;
}

export function TierBreakdown({ positions, currentPrice }: Props) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const enriched = positions.map((p) => enrichPosition(p, currentPrice));
  const primary = enriched.length > 0
    ? enriched.reduce((b, p) => (p.tokenBalance > b.tokenBalance ? p : b), enriched[0])
    : null;
  const activePhase = primary ? getActive(primary.multiplier) : 0;

  return (
    <div className="glass overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full p-4 sm:p-5 flex items-center justify-between"
      >
        <div className="flex flex-col items-start gap-0.5">
          <h2 className="text-[16px] font-bold text-white tracking-tighter">The Skye Ladder</h2>
          <span className="font-pixel text-[7px] text-ink-ghost">5 PHASES</span>
        </div>
        <svg className={`w-4 h-4 text-ink-faint transition-all duration-250 ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      <div className={`transition-all duration-250 ease-out overflow-hidden ${open ? "max-h-[800px]" : "max-h-0"}`}>
        <div className="px-4 sm:px-5 pb-4 sm:pb-5 space-y-3">
          {TIERS.map((tier) => {
            const isActive = tier.phase === activePhase;
            const isPast = activePhase > tier.phase;
            const isOpen = expanded === tier.phase;

            return (
              <div
                key={tier.phase}
                onClick={() => setExpanded(isOpen ? null : tier.phase)}
                className={`relative overflow-hidden bg-surface-0 rounded-2xl border px-5 py-4 cursor-pointer transition-all duration-250
                  before:absolute before:inset-0 before:bg-gradient-to-r ${tier.hoverGrad} before:to-transparent before:opacity-0 hover:before:opacity-100 before:transition-opacity before:pointer-events-none
                  ${isActive ? `${tier.accentActive} ring-1 ${tier.ring} shadow-sm ${isActive ? "breathe" : ""}` : isPast ? "border-white/[0.06]" : "border-white/[0.06] hover:border-white/[0.10]"}
                `}
              >
                <div className="flex items-center gap-2.5 relative z-10">
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isActive || isPast ? tier.dot : "bg-white/10"} ${isActive ? `animate-pulse ${tier.dotGlow}` : ""}`} />
                  <span className={`text-[13px] font-bold ${isActive ? "text-white" : isPast ? "text-ink-secondary" : "text-ink-faint"}`}>
                    Phase {tier.phase}
                  </span>
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-md ${isActive ? "bg-white/10 text-white" : isPast ? "text-ink-tertiary" : "text-ink-faint"}`}>
                    {tier.range}
                  </span>
                  {isActive && (
                    <span className={`ml-auto text-[9px] font-bold text-white rounded-full px-2.5 py-0.5 shadow-glow-sm ${tier.badge} opacity-90`}>CURRENT</span>
                  )}
                  <svg className={`w-3.5 h-3.5 ml-auto text-ink-faint transition-all duration-250 ${isOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>

                <div className={`overflow-hidden transition-all duration-250 ${isOpen ? "max-h-40 mt-2.5 opacity-100" : "max-h-0 opacity-0"}`}>
                  <div className={`ml-[18px] text-[12px] space-y-1 relative z-10 ${isActive ? "text-white/80" : "text-ink-tertiary"}`}>
                    <p className="font-semibold">{tier.title}</p>
                    <p>{tier.unlock}</p>
                    <p className="opacity-70">{tier.growth}</p>
                    <p className="mt-1.5 text-[11px] dot-grid bg-surface-0 rounded-xl px-4 py-3 border border-white/[0.06] italic">{tier.example}</p>
                  </div>
                </div>
              </div>
            );
          })}

          <p className="text-[13px] text-ink-faint text-center pt-4">
            At or below entry price = always 100% sellable. <span className="text-gradient font-semibold">No one is ever trapped.</span>
          </p>
        </div>
      </div>
    </div>
  );
}
