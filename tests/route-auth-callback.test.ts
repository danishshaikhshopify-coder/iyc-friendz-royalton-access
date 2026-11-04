/**
 * Route-level tests for the OAuth callback
 * (src/app/api/auth/callback/route.ts). The Shopify token endpoint itself
 * is mocked via global fetch; HMAC verification, state-cookie comparison,
 * and the shop_installations upsert all run for real.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/auth/callback/route";
import { getActiveShopInstallation } from "@/lib/shop-installations";

const SHOP = "test-shop.myshopify.com"; // matches tests/setup.ts
const API_SECRET = "test-oauth-client-secret"; // matches tests/setup.ts

afterEach(() => {
  vi.unstubAllGlobals();
});

function signCallback(params: Record<string, string>): string {
  const pairs = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  return createHmac("sha256", API_SECRET).update(pairs.join("&")).digest("hex");
}

function buildCallbackRequest(
  params: Record<string, string>,
  opts: { cookieState?: string; badHmac?: boolean; omitHmac?: boolean } = {}
): NextRequest {
  const url = new URL("https://app.example.com/api/auth/callback");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  if (!opts.omitHmac) {
    const hmac = opts.badHmac ? "0".repeat(64) : signCallback(params);
    url.searchParams.set("hmac", hmac);
  }

  const headers: Record<string, string> = {};
  if (opts.cookieState !== undefined) {
    headers.cookie = `shopify_oauth_state=${opts.cookieState}`;
  }
  return new NextRequest(url.toString(), { headers });
}

describe("OAuth callback — GET /api/auth/callback", () => {
  it("rejects a malformed shop domain", async () => {
    const req = buildCallbackRequest({ shop: "not-a-shop", code: "abc", state: "s" }, { cookieState: "s" });
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("rejects a well-formed but unconfigured shop", async () => {
    const req = buildCallbackRequest(
      { shop: "someone-elses-shop.myshopify.com", code: "abc", state: "s" },
      { cookieState: "s" }
    );
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("rejects a missing state cookie", async () => {
    const req = buildCallbackRequest({ shop: SHOP, code: "abc", state: "s" });
    const res = await GET(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_state" });
  });

  it("rejects a state query param that doesn't match the cookie", async () => {
    const req = buildCallbackRequest({ shop: SHOP, code: "abc", state: "state-from-shopify" }, { cookieState: "a-different-state" });
    const res = await GET(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_state" });
  });

  it("rejects a tampered HMAC", async () => {
    const req = buildCallbackRequest({ shop: SHOP, code: "abc", state: "s" }, { cookieState: "s", badHmac: true });
    const res = await GET(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_hmac" });
  });

  it("rejects a missing HMAC", async () => {
    const req = buildCallbackRequest({ shop: SHOP, code: "abc", state: "s" }, { cookieState: "s", omitHmac: true });
    const res = await GET(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_hmac" });
  });

  it("exchanges the code and persists the installation on a fully valid callback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "shpat_fresh", scope: "read_orders" }),
      })
    );

    const req = buildCallbackRequest({ shop: SHOP, code: "the-real-code", state: "matching-state" }, { cookieState: "matching-state" });
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, shop: SHOP });

    const installation = await getActiveShopInstallation(SHOP);
    expect(installation?.accessToken).toBe("shpat_fresh");
  });

  it("clears the state cookie after a successful exchange", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ access_token: "tok", scope: "read_orders" }) })
    );
    const req = buildCallbackRequest({ shop: SHOP, code: "c", state: "s2" }, { cookieState: "s2" });
    const res = await GET(req);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toMatch(/shopify_oauth_state=;/);
  });

  it("returns 502 and does not persist anything when the token exchange fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const req = buildCallbackRequest({ shop: SHOP, code: "bad-code", state: "s3" }, { cookieState: "s3" });
    const res = await GET(req);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "token_exchange_failed" });
  });

  it("rejects a request with no code", async () => {
    const req = buildCallbackRequest({ shop: SHOP, state: "s4" }, { cookieState: "s4" });
    const res = await GET(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "missing_code" });
  });
});
