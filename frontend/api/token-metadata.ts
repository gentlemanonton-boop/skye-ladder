import { put, head } from "@vercel/blob";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const ALLOWED_ORIGINS = ["https://skyefall.gg", "https://www.skyefall.gg"];

function isAllowedOrigin(req: VercelRequest): boolean {
  const origin = req.headers.origin || "";
  // Allow same-origin requests (no Origin header) and known origins.
  // In development, allow localhost.
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (origin.startsWith("http://localhost:")) return true;
  return false;
}

/**
 * POST /api/token-metadata
 * Body: { mint, name, symbol, description, imageUrl }
 * Stores the metadata JSON in Vercel Blob.
 * Write-once: rejects if metadata already exists for the given mint.
 *
 * GET /api/token-metadata?mint=<ADDRESS>
 * Returns the Metaplex-compatible JSON for wallets/explorers.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "POST") {
    if (!isAllowedOrigin(req)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    try {
      const { mint, name, symbol, description, imageUrl } = req.body;
      if (!mint || !name) {
        return res.status(400).json({ error: "mint and name required" });
      }

      // Validate mint looks like a base58 Solana address (32-44 chars, no special chars)
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
        return res.status(400).json({ error: "Invalid mint address" });
      }

      // Write-once: reject if metadata already exists for this mint
      try {
        await head(`tokens/${mint}/metadata.json`);
        return res.status(409).json({ error: "Metadata already exists for this mint" });
      } catch {
        // Doesn't exist yet — proceed with write
      }

      const metadata = {
        name: String(name).slice(0, 50),
        symbol: String(symbol || "").slice(0, 10),
        description: String(description || "").slice(0, 500),
        image: imageUrl || "",
        attributes: [
          { trait_type: "Platform", value: "Skye Ladder" },
          { trait_type: "Program", value: "Token-2022 Transfer Hook" },
        ],
        properties: { category: "currency" },
      };

      const blob = await put(`tokens/${mint}/metadata.json`, JSON.stringify(metadata), {
        access: "public",
        contentType: "application/json",
        addRandomSuffix: false,
      });

      return res.status(200).json({ url: blob.url });
    } catch (e: any) {
      console.error("Metadata store error:", e);
      return res.status(500).json({ error: "Store failed" });
    }
  }

  if (req.method === "GET") {
    const mint = req.query.mint as string;
    if (!mint) return res.status(400).json({ error: "mint required" });

    try {
      const blobInfo = await head(`tokens/${mint}/metadata.json`);
      const response = await fetch(blobInfo.url);
      const data = await response.json();
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.status(200).json(data);
    } catch {
      return res.status(404).json({ error: "Not found" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
