/**
 * Webhook signature verification (X-Hub-Signature-256).
 *
 * GitHub signs the RAW request body with HMAC-SHA256 using the webhook secret
 * and sends `sha256=<hex>`. We compare with a timing-safe equality over the
 * exact bytes — parse nothing before this check.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyWebhookSignature(
  secret: string,
  rawBody: string | Buffer,
  signatureHeader: string | undefined | null,
): boolean {
  if (!secret) return false;
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const provided = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
