import { describe, it, expect } from "vitest";
import { generateAccessToken, hashToken, verifyAccessToken, redactToken } from "@/lib/token";

const SECRET = "test-token-signing-secret";

describe("token security", () => {
  it("generates non-predictable, reasonably long tokens", () => {
    const a = generateAccessToken();
    const b = generateAccessToken();
    expect(a).not.toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(40); // 32 random bytes, base64url
    // Not sequential / not derived from a counter or timestamp pattern.
    expect(/^[0-9]+$/.test(a)).toBe(false);
  });

  it("hashToken is deterministic for the same token+secret", () => {
    const token = generateAccessToken();
    expect(hashToken(token, SECRET)).toEqual(hashToken(token, SECRET));
  });

  it("hashToken differs for different secrets (supports secret rotation / revocation)", () => {
    const token = generateAccessToken();
    expect(hashToken(token, SECRET)).not.toEqual(hashToken(token, "a-different-secret"));
  });

  it("verifyAccessToken accepts the correct token", () => {
    const token = generateAccessToken();
    const hash = hashToken(token, SECRET);
    expect(verifyAccessToken(token, hash, SECRET)).toBe(true);
  });

  it("verifyAccessToken rejects a wrong token", () => {
    const token = generateAccessToken();
    const hash = hashToken(token, SECRET);
    const wrongToken = generateAccessToken();
    expect(verifyAccessToken(wrongToken, hash, SECRET)).toBe(false);
  });

  it("verifyAccessToken rejects a token that is valid under a rotated-away secret", () => {
    const token = generateAccessToken();
    const hash = hashToken(token, SECRET);
    expect(verifyAccessToken(token, hash, "a-new-rotated-secret")).toBe(false);
  });

  it("verifyAccessToken handles malformed input without throwing", () => {
    expect(() => verifyAccessToken("not-hex-at-all-🙂", "also-not-hex", SECRET)).not.toThrow();
    expect(verifyAccessToken("", "", SECRET)).toBe(false);
  });

  it("redactToken never returns the full value", () => {
    const token = generateAccessToken();
    const redacted = redactToken(token);
    expect(redacted).not.toEqual(token);
    expect(redacted.length).toBeLessThan(token.length);
    expect(redacted.endsWith(token.slice(-6))).toBe(true);
  });
});
