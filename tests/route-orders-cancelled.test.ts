/**
 * Route-level tests for the orders/cancelled webhook handler
 * (src/app/api/webhooks/orders-cancelled/route.ts). Calls the exported
 * POST handler directly with a constructed NextRequest — no running
 * server, no Admin API mock needed (this route revokes eagerly on a
 * verified webhook alone; see the route's own comment on why that's
 * safe — the App Proxy re-checks live on every access anyway).
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/webhooks/orders-cancelled/route";
import { createAccessGrant, findAccessGrantByOrder } from "@/lib/access-grants";

const WEBHOOK_SECRET = "test-webhook-secret"; // matches tests/setup.ts
const SHOP = "test-shop.myshopify.com";

let idCounter = 0;
function uniqueId(): string {
  idCounter += 1;
  return String(Date.now() * 1000 + idCounter);
}

function buildWebhookRequest(
  payload: Record<string, unknown>,
  opts: { webhookId: string; badHmac?: boolean }
): NextRequest {
  const rawBody = JSON.stringify(payload);
  const hmac = opts.badHmac
    ? "invalid=="
    : createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("base64");

  return new NextRequest("https://royalton-access.example/api/webhooks/orders-cancelled", {
    method: "POST",
    body: rawBody,
    headers: {
      "content-type": "application/json",
      "x-shopify-hmac-sha256": hmac,
      "x-shopify-shop-domain": SHOP,
      "x-shopify-webhook-id": opts.webhookId,
      "x-shopify-topic": "orders/cancelled",
    },
  });
}

describe("orders/cancelled webhook route", () => {
  it("rejects an invalid HMAC and revokes nothing", async () => {
    const orderId = uniqueId();
    await createAccessGrant({ shopDomain: SHOP, orderId, tokenHash: `hash-${orderId}` });

    const res = await POST(
      buildWebhookRequest({ id: Number(orderId) }, { webhookId: `wh-${orderId}`, badHmac: true })
    );
    expect(res.status).toBe(401);

    const grant = await findAccessGrantByOrder(SHOP, orderId);
    expect(grant?.revoked).toBe(false);
  });

  it("revokes an existing grant on a valid delivery", async () => {
    const orderId = uniqueId();
    await createAccessGrant({ shopDomain: SHOP, orderId, tokenHash: `hash-${orderId}` });

    const res = await POST(
      buildWebhookRequest({ id: Number(orderId) }, { webhookId: `wh-${orderId}` })
    );
    expect(res.status).toBe(200);

    const grant = await findAccessGrantByOrder(SHOP, orderId);
    expect(grant?.revoked).toBe(true);
    expect(grant?.revokedAt).not.toBeNull();
  });

  it("does not error when no grant exists for the cancelled order", async () => {
    const orderId = uniqueId();
    const res = await POST(
      buildWebhookRequest({ id: Number(orderId) }, { webhookId: `wh-${orderId}` })
    );
    expect(res.status).toBe(200);
  });

  it("is idempotent on a duplicate webhook id", async () => {
    const orderId = uniqueId();
    await createAccessGrant({ shopDomain: SHOP, orderId, tokenHash: `hash-${orderId}` });
    const webhookId = `wh-${orderId}`;
    const payload = { id: Number(orderId) };

    const first = await POST(buildWebhookRequest(payload, { webhookId }));
    const second = await POST(buildWebhookRequest(payload, { webhookId }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ duplicate: true });

    const grant = await findAccessGrantByOrder(SHOP, orderId);
    expect(grant?.revoked).toBe(true);
  });
});
