import { put, head } from "@vercel/blob";
import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * POST /api/token-metadata
 * Body: { mint, name, symbol, description, imageUrl }
 * Stores the metadata JSON in Vercel Blob.
 *
 * GET /api/token-metadata?mint=<ADDRESS>
 * Returns the Metaplex-compatible JSON for wallets/explorers.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "POST") {
    try {
      const { mint, name, symbol, description, imageUrl } = req.body;
      if (!mint || !name) {
        return res.status(400).json({ error: "mint and name required" });
      }

      const metadata = {
        name,
        symbol: symbol || "",
        description: description || "",
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
      return res.status(500).json({ error: e.message || "Store failed" });
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
