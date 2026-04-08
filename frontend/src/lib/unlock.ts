/**
 * Client-side unlock % calculator — mirrors on-chain logic.
 * Display-only; the on-chain hook uses fixed-point and is the source of truth.
 */

export interface Position {
  entryPrice: number;
  initialSol: number; // SOL value at time of buy (tokens * price / PRICE_SCALE)
  tokenBalance: number;
  unlockedBps: number;
  originalBalance: number;
}

export interface PositionDisplay extends Position {
  multiplier: number;
  phase: string;
  calculatedBps: number;
  effectiveBps: number;
  sellableTokens: number;
}

const PRICE_SCALE = 1e18;

export function getPhase(mult: number): string {
  if (mult <= 1.0) return "Underwater";
  if (mult < 2.0) return "Phase 1 (1x-2x)";
  if (mult < 5.0) return "Phase 2 (2x-5x)";
  if (mult < 10.0) return "Phase 3 (5x-10x)";
  if (mult < 15.0) return "Phase 4 (10x-15x)";
  return "Phase 5 (15x+)";
}

export function calculateUnlockedBps(currentPrice: number, position: Position): number {
  const original = position.originalBalance >= position.tokenBalance
    ? position.originalBalance : position.tokenBalance;
  if (position.entryPrice === 0 || original === 0) return 10000;

  const mult = (currentPrice * PRICE_SCALE) / position.entryPrice;
  if (mult <= 1.0) return 10000;

  if (mult < 2.0) {
    // Phase 1: bps = initial_sol * PRICE_SCALE * 10000 / (original * currentPrice * PRICE_SCALE)
    // Simplifies to: initial_sol * 10000 / (original * currentPrice)
    // But currentPrice is raw ratio, and initial_sol = tokens*entry/PRICE_SCALE
    // So: bps = initial_sol * PRICE_SCALE * 10000 / (original * currentPrice * PRICE_SCALE)
    //        = initial_sol * 10000 / (original * currentPrice)
    // Wait — on-chain: numerator = initial_sol * PRICE_SCALE * BPS_DENOM
    //                   denominator = token_balance * current_price_scaled
    // where current_price_scaled = currentPrice * PRICE_SCALE (via pool read)
    // Frontend currentPrice is raw ratio, on-chain price is raw_ratio * PRICE_SCALE
    // So: bps = initial_sol * PRICE_SCALE * 10000 / (original * currentPrice * PRICE_SCALE)
    //        = initial_sol * 10000 / (original * currentPrice)
    const bps = (position.initialSol * 10000) / (original * currentPrice);
    return Math.min(Math.floor(bps), 10000);
  }

  if (mult >= 15.0) return 10000;

  // 5x and 10x milestone snap — matches on-chain epsilon (±0.5%) in
  // `programs/skye-ladder/src/math.rs` (EPSILON = 50 in mult-scaled units of 10000).
  // Without these, the frontend underestimates the unlock by ~6 percentage
  // points in the narrow windows just below each cliff, even though the
  // on-chain hook would actually grant the full milestone bps.
  if (mult >= 9.995 && mult < 10.005) return 7500;
  if (mult >= 4.995 && mult < 5.005) return 6250;

  if (mult < 5.0) { const t = (mult - 2) / 3; return Math.floor(5000 + t * 1250 * 0.5); }
  if (mult < 10.0) { const t = (mult - 5) / 5; return Math.floor(6250 + t * 1250 * 0.5); }
  const t = (mult - 10) / 5;
  return Math.floor(7500 + t * 2500 * 0.5);
}

export function computeSellableTokens(pos: Position, effectiveBps: number): number {
  const original = pos.originalBalance >= pos.tokenBalance ? pos.originalBalance : pos.tokenBalance;
  const maxSellable = Math.floor((original * effectiveBps) / 10000);
  const alreadySold = original - pos.tokenBalance;
  return Math.min(Math.max(0, maxSellable - alreadySold), pos.tokenBalance);
}

/**
 * Sanitize corrupt positions (mirrors on-chain sanitize_corrupt_entry_prices).
 * Corrupt positions get entry_price reset to current price → underwater → 100% sellable.
 * This matches what the on-chain hook does when you actually sell.
 */
function sanitizePosition(pos: Position, currentPrice: number): Position {
  if (pos.entryPrice === 0 || pos.tokenBalance === 0 || currentPrice === 0) return pos;
  const currentPriceScaled = currentPrice * PRICE_SCALE;
  if (pos.entryPrice > currentPriceScaled * 1000) {
    return {
      ...pos,
      entryPrice: currentPriceScaled,
      initialSol: pos.originalBalance * currentPrice,
      unlockedBps: 0,
    };
  }
  return pos;
}

export function enrichPosition(pos: Position, currentPrice: number): PositionDisplay {
  const clean = sanitizePosition(pos, currentPrice);
  const mult = clean.entryPrice > 0 ? (currentPrice * PRICE_SCALE) / clean.entryPrice : 0;
  const calculatedBps = calculateUnlockedBps(currentPrice, clean);
  const effectiveBps = Math.max(calculatedBps, clean.unlockedBps);
  const sellableTokens = computeSellableTokens(clean, effectiveBps);
  return { ...clean, multiplier: mult, phase: getPhase(mult), calculatedBps, effectiveBps, sellableTokens };
}

export function getTotalSellable(positions: Position[], currentPrice: number): number {
  return positions.reduce((s, p) => s + enrichPosition(p, currentPrice).sellableTokens, 0);
}

export function getInitialBackTokens(positions: Position[], currentPrice: number): { tokensRaw: number; solValue: number } {
  if (currentPrice === 0) return { tokensRaw: 0, solValue: 0 };
  const scaledPrice = currentPrice * PRICE_SCALE;
  let totalTokens = 0;
  let totalSol = 0;
  for (const rawPos of positions) {
    const pos = sanitizePosition(rawPos, currentPrice);
    if (pos.entryPrice === 0 || pos.tokenBalance === 0) continue;
    const mult = scaledPrice / pos.entryPrice;
    if (mult <= 1.0) continue;
    const original = pos.originalBalance >= pos.tokenBalance ? pos.originalBalance : pos.tokenBalance;
    const tokensNeeded = Math.floor(original / mult);
    const enriched = enrichPosition(pos, currentPrice);
    const actual = Math.min(tokensNeeded, enriched.sellableTokens, pos.tokenBalance);
    totalTokens += actual;
    totalSol += pos.initialSol;
  }
  return { tokensRaw: totalTokens, solValue: totalSol };
}
