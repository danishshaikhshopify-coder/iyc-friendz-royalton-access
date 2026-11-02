import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyAppProxySignature } from "@/lib/app-proxy";

const SECRET = "test-app-proxy-secret";

/** Mirrors Shopify's documented App Proxy signing scheme, for test fixtures. */
function sign(params: Record<string, string | string[]>, secret: string): string {
  const sortedKeys = Object.keys(params).sort();
  const message = sortedKeys
    .map((key) => {
      const value = params[key];
      const joined = Array.isArray(value) ? value.join(",") : value;
      return `${key}=${joined}`;
    })
    .join("");
  return createHmac("sha256", secret).update(message).digest("hex");
}

function buildSearchParams(
  params: Record<string, string | string[]>,
  signature: string
): URLSearchParams {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const v of value) sp.append(key, v);
    } else {
      sp.append(key, value);
    }
  }
  sp.set("signature", signature);
  return sp;
}

describe("verifyAppProxySignature", () => {
  it("accepts a correctly signed request", () => {
    const params = { shop: "test-shop.myshopify.com", path_prefix: "/apps/royalton-access", timestamp: "1700000000", token: "abc123" };
    const signature = sign(params, SECRET);
    const sp = buildSearchParams(params, signature);
    expect(verifyAppProxySignature(sp, SECRET)).toEqual({ valid: true });
  });

  it("rejects a tampered query parameter (e.g. a forged token)", () => {
    const params = { shop: "test-shop.myshopify.com", timestamp: "1700000000", token: "abc123" };
    const signature = sign(params, SECRET);
    const sp = buildSearchParams({ ...params, token: "someone-elses-token" }, signature);
    expect(verifyAppProxySignature(sp, SECRET).valid).toBe(false);
  });

  it("rejects a missing signature", () => {
    const sp = new URLSearchParams({ shop: "test-shop.myshopify.com" });
    expect(verifyAppProxySignature(sp, SECRET)).toEqual({
      valid: false,
      reason: "missing_signature_param",
    });
  });

  it("rejects a signature produced with the wrong secret", () => {
    const params = { shop: "test-shop.myshopify.com" };
    const signature = sign(params, "wrong-secret");
    const sp = buildSearchParams(params, signature);
    expect(verifyAppProxySignature(sp, SECRET).valid).toBe(false);
  });

  it("handles a repeated query key by joining with commas, per Shopify's scheme", () => {
    const params = { shop: "test-shop.myshopify.com", ids: ["1", "2", "3"] };
    const signature = sign(params, SECRET);
    const sp = buildSearchParams(params, signature);
    expect(verifyAppProxySignature(sp, SECRET)).toEqual({ valid: true });
  });

  it("is order-independent (params are sorted before signing)", () => {
    const params = { b: "2", a: "1", c: "3" };
    const signature = sign(params, SECRET);
    // Build the search params in a different insertion order.
    const sp = new URLSearchParams();
    sp.append("c", "3");
    sp.append("a", "1");
    sp.append("b", "2");
    sp.set("signature", signature);
    expect(verifyAppProxySignature(sp, SECRET)).toEqual({ valid: true });
  });

  it("rejects a non-hex signature without throwing", () => {
    const sp = new URLSearchParams({ shop: "x", signature: "not-hex!!" });
    expect(() => verifyAppProxySignature(sp, SECRET)).not.toThrow();
    expect(verifyAppProxySignature(sp, SECRET).valid).toBe(false);
  });
});
