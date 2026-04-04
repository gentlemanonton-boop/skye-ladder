export interface ParsedTrade {
  type: "buy" | "sell";
  solAmount: number;
  skyeAmount: number;
}

export function parseTradeLogs(logs: string[]): ParsedTrade | null {
  const buyLog = logs.find(l => l.includes("BUY:") && l.includes("WSOL"));
  const sellLog = logs.find(l => l.includes("SELL:") && l.includes("SKYE"));

  if (buyLog) {
    const m = buyLog.match(/BUY: (\d+) WSOL -> (\d+) SKYE/);
    if (m) return { type: "buy", solAmount: parseInt(m[1]), skyeAmount: parseInt(m[2]) };
  } else if (sellLog) {
    const m = sellLog.match(/SELL: (\d+) SKYE -> (\d+) WSOL/);
    if (m) return { type: "sell", skyeAmount: parseInt(m[1]), solAmount: parseInt(m[2]) };
  }

  return null;
}
