/**
 * Route-level tests for the refunds/create webhook handler
 * (src/app/api/webhooks/refunds-create/route.ts). Calls the exported POST
 * handler directly with a constructed NextRequest. The Admin API client
 * is mocked — the route always re-checks live eligibility rather than
 * trusting the refund payload itself, since a single refund event can't
 * tell you the order's resulting net financial status on its own.
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

import { POST } from "@/app/api/webhooks/refunds-create/route";
import { shopifyAdminApiClient } from "@/lib/admin-api";
import { createAccessGrant, findAccessGrantByOrder } from "@/lib/access-grants";

const WEBHOOK_SECRET = "test-webhook-secret"; // matches tests/setup.ts
const SHOP = "test-shop.myshopify.com";

let idCounter = 0;
function uniqueId(): string {
  idCounter += 1;
  return String(Date.now() * 1000 + idCounter);
}

function orderData(orderId: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    orderGid: `gid://shopify/Order/${orderId}`,
    name: `#${orderId.slice(-4)}`,
    displayFinancialStatus: "PAID",
    cancelledAt: null,
    lineItems: [{ productHandle: "iyc-friendz-weekend-pass", quantity: 1 }],
    ...overrides,
  };
}

function buildWebhookRequest(
  payload: Record<string, unknown>,
  opts: { webhookId: string; badHmac?: boolean }
): NextRequest {
  const rawBody = JSON.stringify(payload);
  const hmac = opts.badHmac
    ? "invalid=="
    : createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("base64");

  return new NextRequest("https://royalton-access.example/api/webhooks/refunds-create", {
    method: "POST",
    body: rawBody,
    headers: {
      "content-type": "application/json",
      "x-shopify-hmac-sha256": hmac,
      "x-shopify-shop-domain": SHOP,
      "x-shopify-webhook-id": opts.webhookId,
      "x-shopify-topic": "refunds/create",
    },
  });
}

describe("refunds/create webhook route", () => {
  beforeEach(() => {
    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockReset();
  });

  it("rejects an invalid HMAC, revokes nothing, and never calls the Admin API", async () => {
    const orderId = uniqueId();
    await createAccessGrant({ shopDomain: SHOP, orderId, tokenHash: `hash-${orderId}` });

    const res = await POST(
      buildWebhookRequest({ order_id: Number(orderId) }, { webhookId: `wh-${orderId}`, badHmac: true })
    );
    expect(res.status).toBe(401);
    expect(shopifyAdminApiClient.fetchOrderEligibilityData).not.toHaveBeenCalled();

    const grant = await findAccessGrantByOrder(SHOP, orderId);
    expect(grant?.revoked).toBe(false);
  });

  it("does not error and skips processing when the payload has no order_id", async () => {
    const res = await POST(
      buildWebhookRequest({ id: 999 }, { webhookId: `wh-${uniqueId()}` })
    );
    expect(res.status).toBe(200);
    expect(shopifyAdminApiClient.fetchOrderEligibilityData).not.toHaveBeenCalled();
  });

  it("revokes the grant when a full refund makes the order ineligible", async () => {
    const orderId = uniqueId();
    await createAccessGrant({ shopDomain: SHOP, orderId, tokenHash: `hash-${orderId}` });
    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockResolvedValue(
      orderData(orderId, { displayFinancialStatus: "REFUNDED" })
    );

    const res = await POST(
      buildWebhookRequest({ order_id: Number(orderId) }, { webhookId: `wh-${orderId}` })
    );
    expect(res.status).toBe(200);

    const grant = await findAccessGrantByOrder(SHOP, orderId);
    expect(grant?.revoked).toBe(true);
  });

  it("revokes the grant for a partial refund under the default deny policy", async () => {
    const orderId = uniqueId();
    await createAccessGrant({ shopDomain: SHOP, orderId, tokenHash: `hash-${orderId}` });
    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockResolvedValue(
      orderData(orderId, { displayFinancialStatus: "PARTIALLY_REFUNDED" })
    );

    await POST(buildWebhookRequest({ order_id: Number(orderId) }, { webhookId: `wh-${orderId}` }));

    const grant = await findAccessGrantByOrder(SHOP, orderId);
    expect(grant?.revoked).toBe(true);
  });

  it("does not revoke when the order is still eligible after the refund event", async () => {
    const orderId = uniqueId();
    await createAccessGrant({ shopDomain: SHOP, orderId, tokenHash: `hash-${orderId}` });
    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockResolvedValue(
      orderData(orderId, { displayFinancialStatus: "PAID" })
    );

    await POST(buildWebhookRequest({ order_id: Number(orderId) }, { webhookId: `wh-${orderId}` }));

    const grant = await findAccessGrantByOrder(SHOP, orderId);
    expect(grant?.revoked).toBe(false);
  });

  it("does not error when no grant exists for the refunded order", async () => {
    const orderId = uniqueId();
    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockResolvedValue(
      orderData(orderId, { displayFinancialStatus: "REFUNDED" })
    );

    const res = await POST(
      buildWebhookRequest({ order_id: Number(orderId) }, { webhookId: `wh-${orderId}` })
    );
    expect(res.status).toBe(200);
  });

  it("is idempotent on a duplicate webhook id (Admin API called only once)", async () => {
    const orderId = uniqueId();
    await createAccessGrant({ shopDomain: SHOP, orderId, tokenHash: `hash-${orderId}` });
    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockResolvedValue(
      orderData(orderId, { displayFinancialStatus: "REFUNDED" })
    );
    const webhookId = `wh-${orderId}`;
    const payload = { order_id: Number(orderId) };

    const first = await POST(buildWebhookRequest(payload, { webhookId }));
    const second = await POST(buildWebhookRequest(payload, { webhookId }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ duplicate: true });
    expect(shopifyAdminApiClient.fetchOrderEligibilityData).toHaveBeenCalledTimes(1);
  });
});
