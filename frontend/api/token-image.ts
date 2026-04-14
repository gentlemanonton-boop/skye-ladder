import { put, head } from "@vercel/blob";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB server-side limit
const ALLOWED_ORIGINS = ["https://skyefall.gg", "https://www.skyefall.gg"];

function isAllowedOrigin(req: VercelRequest): boolean {
  const origin = req.headers.origin || "";
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (origin.startsWith("http://localhost:")) return true;
  return false;
}

/**
 * POST /api/token-image
 * Body: { mint: string, image: string (base64 data URI) }
 * Returns: { url: string }
 *
 * Stores the token image in Vercel Blob and returns a permanent URL.
 * Write-once: rejects if an image already exists for the given mint.
 * Called during launch to make images available cross-device.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isAllowedOrigin(req)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    const { mint, image } = req.body;
    if (!mint || !image) {
      return res.status(400).json({ error: "mint and image required" });
    }

    // Validate mint looks like a base58 Solana address
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
      return res.status(400).json({ error: "Invalid mint address" });
    }

    // Parse data URI: "data:image/png;base64,iVBOR..."
    const match = image.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: "Invalid data URI" });
    }

    // Only allow image content types
    const contentType = match[1];
    if (!contentType.startsWith("image/")) {
      return res.status(400).json({ error: "Only image files are allowed" });
    }

    const buffer = Buffer.from(match[2], "base64");

    // Server-side size limit
    if (buffer.length > MAX_IMAGE_BYTES) {
      return res.status(400).json({ error: "Image must be under 5MB" });
    }

    const ext = contentType.split("/")[1] || "png";

    // Write-once: reject if image already exists for this mint
    try {
      await head(`tokens/${mint}/image.${ext}`);
      return res.status(409).json({ error: "Image already exists for this mint" });
    } catch {
      // Doesn't exist yet — proceed with write
    }

    const blob = await put(`tokens/${mint}/image.${ext}`, buffer, {
      access: "public",
      contentType,
      addRandomSuffix: false,
    });

    return res.status(200).json({ url: blob.url });
  } catch (e: any) {
    console.error("Image upload error:", e);
    return res.status(500).json({ error: "Upload failed" });
  }
}
