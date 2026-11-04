/**
 * At-rest encryption for stored Shopify OAuth tokens (AES-256-GCM).
 *
 * Encoded format: `base64(iv):base64(authTag):base64(ciphertext)` — a
 * single TEXT column value. The IV is random per encryption call; GCM's
 * auth tag detects any tampering with the stored value before decrypt.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "@/lib/config";

const ALGORITHM = "aes-256-gcm";
const IV_BYTE_LENGTH = 12;

function getKey(): Buffer {
  const key = Buffer.from(config.security.tokenEncryptionKey, "base64");
  if (key.length !== 32) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must decode (base64) to exactly 32 bytes. Generate with: openssl rand -base64 32"
    );
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((b) => b.toString("base64")).join(":");
}

export function decryptSecret(encoded: string): string {
  const parts = encoded.split(":");
  const [ivB64, authTagB64, ciphertextB64] = parts;
  if (parts.length !== 3 || !ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("Malformed encrypted value (expected iv:authTag:ciphertext)");
  }
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");

  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
