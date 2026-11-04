/**
 * Route-level tests for the app/uninstalled webhook
 * (src/app/api/webhooks/app-uninstalled/route.ts).
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/webhooks/app-uninstalled/route";
import { upsertShopInstallation, getActiveShopInstallation } from "@/lib/shop-installations";

const WEBHOOK_SECRET = "test-webhook-secret"; // matches tests/setup.ts

function uniqueShop(): string {
  return `shop-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`;
}

function buildRequest(shop: string, opts: { webhookId: string; badHmac?: boolean }): NextRequest {
  const rawBody = JSON.stringify({});
  const hmac = opts.badHmac
    ? "invalid=="
    : createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("base64");

  return new NextRequest("https://royalton-access.example/api/webhooks/app-uninstalled", {
    method: "POST",
    body: rawBody,
    headers: {
      "content-type": "application/json",
      "x-shopify-hmac-sha256": hmac,
      "x-shopify-shop-domain": shop,
      "x-shopify-webhook-id": opts.webhookId,
      "x-shopify-topic": "app/uninstalled",
    },
  });
}

describe("app/uninstalled webhook route", () => {
  it("rejects an invalid HMAC and revokes nothing", async () => {
    const shop = uniqueShop();
    await upsertShopInstallation({ shopDomain: shop, accessToken: "tok", refreshToken: null, scope: "read_orders", tokenExpiresAt: null });

    const res = await POST(buildRequest(shop, { webhookId: "wh-1", badHmac: true }));
    expect(res.status).toBe(401);
    expect(await getActiveShopInstallation(shop)).not.toBeNull();
  });

  it("revokes the shop's installation on a valid delivery", async () => {
    const shop = uniqueShop();
    await upsertShopInstallation({ shopDomain: shop, accessToken: "tok", refreshToken: null, scope: "read_orders", tokenExpiresAt: null });

    const res = await POST(buildRequest(shop, { webhookId: "wh-2" }));
    expect(res.status).toBe(200);
    expect(await getActiveShopInstallation(shop)).toBeNull();
  });

  it("is idempotent on a duplicate webhook id", async () => {
    const shop = uniqueShop();
    await upsertShopInstallation({ shopDomain: shop, accessToken: "tok", refreshToken: null, scope: "read_orders", tokenExpiresAt: null });

    const first = await POST(buildRequest(shop, { webhookId: "wh-3" }));
    const second = await POST(buildRequest(shop, { webhookId: "wh-3" }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ duplicate: true });
  });
});
