/**
 * Secure, customer-specific access tokens.
 *
 * Design:
 *  - The token handed to the customer (in the email link) is 32 bytes of
 *    `crypto.randomBytes`, base64url-encoded — not sequential, not derived
 *    from the order ID, and not guessable.
 *  - The database never stores the raw token. It stores only
 *    `hashToken(raw)`, an HMAC-SHA256 of the raw token keyed by
 *    ACCESS_TOKEN_SIGNING_SECRET. HMAC (vs. a plain hash) means that even
 *    if both the database AND the hashing scheme leaked, the token still
 *    can't be reconstructed without the server-side secret — and rotating
 *    ACCESS_TOKEN_SIGNING_SECRET invalidates every outstanding token at
 *    once, which is the documented revocation/rotation mechanism.
 *  - Verification compares hashes with a timing-safe comparison so the
 *    process can't be used as a timing oracle to brute-force a token
 *    byte-by-byte.
 *  - Raw tokens must NEVER be logged. Only `redactToken` (last 6 chars) is
 *    safe to put in logs, for correlating support requests to an
 *    operator-visible identifier without exposing the credential.
 */

import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_BYTE_LENGTH = 32;

export function generateAccessToken(): string {
  return randomBytes(TOKEN_BYTE_LENGTH).toString("base64url");
}

export function hashToken(rawToken: string, signingSecret: string): string {
  return createHmac("sha256", signingSecret).update(rawToken).digest("hex");
}

/**
 * Constant-time-ish comparison of a candidate raw token against a stored
 * hash. Always re-derives the hash and compares digests, never compares
 * raw token strings directly.
 */
export function verifyAccessToken(
  candidateRawToken: string,
  storedHash: string,
  signingSecret: string
): boolean {
  if (!candidateRawToken || !storedHash) return false;

  const candidateHash = hashToken(candidateRawToken, signingSecret);

  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(candidateHash, "hex");
    b = Buffer.from(storedHash, "hex");
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

/**
 * Safe-for-logs representation: last 6 characters only. Never log the raw
 * token or its full hash — this is for correlating a support ticket to a
 * token without reconstructing it.
 */
export function redactToken(rawOrHashedToken: string): string {
  if (rawOrHashedToken.length <= 6) return "******";
  return `…${rawOrHashedToken.slice(-6)}`;
}
