/**
 * Client-side unlock percentage calculator — mirrors the on-chain logic.
 * All calculations use floating-point for display purposes only.
 * The on-chain hook uses fixed-point and is the source of truth.
 */

export interface Position {
  entryPrice: number; // scaled by 10^18
  initialUsd: number; // scaled by 10^6
  tokenBalance: number; // raw (current remaining)
  unlockedBps: number; // 0-10000 (high-water mark)
  originalBalance: number; // raw (original buy amount, 0 = legacy)
}

export interface PositionDisplay extends Position {
  multiplier: number;
  phase: string;
  calculatedBps: number;
  effectiveBps: number;
  sellableTokens: number;
}

/**
 * Convert pool raw price ratio to on-chain price format.
 * Pool stores raw values: currentPrice = wsolAmount / skyeAmount
 * On-chain uses: price = wsolAmount * PRICE_SCALE / skyeAmount
 * Entry prices are stored in on-chain format, so we must scale.
 */
const PRICE_SCALE = 1e18;

export function getPhase(mult: number): string {
  if (mult <= 1.0) return "Underwater";
  if (mult < 2.0) return "Phase 1 (1x-2x)";
  if (mult < 5.0) return "Phase 2 (2x-5x)";
  if (mult < 10.0) return "Phase 3 (5x-10x)";
  if (mult < 15.0) return "Phase 4 (10x-15x)";
  return "Phase 5 (15x+)";
}

export function calculateUnlockedBps(
  currentPrice: number,
  position: Position
): number {
  const original = position.originalBalance >= position.tokenBalance
    ? position.originalBalance
    : position.tokenBalance;

  if (position.entryPrice === 0 || original === 0) return 10000;

  // currentPrice is the raw ratio (wsolAmount/skyeAmount).
  // entryPrice is stored as on-chain format (scaled by PRICE_SCALE).
  // Multiply currentPrice by PRICE_SCALE to match.
  const mult = (currentPrice * PRICE_SCALE) / position.entryPrice;

  if (mult <= 1.0) return 10000; // Underwater = 100%

  if (mult < 2.0) {
    // Phase 1: sell back initial USD investment
    // Uses original_balance (not current) to prevent drain bypass
    const currentValue = original * currentPrice;
    if (currentValue === 0) return 10000;
    const bps = (position.initialUsd / currentValue) * 10000 * 1e12;
    return Math.min(Math.floor(bps), 10000);
  }

  if (mult >= 15.0) return 10000; // Phase 5

  if (mult < 5.0) {
    const t = (mult - 2.0) / 3.0;
    return Math.floor(5000 + t * 1250 * 0.5);
  }
  if (mult < 10.0) {
    const t = (mult - 5.0) / 5.0;
    return Math.floor(6250 + t * 1250 * 0.5);
  }
  const t = (mult - 10.0) / 5.0;
  return Math.floor(7500 + t * 2500 * 0.5);
}

/**
 * Compute sellable tokens from ORIGINAL balance, not remaining.
 * sellable_now = (original * bps / 10000) - already_sold
 */
export function computeSellableTokens(pos: Position, effectiveBps: number): number {
  const original = pos.originalBalance >= pos.tokenBalance
    ? pos.originalBalance
    : pos.tokenBalance;

  const maxSellable = Math.floor((original * effectiveBps) / 10000);
  const alreadySold = original - pos.tokenBalance;
  const sellableNow = Math.max(0, maxSellable - alreadySold);
  return Math.min(sellableNow, pos.tokenBalance);
}

export function enrichPosition(
  pos: Position,
  currentPrice: number
): PositionDisplay {
  const mult = pos.entryPrice > 0 ? (currentPrice * PRICE_SCALE) / pos.entryPrice : 0;
  const calculatedBps = calculateUnlockedBps(currentPrice, pos);
  const effectiveBps = Math.max(calculatedBps, pos.unlockedBps);
  const sellableTokens = computeSellableTokens(pos, effectiveBps);

  return {
    ...pos,
    multiplier: mult,
    phase: getPhase(mult),
    calculatedBps,
    effectiveBps,
    sellableTokens,
  };
}

/**
 * Compute how many tokens need to be sold to recover initial_usd across all positions.
 * initial_usd is in on-chain format; currentPrice is the raw pool ratio.
 */
export function getInitialBackTokens(
  positions: Position[],
  currentPrice: number
): { tokensRaw: number; usdValue: number } {
  if (currentPrice === 0) return { tokensRaw: 0, usdValue: 0 };
  const scaledPrice = currentPrice * PRICE_SCALE;

  let totalTokens = 0;
  let totalUsd = 0;

  for (const pos of positions) {
    if (pos.entryPrice === 0 || pos.tokenBalance === 0) continue;
    const mult = scaledPrice / pos.entryPrice;
    if (mult <= 1.0) continue; // underwater — no "initial back" needed, can sell all

    // tokens_to_recover_initial = initial_usd / (currentPrice * PRICE_SCALE / PRICE_SCALE)
    // = initial_usd / scaledPrice (but initial_usd was computed as tokens * price / PRICE_SCALE * USD_SCALE)
    // Simplify: tokensNeeded = initial_usd * PRICE_SCALE / (scaledPrice * USD_SCALE)
    //                        = initial_usd / (currentPrice * USD_SCALE)
    // But initial_usd = original_tokens * entry_price * USD_SCALE / PRICE_SCALE
    // So tokensNeeded = original_tokens * entry_price / (scaledPrice)
    //                 = original_tokens / mult
    const original = pos.originalBalance >= pos.tokenBalance ? pos.originalBalance : pos.tokenBalance;
    const tokensNeeded = Math.floor(original / mult);
    const clampedToBalance = Math.min(tokensNeeded, pos.tokenBalance);

    // Check against sellable limit
    const enriched = enrichPosition(pos, currentPrice);
    const actual = Math.min(clampedToBalance, enriched.sellableTokens);

    totalTokens += actual;
    // USD value estimate: actual * currentPrice * SOL_USD ... but we don't have SOL_USD here.
    // Store the SOL value instead; caller converts.
    totalUsd += pos.initialUsd; // in on-chain units, caller scales
  }

  return { tokensRaw: totalTokens, usdValue: totalUsd };
}

export function getTotalSellable(
  positions: Position[],
  currentPrice: number
): number {
  return positions.reduce((sum, pos) => {
    const enriched = enrichPosition(pos, currentPrice);
    return sum + enriched.sellableTokens;
  }, 0);
}
