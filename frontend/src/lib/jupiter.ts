import { VersionedTransaction, Connection } from "@solana/web3.js";

const JUPITER_API = "https://lite-api.jup.ag/swap/v1";

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
    if (!res.ok) {
      console.error("Jupiter quote failed:", res.status, await res.text());
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error("Jupiter quote error:", e);
    return null;
  }
}

export async function executeJupiterSwap(
  quote: JupiterQuote,
  userPublicKey: string,
  connection: Connection,
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>
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

  // Sign with wallet
  const signed = await signTransaction(vtx);

  // Send raw signed transaction
  const sig = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 2,
  });

  // Confirm
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}
