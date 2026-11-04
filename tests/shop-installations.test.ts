import { describe, it, expect } from "vitest";
import {
  upsertShopInstallation,
  getActiveShopInstallation,
  updateShopTokens,
  markShopUninstalled,
} from "@/lib/shop-installations";
import { getDbClient } from "@/lib/db";

function uniqueShop(): string {
  return `shop-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`;
}

describe("shop-installations (OAuth installation storage)", () => {
  it("stores a new installation and returns it decrypted", async () => {
    const shop = uniqueShop();
    await upsertShopInstallation({
      shopDomain: shop,
      accessToken: "raw-access-token",
      refreshToken: "raw-refresh-token",
      scope: "read_orders",
      tokenExpiresAt: null,
    });

    const installation = await getActiveShopInstallation(shop);
    expect(installation).not.toBeNull();
    expect(installation?.accessToken).toBe("raw-access-token");
    expect(installation?.refreshToken).toBe("raw-refresh-token");
    expect(installation?.scope).toBe("read_orders");
  });

  it("never stores the raw token in the database row", async () => {
    const shop = uniqueShop();
    await upsertShopInstallation({
      shopDomain: shop,
      accessToken: "a-very-identifiable-raw-token",
      refreshToken: null,
      scope: "read_orders",
      tokenExpiresAt: null,
    });

    const db = getDbClient();
    const result = await db.execute({
      sql: "SELECT access_token_enc FROM shop_installations WHERE shop_domain = ?",
      args: [shop],
    });
    expect(String(result.rows[0]!.access_token_enc)).not.toContain("a-very-identifiable-raw-token");
  });

  it("enforces exactly one installation row per shop (reauthorization overwrites, not duplicates)", async () => {
    const shop = uniqueShop();
    await upsertShopInstallation({
      shopDomain: shop,
      accessToken: "first-token",
      refreshToken: null,
      scope: "read_orders",
      tokenExpiresAt: null,
    });
    await upsertShopInstallation({
      shopDomain: shop,
      accessToken: "second-token-after-reauthorization",
      refreshToken: null,
      scope: "read_orders",
      tokenExpiresAt: null,
    });

    const db = getDbClient();
    const result = await db.execute({
      sql: "SELECT COUNT(*) as count FROM shop_installations WHERE shop_domain = ?",
      args: [shop],
    });
    expect(Number(result.rows[0]!.count)).toBe(1);

    const installation = await getActiveShopInstallation(shop);
    expect(installation?.accessToken).toBe("second-token-after-reauthorization");
  });

  it("updateShopTokens persists a refreshed token pair", async () => {
    const shop = uniqueShop();
    await upsertShopInstallation({
      shopDomain: shop,
      accessToken: "original-token",
      refreshToken: "original-refresh",
      scope: "read_orders",
      tokenExpiresAt: "2026-01-01T00:00:00.000Z",
    });

    await updateShopTokens({
      shopDomain: shop,
      accessToken: "refreshed-token",
      refreshToken: "refreshed-refresh",
      tokenExpiresAt: "2027-01-01T00:00:00.000Z",
    });

    const installation = await getActiveShopInstallation(shop);
    expect(installation?.accessToken).toBe("refreshed-token");
    expect(installation?.tokenExpiresAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("markShopUninstalled revokes the installation so it's no longer returned as active", async () => {
    const shop = uniqueShop();
    await upsertShopInstallation({
      shopDomain: shop,
      accessToken: "token",
      refreshToken: null,
      scope: "read_orders",
      tokenExpiresAt: null,
    });
    expect(await getActiveShopInstallation(shop)).not.toBeNull();

    await markShopUninstalled(shop);
    expect(await getActiveShopInstallation(shop)).toBeNull();
  });

  it("reinstalling after uninstall clears the revoked/uninstalled state", async () => {
    const shop = uniqueShop();
    await upsertShopInstallation({
      shopDomain: shop,
      accessToken: "token",
      refreshToken: null,
      scope: "read_orders",
      tokenExpiresAt: null,
    });
    await markShopUninstalled(shop);
    expect(await getActiveShopInstallation(shop)).toBeNull();

    await upsertShopInstallation({
      shopDomain: shop,
      accessToken: "reinstalled-token",
      refreshToken: null,
      scope: "read_orders",
      tokenExpiresAt: null,
    });
    const installation = await getActiveShopInstallation(shop);
    expect(installation?.accessToken).toBe("reinstalled-token");
  });

  it("returns null for a shop that was never installed", async () => {
    expect(await getActiveShopInstallation(uniqueShop())).toBeNull();
  });
});
