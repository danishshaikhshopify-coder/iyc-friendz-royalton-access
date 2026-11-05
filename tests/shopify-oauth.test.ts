import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  isValidShopDomain,
  generateOAuthState,
  buildAuthorizeUrl,
  verifyOAuthCallbackHmac,
  exchangeCodeForToken,
  refreshAccessToken,
  getValidAccessToken,
  ShopNotInstalledError,
  OAuthError,
} from "@/lib/shopify-oauth";
import { upsertShopInstallation, getActiveShopInstallation } from "@/lib/shop-installations";

const API_SECRET = "test-oauth-client-secret"; // matches tests/setup.ts

function uniqueShop(): string {
  return `shop-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`;
}

function signOAuthCallback(params: Record<string, string>, secret: string): string {
  const pairs = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  return createHmac("sha256", secret).update(pairs.join("&")).digest("hex");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isValidShopDomain", () => {
  it("accepts a well-formed myshopify.com domain", () => {
    expect(isValidShopDomain("inyourcitycorp.myshopify.com")).toBe(true);
  });

  it.each([
    "not-a-shop",
    "inyourcitycorp.myshopify.com.evil.com",
    "evil.com/inyourcitycorp.myshopify.com",
    "https://inyourcitycorp.myshopify.com",
    "",
    "-leading-dash.myshopify.com",
  ])("rejects %s", (bad) => {
    expect(isValidShopDomain(bad)).toBe(false);
  });
});

describe("generateOAuthState", () => {
  it("generates a non-empty, unpredictable, unique value each call", () => {
    const a = generateOAuthState();
    const b = generateOAuthState();
    expect(a).not.toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
});

describe("buildAuthorizeUrl", () => {
  it("includes client_id, scope, redirect_uri, and state", () => {
    const url = buildAuthorizeUrl("test-shop.myshopify.com", "the-state-value", "https://app.example.com/api/auth/callback");
    expect(url).toMatch(/^https:\/\/test-shop\.myshopify\.com\/admin\/oauth\/authorize\?/);
    expect(url).toContain("scope=read_orders%2Cread_products");
    expect(url).toContain("state=the-state-value");
    expect(url).toContain(encodeURIComponent("https://app.example.com/api/auth/callback"));
  });
});

describe("verifyOAuthCallbackHmac", () => {
  it("accepts a correctly-signed callback", () => {
    const params = new URLSearchParams({ shop: "test-shop.myshopify.com", code: "abc123", state: "xyz", timestamp: "1700000000" });
    const hmac = signOAuthCallback(
      { shop: "test-shop.myshopify.com", code: "abc123", state: "xyz", timestamp: "1700000000" },
      API_SECRET
    );
    params.set("hmac", hmac);
    expect(verifyOAuthCallbackHmac(params, API_SECRET).valid).toBe(true);
  });

  it("rejects a missing hmac", () => {
    const params = new URLSearchParams({ shop: "test-shop.myshopify.com" });
    expect(verifyOAuthCallbackHmac(params, API_SECRET)).toMatchObject({ valid: false, reason: "missing_hmac" });
  });

  it("rejects a tampered parameter even if hmac is present", () => {
    const params = new URLSearchParams({ shop: "test-shop.myshopify.com", code: "abc123", state: "xyz" });
    const hmac = signOAuthCallback({ shop: "test-shop.myshopify.com", code: "abc123", state: "xyz" }, API_SECRET);
    params.set("hmac", hmac);
    params.set("code", "tampered-code"); // mutate after signing
    expect(verifyOAuthCallbackHmac(params, API_SECRET).valid).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const params = new URLSearchParams({ shop: "test-shop.myshopify.com", code: "abc123" });
    const hmac = signOAuthCallback({ shop: "test-shop.myshopify.com", code: "abc123" }, "wrong-secret");
    params.set("hmac", hmac);
    expect(verifyOAuthCallbackHmac(params, API_SECRET).valid).toBe(false);
  });
});

describe("exchangeCodeForToken", () => {
  it("returns the parsed token on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "shpat_abc", scope: "read_orders" }),
      })
    );
    const result = await exchangeCodeForToken("test-shop.myshopify.com", "the-code");
    expect(result.accessToken).toBe("shpat_abc");
    expect(result.scope).toBe("read_orders");
    expect(result.expiresAt).toBeNull();
  });

  it("captures expiry/refresh token when Shopify returns expiring-token fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "shpat_abc", scope: "read_orders", expires_in: 3600, refresh_token: "shrfrsh_xyz" }),
      })
    );
    const result = await exchangeCodeForToken("test-shop.myshopify.com", "the-code");
    expect(result.refreshToken).toBe("shrfrsh_xyz");
    expect(result.expiresAt).not.toBeNull();
  });

  it("throws OAuthError on a non-OK HTTP response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await expect(exchangeCodeForToken("test-shop.myshopify.com", "bad-code")).rejects.toThrow(OAuthError);
  });

  it("throws OAuthError on a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(exchangeCodeForToken("test-shop.myshopify.com", "the-code")).rejects.toThrow(OAuthError);
  });
});

describe("getValidAccessToken", () => {
  it("throws ShopNotInstalledError for a shop with no installation", async () => {
    await expect(getValidAccessToken(uniqueShop())).rejects.toThrow(ShopNotInstalledError);
  });

  it("returns the stored token unchanged when it has no expiry (non-expiring offline token)", async () => {
    const shop = uniqueShop();
    await upsertShopInstallation({
      shopDomain: shop,
      accessToken: "non-expiring-token",
      refreshToken: null,
      scope: "read_orders",
      tokenExpiresAt: null,
    });
    expect(await getValidAccessToken(shop)).toBe("non-expiring-token");
  });

  it("returns the stored token unchanged when far from expiry", async () => {
    const shop = uniqueShop();
    await upsertShopInstallation({
      shopDomain: shop,
      accessToken: "still-fresh-token",
      refreshToken: "a-refresh-token",
      scope: "read_orders",
      tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(await getValidAccessToken(shop)).toBe("still-fresh-token");
  });

  it("refreshes and persists a new token when the stored one is expired", async () => {
    const shop = uniqueShop();
    await upsertShopInstallation({
      shopDomain: shop,
      accessToken: "expired-token",
      refreshToken: "valid-refresh-token",
      scope: "read_orders",
      tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "brand-new-token", scope: "read_orders", expires_in: 3600, refresh_token: "new-refresh-token" }),
      })
    );

    const token = await getValidAccessToken(shop);
    expect(token).toBe("brand-new-token");

    const installation = await getActiveShopInstallation(shop);
    expect(installation?.accessToken).toBe("brand-new-token");
    expect(installation?.refreshToken).toBe("new-refresh-token");
  });

  it("throws if the token is expired and there is no refresh token to recover with", async () => {
    const shop = uniqueShop();
    await upsertShopInstallation({
      shopDomain: shop,
      accessToken: "expired-token",
      refreshToken: null,
      scope: "read_orders",
      tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await expect(getValidAccessToken(shop)).rejects.toThrow(OAuthError);
  });
});

describe("refreshAccessToken", () => {
  it("returns the refreshed token pair on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "refreshed", scope: "read_orders", expires_in: 3600, refresh_token: "rotated-refresh" }),
      })
    );
    const result = await refreshAccessToken("test-shop.myshopify.com", "old-refresh");
    expect(result.accessToken).toBe("refreshed");
    expect(result.refreshToken).toBe("rotated-refresh");
  });

  it("throws OAuthError when Shopify rejects the refresh token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await expect(refreshAccessToken("test-shop.myshopify.com", "invalid-refresh")).rejects.toThrow(OAuthError);
  });
});
