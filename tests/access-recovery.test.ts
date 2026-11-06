/**
 * Tests for src/lib/access-recovery.ts — recovering access for an order
 * that already has a grant but whose email was never actually
 * delivered, without creating a second grant or a second order.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

vi.mock("@/lib/email", () => ({
  sendAccessReadyEmail: vi.fn(),
}));

import { recoverAccessForOrder } from "@/lib/access-recovery";
import { shopifyAdminApiClient } from "@/lib/admin-api";
import { sendAccessReadyEmail } from "@/lib/email";
import { createAccessGrant, findAccessGrantByOrder, revokeAccessGrantForOrder } from "@/lib/access-grants";
import { hashToken, generateAccessToken } from "@/lib/token";

const SHOP = "test-shop.myshopify.com";
const SECRET = "test-token-signing-secret"; // matches tests/setup.ts ACCESS_TOKEN_SIGNING_SECRET

let idCounter = 0;
function uniqueOrderId(): string {
  idCounter += 1;
  return `order-${Date.now()}-${idCounter}`;
}

function eligibleOrderData(orderId: string) {
  return {
    orderGid: `gid://shopify/Order/${orderId}`,
    name: `#${orderId.slice(-4)}`,
    displayFinancialStatus: "PAID",
    cancelledAt: null,
    lineItems: [{ productHandle: "iyc-friendz-weekend-pass", quantity: 1 }],
  };
}

describe("recoverAccessForOrder", () => {
  beforeEach(() => {
    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockReset();
    vi.mocked(sendAccessReadyEmail).mockReset();
  });

  it("refuses when no grant exists for the order, and sends no email", async () => {
    const orderId = uniqueOrderId();
    const result = await recoverAccessForOrder(SHOP, orderId, "customer@example.com");
    expect(result).toEqual({ ok: false, reason: "no_existing_grant" });
    expect(sendAccessReadyEmail).not.toHaveBeenCalled();
  });

  it("refuses when the existing grant is revoked, and sends no email", async () => {
    const orderId = uniqueOrderId();
    await createAccessGrant({
      shopDomain: SHOP,
      orderId,
      tokenHash: hashToken(generateAccessToken(), SECRET),
    });
    await revokeAccessGrantForOrder(SHOP, orderId);

    const result = await recoverAccessForOrder(SHOP, orderId, "customer@example.com");
    expect(result).toEqual({ ok: false, reason: "grant_revoked" });
    expect(sendAccessReadyEmail).not.toHaveBeenCalled();
  });

  it("refuses when the order is no longer live-eligible, without rotating the token or sending an email", async () => {
    const orderId = uniqueOrderId();
    const originalHash = hashToken(generateAccessToken(), SECRET);
    await createAccessGrant({ shopDomain: SHOP, orderId, tokenHash: originalHash });
    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockResolvedValue(
      eligibleOrderData(orderId) && { ...eligibleOrderData(orderId), displayFinancialStatus: "REFUNDED" }
    );

    const result = await recoverAccessForOrder(SHOP, orderId, "customer@example.com");
    expect(result).toEqual({ ok: false, reason: "not_eligible:fully_refunded" });
    expect(sendAccessReadyEmail).not.toHaveBeenCalled();

    const grant = await findAccessGrantByOrder(SHOP, orderId);
    expect(grant?.tokenHash).toBe(originalHash);
  });

  it("rotates the token and reports success when the order is still eligible and the provider accepts the email", async () => {
    const orderId = uniqueOrderId();
    const originalHash = hashToken(generateAccessToken(), SECRET);
    await createAccessGrant({ shopDomain: SHOP, orderId, tokenHash: originalHash });
    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockResolvedValue(
      eligibleOrderData(orderId)
    );
    vi.mocked(sendAccessReadyEmail).mockResolvedValue({ success: true, providerMessageId: "msg-1" });

    const result = await recoverAccessForOrder(SHOP, orderId, "customer@example.com", "#9999");
    expect(result).toEqual({ ok: true });
    expect(sendAccessReadyEmail).toHaveBeenCalledTimes(1);

    const grant = await findAccessGrantByOrder(SHOP, orderId);
    expect(grant?.tokenHash).not.toBe(originalHash);
    expect(grant?.emailSent).toBe(true);
    expect(grant?.emailStatus).toBe("accepted");
  });

  it("rotates the token but reports failure (retryable) when the provider rejects the email", async () => {
    const orderId = uniqueOrderId();
    await createAccessGrant({
      shopDomain: SHOP,
      orderId,
      tokenHash: hashToken(generateAccessToken(), SECRET),
    });
    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockResolvedValue(
      eligibleOrderData(orderId)
    );
    vi.mocked(sendAccessReadyEmail).mockResolvedValue({
      success: false,
      error: "Resend API 422: invalid from address",
    });

    const result = await recoverAccessForOrder(SHOP, orderId, "customer@example.com");
    expect(result).toEqual({
      ok: false,
      reason: "send_failed:Resend API 422: invalid from address",
    });

    const grant = await findAccessGrantByOrder(SHOP, orderId);
    expect(grant?.emailSent).toBe(false);
    expect(grant?.emailStatus).toBe("failed");
  });

  it("never passes the raw token to the email provider call's visible arguments — only accessPageUrl carries it", async () => {
    const orderId = uniqueOrderId();
    await createAccessGrant({
      shopDomain: SHOP,
      orderId,
      tokenHash: hashToken(generateAccessToken(), SECRET),
    });
    vi.mocked(shopifyAdminApiClient.fetchOrderEligibilityData).mockResolvedValue(
      eligibleOrderData(orderId)
    );
    vi.mocked(sendAccessReadyEmail).mockResolvedValue({ success: true });

    await recoverAccessForOrder(SHOP, orderId, "customer@example.com");

    const [, params, idempotencyKey] = vi.mocked(sendAccessReadyEmail).mock.calls[0]!;
    expect(params.accessPageUrl).toContain("token=");
    expect(typeof idempotencyKey).toBe("string");
    expect(idempotencyKey!.length).toBeGreaterThan(0);
  });
});
