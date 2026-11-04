import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "@/lib/crypto";

describe("crypto (AES-256-GCM token-at-rest encryption)", () => {
  it("round-trips a plaintext value", () => {
    const plaintext = "shpat_super-secret-offline-token-value";
    const encoded = encryptSecret(plaintext);
    expect(decryptSecret(encoded)).toBe(plaintext);
  });

  it("produces a different ciphertext each time (random IV) even for the same plaintext", () => {
    const a = encryptSecret("same-value");
    const b = encryptSecret("same-value");
    expect(a).not.toEqual(b);
  });

  it("never stores the plaintext inside the encoded value", () => {
    const plaintext = "a-very-identifiable-secret-string";
    const encoded = encryptSecret(plaintext);
    expect(encoded).not.toContain(plaintext);
  });

  it("rejects a tampered ciphertext (GCM auth tag fails)", () => {
    const encoded = encryptSecret("some-token");
    const [iv, tag, ciphertext] = encoded.split(":");
    const tamperedByte = Buffer.from(ciphertext!, "base64");
    tamperedByte[0] = (tamperedByte[0] ?? 0) ^ 0xff;
    const tampered = [iv, tag, tamperedByte.toString("base64")].join(":");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("rejects a malformed encoded value", () => {
    expect(() => decryptSecret("not-the-right-shape")).toThrow();
  });
});
