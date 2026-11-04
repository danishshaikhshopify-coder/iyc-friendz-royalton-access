/**
 * Route-level tests for OAuth initiation (src/app/api/auth/route.ts).
 */
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/auth/route";

const SHOP = "test-shop.myshopify.com"; // matches tests/setup.ts SHOPIFY_SHOP_DOMAIN

describe("OAuth initiation — GET /api/auth", () => {
  it("rejects a missing shop param", async () => {
    const req = new NextRequest("https://app.example.com/api/auth");
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("rejects a malformed shop domain", async () => {
    const req = new NextRequest("https://app.example.com/api/auth?shop=not-a-shop");
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("rejects a well-formed but unconfigured shop (not the single tenant this app serves)", async () => {
    const req = new NextRequest("https://app.example.com/api/auth?shop=someone-elses-shop.myshopify.com");
    const res = await GET(req);
    expect(res.status).toBe(403);
  });

  it("redirects to Shopify's authorize URL and sets a state cookie for the configured shop", async () => {
    const req = new NextRequest(`https://app.example.com/api/auth?shop=${SHOP}`);
    const res = await GET(req);
    expect(res.status).toBe(302);

    const location = res.headers.get("location");
    expect(location).toContain(`https://${SHOP}/admin/oauth/authorize`);
    expect(location).toContain("client_id=test-oauth-client-id");
    expect(location).toContain("scope=read_orders");
    expect(location).toContain(encodeURIComponent("https://app.example.com/api/auth/callback"));

    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("shopify_oauth_state=");
    expect(setCookie).toMatch(/HttpOnly/i);

    // The state embedded in the redirect URL must match the cookie value —
    // that equality is exactly what the callback checks later.
    const stateInUrl = new URL(location!).searchParams.get("state");
    expect(res.cookies.get("shopify_oauth_state")?.value).toBe(stateInUrl);
  });

  it("generates a different state on each call", async () => {
    const req1 = new NextRequest(`https://app.example.com/api/auth?shop=${SHOP}`);
    const req2 = new NextRequest(`https://app.example.com/api/auth?shop=${SHOP}`);
    const res1 = await GET(req1);
    const res2 = await GET(req2);
    const state1 = new URL(res1.headers.get("location")!).searchParams.get("state");
    const state2 = new URL(res2.headers.get("location")!).searchParams.get("state");
    expect(state1).not.toEqual(state2);
  });
});
