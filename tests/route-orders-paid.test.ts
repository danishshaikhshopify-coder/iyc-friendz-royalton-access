/**
 * Route-level tests for the orders/paid webhook handler
 * (src/app/api/webhooks/orders-paid/route.ts). Calls the exported POST
 * handler directly with a constructed NextRequest — no running server.
 * The Shopify Admin API client is mocked; HMAC verification, webhook
 * idempotency, and the access-grant creation/email-send flow all run for
 * real against the local test database.
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

// The route must not depend on "none" (the test env's default
// EMAIL_PROVIDER) ever reporting success — it no longer does, by design
// (see tests/email-provider.test.ts) — so the real send is mocked here,
// same as the Admin API above.
vi.mock("@/lib/email", () => ({
  sendAccessReadyEmail: vi.fn(),
}));

import { POST } from "@/app/api/webhooks/orders-paid/route";
import { shopifyAdminApiClient } from "@/lib/admin-api";
import { sendAccessReadyEmail } from "@/lib/email";
import { findAccessGrantByOrder } from "@/lib/access-grants";

const WEBHOOK_SECRET = "test-webhook-secret"; // matches tests/setup.ts
const SHOP = "test-shop.myshopify.com";

function buildWebhookRequest(
  payload: Record<string, unknown>,
  opts: { webhookId: string; badHmac?: boolean }
): NextRequest {
  const rawBody = JSON.stringify(payload);
  const hmac = opts.badHmac
    ? "invalid=="
    : createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("base64");

  return new NextRequest("https://royalton-access.example/api/webhooks/orders-paid", {
    method: "POST",
    body: rawBody,
    headers: {
      "content-type": "application/json",
      "x-shopify-hmac-sha256": hmac,
      "x-shopify-shop-domain": SHOP,
      "x-shopify-webhook-id": opts.webhookId,
      "x-shopify-topic": "orders/paid",
    },
  });
}

// Must stay within Number.MAX_SAFE_INTEGER, since the webhook payload
// carries `id` as a JSON number (as Shopify's real payloads do) and the
// route round-trips it through Number -> String.
let idCounter = 0;
function uniqueId(): string {
  idCounter += 1;
  return String(Date.now() * 1000 + idCounter);
}

function eligibleOrderData(orderId: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    orderGid: `gid://shopify/Order/${orderId}`,
    name: `#${orderId.slice(-4)}`,
    email: "customer@example.com",
    displayFinancialStatus: "PAID",
    cancelledAt: null,
    lineItems: [{ productHandle: "iyc-friendz-weekend-pass", quantity: 1 }],
    ...overrides,
  };
}

describe("orders/paid webhook route", () => {
  beforeEach(() => {
    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockReset();
    vi.mocked(sendAccessReadyEmail).mockReset();
    vi.mocked(sendAccessReadyEmail).mockResolvedValue({ success: true });
  });

  it("rejects a request with an invalid HMAC signature and creates no grant", async () => {
    const orderId = uniqueId();
    const req = buildWebhookRequest(
      { id: Number(orderId), email: "customer@example.com" },
      { webhookId: `wh-${orderId}`, badHmac: true }
    );
    const res = await POST(req);
    expect(res.status).toBe(401);

    const grant = await findAccessGrantByOrder(SHOP, orderId);
    expect(grant).toBeNull();
  });

  it("creates a grant and marks the email sent for a live-eligible paid order", async () => {
    const orderId = uniqueId();
    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockResolvedValue(
      eligibleOrderData(orderId)
    );

    const req = buildWebhookRequest(
      { id: Number(orderId), email: "customer@example.com", name: "#1234" },
      { webhookId: `wh-${orderId}` }
    );
    const res = await POST(req);
    expect(res.status).toBe(200);

    const grant = await findAccessGrantByOrder(SHOP, orderId);
    expect(grant).not.toBeNull();
    expect(grant?.emailSent).toBe(true);
  });

  it("creates no grant for an order that is live-ineligible (unrelated product)", async () => {
    const orderId = uniqueId();
    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockResolvedValue({
      ...eligibleOrderData(orderId),
      lineItems: [{ productHandle: "some-other-product", quantity: 1 }],
    });

    const req = buildWebhookRequest(
      { id: Number(orderId), email: "customer@example.com" },
      { webhookId: `wh-${orderId}` }
    );
    await POST(req);

    const grant = await findAccessGrantByOrder(SHOP, orderId);
    expect(grant).toBeNull();
  });

  it("does not create a second grant or call the Admin API again on a duplicate webhook delivery (same webhook id)", async () => {
    const orderId = uniqueId();
    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockResolvedValue(
      eligibleOrderData(orderId)
    );
    const webhookId = `wh-${orderId}`;
    const payload = { id: Number(orderId), email: "customer@example.com" };

    const first = await POST(buildWebhookRequest(payload, { webhookId }));
    const second = await POST(buildWebhookRequest(payload, { webhookId }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ duplicate: true });

    // Only processed once — the Admin API call (and therefore the
    // eligibility check + grant creation) happened exactly once.
    expect(shopifyAdminApiClient.fetchOrderEligibilityData).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION: a failed delivery (handler throws) is retried and succeeds when Shopify redelivers the same webhook id", async () => {
    // Reproduces the Task 19 live-QA incident: the Admin API call failed
    // (there, a missing read_products scope) on the first delivery, and
    // Shopify's automatic retry reused the same X-Shopify-Webhook-Id. The
    // retry must be reprocessed, not silently skipped as a duplicate of a
    // delivery that never actually succeeded.
    const orderId = uniqueId();
    const webhookId = `wh-${orderId}`;
    const payload = { id: Number(orderId), email: "customer@example.com" };

    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockRejectedValueOnce(
      new Error("Shopify Admin API GraphQL errors: Access denied for product field. Required access: `read_products` access scope.")
    );
    const first = await POST(buildWebhookRequest(payload, { webhookId }));
    expect(first.status).toBe(500);

    const grantAfterFailure = await findAccessGrantByOrder(SHOP, orderId);
    expect(grantAfterFailure).toBeNull();

    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockResolvedValueOnce(
      eligibleOrderData(orderId)
    );
    const retry = await POST(buildWebhookRequest(payload, { webhookId }));
    expect(retry.status).toBe(200);
    expect(await retry.json()).not.toMatchObject({ duplicate: true });

    const grantAfterRetry = await findAccessGrantByOrder(SHOP, orderId);
    expect(grantAfterRetry).not.toBeNull();
    expect(grantAfterRetry?.emailSent).toBe(true);

    // The Admin API was actually called on both attempts — the retry was
    // genuinely reprocessed, not skipped.
    expect(shopifyAdminApiClient.fetchOrderEligibilityData).toHaveBeenCalledTimes(2);
  });

  it("REGRESSION: a duplicate delivery of an already-SUCCEEDED webhook is skipped without calling the Admin API again", async () => {
    const orderId = uniqueId();
    const webhookId = `wh-${orderId}`;
    const payload = { id: Number(orderId), email: "customer@example.com" };

    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockResolvedValue(
      eligibleOrderData(orderId)
    );
    const first = await POST(buildWebhookRequest(payload, { webhookId }));
    expect(first.status).toBe(200);
    const grantAfterFirst = await findAccessGrantByOrder(SHOP, orderId);
    expect(grantAfterFirst).not.toBeNull();

    const duplicate = await POST(buildWebhookRequest(payload, { webhookId }));
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ duplicate: true });

    const grantAfterDuplicate = await findAccessGrantByOrder(SHOP, orderId);
    // Same grant — not re-minted.
    expect(grantAfterDuplicate?.tokenHash).toEqual(grantAfterFirst?.tokenHash);
    expect(shopifyAdminApiClient.fetchOrderEligibilityData).toHaveBeenCalledTimes(1);
  });

  it("does not mint a second token/email if a grant already exists for the order (idempotent even with a different webhook id)", async () => {
    const orderId = uniqueId();
    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockResolvedValue(
      eligibleOrderData(orderId)
    );
    const payload = { id: Number(orderId), email: "customer@example.com" };

    await POST(buildWebhookRequest(payload, { webhookId: `wh-${orderId}-a` }));
    const firstGrant = await findAccessGrantByOrder(SHOP, orderId);

    await POST(buildWebhookRequest(payload, { webhookId: `wh-${orderId}-b` }));
    const secondGrant = await findAccessGrantByOrder(SHOP, orderId);

    expect(firstGrant?.tokenHash).toEqual(secondGrant?.tokenHash);
  });

  it("REGRESSION: records a genuine email failure (not emailSent) when the provider rejects the send, so it stays eligible for retry", async () => {
    const orderId = uniqueId();
    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockResolvedValue(
      eligibleOrderData(orderId)
    );
    vi.mocked(sendAccessReadyEmail).mockResolvedValue({
      success: false,
      error: "Omnisend API 422: invalid event payload",
    });

    const res = await POST(
      buildWebhookRequest(
        { id: Number(orderId), email: "customer@example.com" },
        { webhookId: `wh-${orderId}` }
      )
    );
    expect(res.status).toBe(200); // webhook is still acknowledged — grant creation succeeded

    const grant = await findAccessGrantByOrder(SHOP, orderId);
    expect(grant?.emailSent).toBe(false);
    expect(grant?.emailStatus).toBe("failed");
    expect(grant?.emailLastError).toMatch(/invalid event payload/);
  });

  it("REGRESSION: an eligible order with no email on the Shopify order record is recorded as a visible failure, not silently left unsent", async () => {
    const orderId = uniqueId();
    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockResolvedValue(
      eligibleOrderData(orderId, { email: null })
    );

    const res = await POST(
      buildWebhookRequest(
        { id: Number(orderId), email: "customer@example.com" },
        { webhookId: `wh-${orderId}` }
      )
    );
    expect(res.status).toBe(200); // webhook is still acknowledged — grant creation succeeded
    expect(sendAccessReadyEmail).not.toHaveBeenCalled();

    const grant = await findAccessGrantByOrder(SHOP, orderId);
    expect(grant).not.toBeNull();
    expect(grant?.emailSent).toBe(false);
    expect(grant?.emailStatus).toBe("failed");
    expect(grant?.emailLastError).toMatch(/no email on shopify order/i);
  });

  it("sends to the live Shopify order's own email (fetched for the eligibility check), not whatever the webhook payload's own email/contact_email field says", async () => {
    const orderId = uniqueId();
    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockResolvedValue(
      eligibleOrderData(orderId, { email: "current-shopify-order-email@example.com" })
    );

    await POST(
      buildWebhookRequest(
        { id: Number(orderId), email: "stale-webhook-payload-email@example.com" },
        { webhookId: `wh-${orderId}` }
      )
    );

    const [to] = vi.mocked(sendAccessReadyEmail).mock.calls[0]!;
    expect(to).toBe("current-shopify-order-email@example.com");
  });
});
