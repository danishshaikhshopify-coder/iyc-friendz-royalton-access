import { describe, it, expect } from "vitest";
import { recordWebhookEventOnce } from "@/lib/webhook-events";

describe("recordWebhookEventOnce — webhook idempotency", () => {
  it("returns true the first time a webhook id is seen", async () => {
    const result = await recordWebhookEventOnce(
      "test-shop.myshopify.com",
      `wh-${Date.now()}-a`,
      "orders/paid"
    );
    expect(result).toBe(true);
  });

  it("returns false for a duplicate delivery of the same webhook id (Shopify retry)", async () => {
    const webhookId = `wh-${Date.now()}-b`;
    const first = await recordWebhookEventOnce("test-shop.myshopify.com", webhookId, "orders/paid");
    const second = await recordWebhookEventOnce("test-shop.myshopify.com", webhookId, "orders/paid");
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("treats the same webhook id on a different shop as distinct", async () => {
    const webhookId = `wh-${Date.now()}-c`;
    const first = await recordWebhookEventOnce("shop-a.myshopify.com", webhookId, "orders/paid");
    const second = await recordWebhookEventOnce("shop-b.myshopify.com", webhookId, "orders/paid");
    expect(first).toBe(true);
    expect(second).toBe(true);
  });
});
