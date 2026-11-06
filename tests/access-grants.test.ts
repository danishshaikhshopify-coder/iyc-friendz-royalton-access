import { describe, it, expect } from "vitest";
import {
  createAccessGrant,
  findAccessGrantByOrder,
  findAccessGrantByTokenHash,
  revokeAccessGrantForOrder,
  markAccessGrantEmailSent,
  markAccessGrantEmailFailed,
  rotateAccessGrantToken,
} from "@/lib/access-grants";
import { generateAccessToken, hashToken } from "@/lib/token";

const SHOP = "test-shop.myshopify.com";
const SECRET = "test-token-signing-secret";

function uniqueOrderId(): string {
  return `order-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("access grants data access", () => {
  it("creates a grant and can look it up by order and by token hash", async () => {
    const orderId = uniqueOrderId();
    const rawToken = generateAccessToken();
    const tokenHash = hashToken(rawToken, SECRET);

    const created = await createAccessGrant({ shopDomain: SHOP, orderId, tokenHash });
    expect(created.revoked).toBe(false);
    expect(created.emailSent).toBe(false);

    const byOrder = await findAccessGrantByOrder(SHOP, orderId);
    expect(byOrder?.tokenHash).toEqual(tokenHash);

    const byHash = await findAccessGrantByTokenHash(tokenHash);
    expect(byHash?.orderId).toEqual(orderId);
  });

  it("returns null for an order with no grant", async () => {
    const result = await findAccessGrantByOrder(SHOP, uniqueOrderId());
    expect(result).toBeNull();
  });

  it("rejects creating a second grant for the same order (unique constraint)", async () => {
    const orderId = uniqueOrderId();
    const tokenHash1 = hashToken(generateAccessToken(), SECRET);
    const tokenHash2 = hashToken(generateAccessToken(), SECRET);

    await createAccessGrant({ shopDomain: SHOP, orderId, tokenHash: tokenHash1 });
    await expect(
      createAccessGrant({ shopDomain: SHOP, orderId, tokenHash: tokenHash2 })
    ).rejects.toThrow();
  });

  it("revokes a grant, and the revoked grant no longer verifies as active", async () => {
    const orderId = uniqueOrderId();
    const tokenHash = hashToken(generateAccessToken(), SECRET);
    await createAccessGrant({ shopDomain: SHOP, orderId, tokenHash });

    await revokeAccessGrantForOrder(SHOP, orderId);

    const grant = await findAccessGrantByOrder(SHOP, orderId);
    expect(grant?.revoked).toBe(true);
    expect(grant?.revokedAt).not.toBeNull();
  });

  it("marks email as sent", async () => {
    const orderId = uniqueOrderId();
    const tokenHash = hashToken(generateAccessToken(), SECRET);
    await createAccessGrant({ shopDomain: SHOP, orderId, tokenHash });

    expect((await findAccessGrantByOrder(SHOP, orderId))?.emailStatus).toBe("not_sent");

    await markAccessGrantEmailSent(SHOP, orderId);

    const grant = await findAccessGrantByOrder(SHOP, orderId);
    expect(grant?.emailSent).toBe(true);
    expect(grant?.emailSentAt).not.toBeNull();
    expect(grant?.emailStatus).toBe("accepted");
    expect(grant?.emailAttempts).toBe(1);
  });

  it("REGRESSION: marks a genuine send failure without marking emailSent, so it stays eligible for retry", async () => {
    const orderId = uniqueOrderId();
    const tokenHash = hashToken(generateAccessToken(), SECRET);
    await createAccessGrant({ shopDomain: SHOP, orderId, tokenHash });

    await markAccessGrantEmailFailed(SHOP, orderId, "Resend API 422: invalid from address");

    const grant = await findAccessGrantByOrder(SHOP, orderId);
    expect(grant?.emailSent).toBe(false);
    expect(grant?.emailStatus).toBe("failed");
    expect(grant?.emailAttempts).toBe(1);
    expect(grant?.emailLastError).toMatch(/invalid from address/);
  });

  it("rotateAccessGrantToken replaces the token hash and resets email status for the fresh token", async () => {
    const orderId = uniqueOrderId();
    const originalHash = hashToken(generateAccessToken(), SECRET);
    await createAccessGrant({ shopDomain: SHOP, orderId, tokenHash: originalHash });
    await markAccessGrantEmailFailed(SHOP, orderId, "simulated prior failure");

    const newHash = hashToken(generateAccessToken(), SECRET);
    await rotateAccessGrantToken(SHOP, orderId, newHash);

    const grant = await findAccessGrantByOrder(SHOP, orderId);
    expect(grant?.tokenHash).toBe(newHash);
    expect(grant?.emailStatus).toBe("not_sent");
    expect(grant?.emailLastError).toBeNull();
    // The OLD token hash no longer resolves to this (or any) grant.
    expect(await findAccessGrantByTokenHash(originalHash)).toBeNull();
  });

  it("rotateAccessGrantToken does not rotate a revoked grant's token", async () => {
    const orderId = uniqueOrderId();
    const originalHash = hashToken(generateAccessToken(), SECRET);
    await createAccessGrant({ shopDomain: SHOP, orderId, tokenHash: originalHash });
    await revokeAccessGrantForOrder(SHOP, orderId);

    await rotateAccessGrantToken(SHOP, orderId, hashToken(generateAccessToken(), SECRET));

    const grant = await findAccessGrantByOrder(SHOP, orderId);
    expect(grant?.tokenHash).toBe(originalHash);
  });
});
