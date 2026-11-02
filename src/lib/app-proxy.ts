/**
 * Verification of Shopify App Proxy request signatures.
 *
 * When a storefront request is forwarded through an App Proxy, Shopify
 * appends a `signature` query parameter computed as:
 *
 *   HMAC-SHA256(secret, sorted_and_concatenated_query_params)
 *
 * where every OTHER query parameter is sorted alphabetically by key, each
 * key's values are joined with commas if repeated, and each
 * "key=value1,value2" pair is concatenated with no separator between
 * pairs (this is Shopify's documented, slightly unusual scheme — not a
 * standard query string). The signature itself is excluded from the
 * digest input and is hex-encoded (not base64, unlike webhook HMACs).
 *
 * This file is the only place that implements that scheme. Route handlers
 * must call `verifyAppProxySignature` on every request before trusting ANY
 * other query parameter (shop, logged_in_customer_id, path_prefix, or any
 * app-specific param like a token) — query params are otherwise trivially
 * forgeable by anyone.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface AppProxyVerificationResult {
  valid: boolean;
  reason?: string;
}

export function verifyAppProxySignature(
  searchParams: URLSearchParams,
  secret: string
): AppProxyVerificationResult {
  const signature = searchParams.get("signature");
  if (!signature) {
    return { valid: false, reason: "missing_signature_param" };
  }

  // Collect every param except `signature`, grouping repeated keys.
  const grouped = new Map<string, string[]>();
  for (const [key, value] of searchParams.entries()) {
    if (key === "signature") continue;
    const existing = grouped.get(key);
    if (existing) {
      existing.push(value);
    } else {
      grouped.set(key, [value]);
    }
  }

  const sortedKeys = Array.from(grouped.keys()).sort();
  const message = sortedKeys
    .map((key) => `${key}=${grouped.get(key)!.join(",")}`)
    .join("");

  const digestHex = createHmac("sha256", secret).update(message).digest("hex");

  let providedBuf: Buffer;
  let digestBuf: Buffer;
  try {
    providedBuf = Buffer.from(signature, "hex");
    digestBuf = Buffer.from(digestHex, "hex");
  } catch {
    return { valid: false, reason: "signature_not_hex" };
  }

  if (providedBuf.length !== digestBuf.length) {
    return { valid: false, reason: "signature_length_mismatch" };
  }

  const matches = timingSafeEqual(digestBuf, providedBuf);
  return matches ? { valid: true } : { valid: false, reason: "signature_mismatch" };
}
