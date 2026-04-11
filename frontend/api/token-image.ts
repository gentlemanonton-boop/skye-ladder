import { put } from "@vercel/blob";
import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * POST /api/token-image
 * Body: { mint: string, image: string (base64 data URI) }
 * Returns: { url: string }
 *
 * Stores the token image in Vercel Blob and returns a permanent URL.
 * Called during launch to make images available cross-device.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { mint, image } = req.body;
    if (!mint || !image) {
      return res.status(400).json({ error: "mint and image required" });
    }

    // Parse data URI: "data:image/png;base64,iVBOR..."
    const match = image.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: "Invalid data URI" });
    }

    const contentType = match[1];
    const buffer = Buffer.from(match[2], "base64");
    const ext = contentType.split("/")[1] || "png";

    const blob = await put(`tokens/${mint}/image.${ext}`, buffer, {
      access: "public",
      contentType,
      addRandomSuffix: false,
    });

    return res.status(200).json({ url: blob.url });
  } catch (e: any) {
    console.error("Image upload error:", e);
    return res.status(500).json({ error: e.message || "Upload failed" });
  }
}
