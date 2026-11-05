import { describe, it, expect } from "vitest";
import {
  claimWebhookEvent,
  markWebhookEventCompleted,
  markWebhookEventFailed,
} from "@/lib/webhook-events";

const SHOP = "test-shop.myshopify.com";

function uniqueWebhookId(suffix: string): string {
  return `wh-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}`;
}

describe("claimWebhookEvent — webhook idempotency", () => {
  it("claims a brand-new webhook id", async () => {
    const result = await claimWebhookEvent(SHOP, uniqueWebhookId("a"), "orders/paid");
    expect(result).toBe("claimed");
  });

  it("treats a retry of an already-COMPLETED delivery as a true duplicate", async () => {
    const webhookId = uniqueWebhookId("b");
    const first = await claimWebhookEvent(SHOP, webhookId, "orders/paid");
    expect(first).toBe("claimed");
    await markWebhookEventCompleted(SHOP, webhookId);

    const retry = await claimWebhookEvent(SHOP, webhookId, "orders/paid");
    expect(retry).toBe("duplicate");
  });

  it("REGRESSION: a retry of a FAILED delivery is reclaimed for processing, not skipped as a duplicate", async () => {
    // This is the exact bug found during Task 19 live QA: a handler error
    // on the first delivery must not permanently block Shopify's retry
    // (which reuses the same webhook_id) from ever being reprocessed.
    const webhookId = uniqueWebhookId("c");
    const first = await claimWebhookEvent(SHOP, webhookId, "orders/paid");
    expect(first).toBe("claimed");
    await markWebhookEventFailed(SHOP, webhookId);

    const retry = await claimWebhookEvent(SHOP, webhookId, "orders/paid");
    expect(retry).toBe("claimed");

    // And once that retry succeeds, a further delivery is a real duplicate.
    await markWebhookEventCompleted(SHOP, webhookId);
    const thirdDelivery = await claimWebhookEvent(SHOP, webhookId, "orders/paid");
    expect(thirdDelivery).toBe("duplicate");
  });

  it("a failed delivery can fail again on a second retry and still be reclaimable on a third", async () => {
    const webhookId = uniqueWebhookId("d");
    expect(await claimWebhookEvent(SHOP, webhookId, "orders/paid")).toBe("claimed");
    await markWebhookEventFailed(SHOP, webhookId);

    expect(await claimWebhookEvent(SHOP, webhookId, "orders/paid")).toBe("claimed");
    await markWebhookEventFailed(SHOP, webhookId);

    expect(await claimWebhookEvent(SHOP, webhookId, "orders/paid")).toBe("claimed");
  });

  it("treats the same webhook id on a different shop as distinct", async () => {
    const webhookId = uniqueWebhookId("e");
    const first = await claimWebhookEvent("shop-a.myshopify.com", webhookId, "orders/paid");
    const second = await claimWebhookEvent("shop-b.myshopify.com", webhookId, "orders/paid");
    expect(first).toBe("claimed");
    expect(second).toBe("claimed");
  });

  it("CONCURRENCY: only one of two simultaneous claims for the same new webhook id wins", async () => {
    const webhookId = uniqueWebhookId("f");
    const [a, b] = await Promise.all([
      claimWebhookEvent(SHOP, webhookId, "orders/paid"),
      claimWebhookEvent(SHOP, webhookId, "orders/paid"),
    ]);
    const outcomes = [a, b].sort();
    // Exactly one "claimed"; the other must NOT also be "claimed" (that
    // would mean both callers would proceed to process the same delivery).
    expect(outcomes.filter((o) => o === "claimed")).toHaveLength(1);
    expect(outcomes).toContain("in_progress");
  });

  it("CONCURRENCY: a still-in-flight (non-stale) processing row is not reclaimed by a concurrent delivery", async () => {
    const webhookId = uniqueWebhookId("g");
    expect(await claimWebhookEvent(SHOP, webhookId, "orders/paid")).toBe("claimed");
    // Simulate a second, genuinely concurrent delivery arriving while the
    // first is still being handled (not yet completed or failed).
    const concurrent = await claimWebhookEvent(SHOP, webhookId, "orders/paid");
    expect(concurrent).toBe("in_progress");
  });
});
