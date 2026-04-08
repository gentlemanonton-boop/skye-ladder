import { DECIMALS, TOTAL_SUPPLY } from "../constants";

export function rawToHuman(raw: number | bigint): number {
  return Number(raw) / 10 ** DECIMALS;
}

export function humanToRaw(human: number): bigint {
  return BigInt(Math.floor(human * 10 ** DECIMALS));
}

export function formatTokens(raw: number | bigint, dp = 2): string {
  return rawToHuman(raw).toLocaleString(undefined, {
    maximumFractionDigits: dp,
  });
}

export function formatSol(lamports: number | bigint, dp = 6): string {
  return (Number(lamports) / 1e9).toFixed(dp);
}

export function formatUsd(amount: number, dp = 2): string {
  return "$" + amount.toLocaleString(undefined, { maximumFractionDigits: dp });
}

export function formatPercent(bps: number): string {
  return (bps / 100).toFixed(1) + "%";
}

export function formatMultiplier(mult: number): string {
  return mult.toFixed(2) + "x";
}

export function computeMcSol(
  skyeReserve: number,
  wsolReserve: number
): number {
  if (skyeReserve === 0) return 0;
  const pricePerRaw = wsolReserve / skyeReserve;
  return pricePerRaw * TOTAL_SUPPLY * 10 ** DECIMALS;
}

export function computeSwapOutput(
  reserveIn: number,
  reserveOut: number,
  amountIn: number,
  feeBps: number
): number {
  const fee = (amountIn * feeBps) / 10000;
  const effectiveIn = amountIn - fee;
  return (effectiveIn * reserveOut) / (reserveIn + effectiveIn);
}

/**
 * Compute SOL output for a curve SELL, matching the on-chain math exactly.
 *
 * On-chain (`programs/skye-curve/src/instructions/swap.rs`, `math.rs::compute_sell`
 * + `math.rs::split_sell_output`):
 *   sol_out_raw      = T × V_s / (V_t + T)              // fee NOT yet applied
 *   fee              = sol_out_raw × fee_bps / 10000
 *   sol_out_to_user  = sol_out_raw - fee                 // user receives this
 *   treasury_fee     = fee / 2                           // pays out separately
 *   pool retains the remaining fee/2 inside its reserves
 *
 * Net effect: the user pays exactly `fee_bps` on sells.
 *
 * The plain `computeSwapOutput` helper applies the fee on the INPUT side,
 * which is mathematically different from the on-chain output-side fee. Use
 * this helper for any curve sell preview to stay aligned with the program.
 */
export function computeCurveSellOutput(
  virtualSol: number,
  virtualToken: number,
  tokensIn: number,
  feeBps: number
): number {
  if (tokensIn <= 0 || virtualSol <= 0 || virtualToken <= 0) return 0;
  const solOutRaw = Math.floor((tokensIn * virtualSol) / (virtualToken + tokensIn));
  const fee = Math.floor((solOutRaw * feeBps) / 10000);
  return solOutRaw - fee;
}
