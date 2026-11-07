/**
 * Route-level tests for the App Proxy access route
 * (src/app/apps/royalton-access/route.ts), calling the exported GET
 * handler directly with constructed NextRequest objects — no running
 * server needed. The Shopify Admin API client is mocked (vi.mock) so
 * these tests control the "live" order data without any network call;
 * everything else (signature verification, rate limiting, token lookup,
 * eligibility logic, HTML rendering) runs for real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";

vi.mock("@/lib/admin-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/admin-api")>(
    "@/lib/admin-api"
  );
  return {
    ...actual,
    shopifyAdminApiClient: {
      fetchOrderEligibilityData: vi.fn(),
    },
  };
});

// Both wrapped functions default to their REAL implementation (the real
// DB-backed rate limiter / grant lookup) for every test — only the two
// DB-failure tests below override them, via mockRejectedValueOnce, which
// reverts to the wrapped default on the very next call automatically.
vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>(
    "@/lib/rate-limit"
  );
  return { ...actual, checkRateLimit: vi.fn(actual.checkRateLimit) };
});

vi.mock("@/lib/access-grants", async () => {
  const actual = await vi.importActual<typeof import("@/lib/access-grants")>(
    "@/lib/access-grants"
  );
  return { ...actual, findAccessGrantByTokenHash: vi.fn(actual.findAccessGrantByTokenHash) };
});

import { GET } from "@/app/apps/royalton-access/route";
import { shopifyAdminApiClient, AdminApiError } from "@/lib/admin-api";
import {
  createAccessGrant,
  findAccessGrantByOrder,
  findAccessGrantByTokenHash,
} from "@/lib/access-grants";
import { generateAccessToken, hashToken } from "@/lib/token";
import { checkRateLimit, _resetRateLimitStateForTests } from "@/lib/rate-limit";

const PROXY_SECRET = "test-app-proxy-secret"; // matches tests/setup.ts
const SHOP = "test-shop.myshopify.com"; // matches tests/setup.ts SHOPIFY_SHOP_DOMAIN
const TOKEN_SECRET = "test-token-signing-secret"; // matches tests/setup.ts

function signParams(params: Record<string, string>, secret: string): string {
  const sortedKeys = Object.keys(params).sort();
  const message = sortedKeys.map((k) => `${k}=${params[k]}`).join("");
  return createHmac("sha256", secret).update(message).digest("hex");
}

function buildProxyRequest(
  params: Record<string, string>,
  opts: { badSignature?: boolean; omitSignature?: boolean } = {}
): NextRequest {
  const url = new URL("https://test-shop.example.com/apps/royalton-access");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  if (!opts.omitSignature) {
    const signature = opts.badSignature
      ? "0".repeat(64)
      : signParams(params, PROXY_SECRET);
    url.searchParams.set("signature", signature);
  }

  return new NextRequest(url.toString());
}

async function createGrantWithToken(orderId: string) {
  const rawToken = generateAccessToken();
  const tokenHash = hashToken(rawToken, TOKEN_SECRET);
  await createAccessGrant({ shopDomain: SHOP, orderId, tokenHash });
  return rawToken;
}

function uniqueOrderId(): string {
  return `proxy-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("App Proxy access route — GET /apps/royalton-access", () => {
  beforeEach(() => {
    _resetRateLimitStateForTests();
    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockReset();
  });

  it("rejects a request with no signature at all", async () => {
    const req = buildProxyRequest({ shop: SHOP, token: "x" }, { omitSignature: true });
    const res = await GET(req);
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain("LINK NOT AVAILABLE");
  });

  it("rejects a tampered/bad App Proxy signature", async () => {
    const req = buildProxyRequest({ shop: SHOP, token: "x" }, { badSignature: true });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("rejects a request with a valid signature but a mismatched shop param", async () => {
    const req = buildProxyRequest({ shop: "someone-elses-shop.myshopify.com", token: "x" });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("rejects a request with no token param", async () => {
    const req = buildProxyRequest({ shop: SHOP });
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("rejects an unknown token", async () => {
    const req = buildProxyRequest({ shop: SHOP, token: "a-token-that-was-never-issued" });
    const res = await GET(req);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain("LINK NOT AVAILABLE");
  });

  it("rejects a revoked token even if it was once valid", async () => {
    const orderId = uniqueOrderId();
    const rawToken = await createGrantWithToken(orderId);
    const { revokeAccessGrantForOrder } = await import("@/lib/access-grants");
    await revokeAccessGrantForOrder(SHOP, orderId);

    const req = buildProxyRequest({ shop: SHOP, token: rawToken });
    const res = await GET(req);
    expect(res.status).toBe(403);
  });

  it("grants access (minus the real URL, which isn't configured) for a live-eligible order", async () => {
    const orderId = uniqueOrderId();
    const rawToken = await createGrantWithToken(orderId);

    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockResolvedValue({
      orderGid: `gid://shopify/Order/${orderId}`,
      name: "#9001",
      displayFinancialStatus: "PAID",
      cancelledAt: null,
      lineItems: [{ productHandle: "iyc-friendz-weekend-pass", quantity: 1 }],
    });

    const req = buildProxyRequest({ shop: SHOP, token: rawToken });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.text();
    // ROYALTON_BOOKING_URL is unset in the test environment (by design —
    // see tests/setup.ts), so this must be the "almost ready" state, not
    // a fabricated booking link.
    expect(body).toContain("ALMOST READY");
    expect(body).not.toMatch(/href="https?:\/\//);
  });

  it("denies and auto-revokes a previously-valid token when the order is now ineligible (e.g. cancelled after the fact)", async () => {
    const orderId = uniqueOrderId();
    const rawToken = await createGrantWithToken(orderId);

    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockResolvedValue({
      orderGid: `gid://shopify/Order/${orderId}`,
      name: "#9002",
      displayFinancialStatus: "PAID",
      cancelledAt: "2026-01-01T00:00:00Z", // cancelled since the token was issued
      lineItems: [{ productHandle: "iyc-friendz-weekend-pass", quantity: 1 }],
    });

    const req = buildProxyRequest({ shop: SHOP, token: rawToken });
    const res = await GET(req);
    expect(res.status).toBe(403);

    const grant = await findAccessGrantByOrder(SHOP, orderId);
    expect(grant?.revoked).toBe(true);
  });

  it("fails closed (denies) when the live Admin API call errors", async () => {
    const orderId = uniqueOrderId();
    const rawToken = await createGrantWithToken(orderId);

    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockRejectedValue(
      new AdminApiError("simulated network timeout")
    );

    const req = buildProxyRequest({ shop: SHOP, token: rawToken });
    const res = await GET(req);
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain("SOMETHING WENT WRONG");
  });

  it("rate-limits repeated requests for the same token from the same IP", async () => {
    const orderId = uniqueOrderId();
    const rawToken = await createGrantWithToken(orderId);
    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockResolvedValue({
      orderGid: `gid://shopify/Order/${orderId}`,
      name: "#9003",
      displayFinancialStatus: "PAID",
      cancelledAt: null,
      lineItems: [{ productHandle: "iyc-friendz-weekend-pass", quantity: 1 }],
    });

    const req = () => buildProxyRequest({ shop: SHOP, token: rawToken });
    let lastStatus = 200;
    for (let i = 0; i < 25; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await GET(req());
      lastStatus = res.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });

  it("REGRESSION: fails OPEN (does not 500) when the rate-limit store itself errors, e.g. a missing table", async () => {
    const orderId = uniqueOrderId();
    const rawToken = await createGrantWithToken(orderId);
    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockResolvedValue({
      orderGid: `gid://shopify/Order/${orderId}`,
      name: "#9004",
      displayFinancialStatus: "PAID",
      cancelledAt: null,
      lineItems: [{ productHandle: "iyc-friendz-weekend-pass", quantity: 1 }],
    });
    vi.mocked(checkRateLimit).mockRejectedValueOnce(new Error("no such table: rate_limit_buckets"));

    const req = buildProxyRequest({ shop: SHOP, token: rawToken });
    const res = await GET(req);
    // The real access-control decision (step 3) still runs and passes —
    // a rate-limit-store outage must not become a customer-facing outage.
    expect(res.status).toBe(200);
  });

  it("REGRESSION: fails CLOSED (502, branded error page, not an unhandled 500) when the grant lookup itself errors", async () => {
    const orderId = uniqueOrderId();
    const rawToken = await createGrantWithToken(orderId);
    vi.mocked(findAccessGrantByTokenHash).mockRejectedValueOnce(
      new Error("simulated Turso connection error")
    );

    const req = buildProxyRequest({ shop: SHOP, token: rawToken });
    const res = await GET(req);
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain("SOMETHING WENT WRONG");
  });
});
