/**
 * Verification of Shopify webhook HMAC signatures.
 *
 * Shopify signs every webhook body with HMAC-SHA256 (base64-encoded) using
 * the app's webhook signing secret, delivered in the
 * `X-Shopify-Hmac-Sha256` header. This MUST be verified against the exact
 * raw request body bytes — not a re-serialized/parsed-and-stringified copy
 * — because any difference in whitespace or key order changes the digest.
 *
 * Next.js route handlers: read the body with `request.text()` (not
 * `request.json()`) so the raw bytes are preserved for this check, then
 * `JSON.parse` only after verification succeeds.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface HmacVerificationResult {
  valid: boolean;
  reason?: string;
}

/**
 * @param rawBody   The exact, unmodified request body as received (string
 *                  or Buffer — do not trim, re-encode, or reformat it).
 * @param signature The value of the X-Shopify-Hmac-Sha256 header.
 * @param secret    The webhook signing secret for this app.
 */
export function verifyShopifyWebhookHmac(
  rawBody: string | Buffer,
  signature: string | null | undefined,
  secret: string
): HmacVerificationResult {
  if (!signature) {
    return { valid: false, reason: "missing_signature_header" };
  }

  const digest = createHmac("sha256", secret).update(rawBody).digest();

  let providedDigest: Buffer;
  try {
    providedDigest = Buffer.from(signature, "base64");
  } catch {
    return { valid: false, reason: "signature_not_base64" };
  }

  // timingSafeEqual throws if lengths differ; treat that as "invalid"
  // rather than letting it leak via an exception / timing difference.
  if (providedDigest.length !== digest.length) {
    return { valid: false, reason: "signature_length_mismatch" };
  }

  const matches = timingSafeEqual(digest, providedDigest);
  return matches ? { valid: true } : { valid: false, reason: "signature_mismatch" };
}
