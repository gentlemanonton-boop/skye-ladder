import { VersionedTransaction, Connection } from "@solana/web3.js";

const JUPITER_API = "https://quote-api.jup.ag/v6";

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: any[];
  otherAmountThreshold: string;
}

export async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps = 100
): Promise<JupiterQuote | null> {
  if (amount <= 0) return null;
  try {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: Math.floor(amount).toString(),
      slippageBps: slippageBps.toString(),
    });
    const res = await fetch(`${JUPITER_API}/quote?${params}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function executeJupiterSwap(
  quote: JupiterQuote,
  userPublicKey: string,
  connection: Connection,
  sendTransaction: (tx: VersionedTransaction, conn: Connection) => Promise<string>
): Promise<string> {
  // Get swap transaction from Jupiter
  const res = await fetch(`${JUPITER_API}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Jupiter swap failed: ${err}`);
  }

  const { swapTransaction } = await res.json();
  const txBuf = Buffer.from(swapTransaction, "base64");
  const vtx = VersionedTransaction.deserialize(txBuf);

  const sig = await sendTransaction(vtx, connection);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}
