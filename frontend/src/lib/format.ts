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
