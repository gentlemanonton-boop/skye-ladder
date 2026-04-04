/**
 * Local storage for launched token metadata.
 * Stores name, symbol, image, description, socials for each mint.
 */

export interface LaunchedTokenInfo {
  mint: string;
  name: string;
  symbol: string;
  image: string;
  description: string;
  website: string;
  twitter: string;
  telegram: string;
  discord: string;
  curve: string;
  creator: string;
  launchedAt: number;
}

const STORE_KEY = "skye_launched_tokens_v2";

export function getStoredTokens(): LaunchedTokenInfo[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function storeToken(info: LaunchedTokenInfo) {
  const tokens = getStoredTokens();
  // Don't duplicate
  if (tokens.find(t => t.mint === info.mint)) return;
  tokens.unshift(info);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(tokens)); } catch {}
}

export function getTokenInfo(mint: string): LaunchedTokenInfo | undefined {
  return getStoredTokens().find(t => t.mint === mint);
}
