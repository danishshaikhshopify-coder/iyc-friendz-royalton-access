/**
 * Data access for the shop_installations table — one row per Shopify
 * shop that has completed OAuth, holding its (encrypted) offline access
 * token. See src/db/migrations/0002_shop_installations.sql for the
 * schema. Nothing outside this module and src/lib/crypto.ts ever touches
 * a raw (decrypted) token value.
 */

import type { Row } from "@libsql/client";
import { getDbClient } from "@/lib/db";
import { encryptSecret, decryptSecret } from "@/lib/crypto";

export interface ShopInstallation {
  shopDomain: string;
  accessToken: string; // decrypted
  refreshToken: string | null; // decrypted
  scope: string;
  tokenExpiresAt: string | null;
}

function rowToInstallation(row: Row): ShopInstallation {
  return {
    shopDomain: String(row.shop_domain),
    accessToken: decryptSecret(String(row.access_token_enc)),
    refreshToken: row.refresh_token_enc
      ? decryptSecret(String(row.refresh_token_enc))
      : null,
    scope: String(row.scope),
    tokenExpiresAt: row.token_expires_at ? String(row.token_expires_at) : null,
  };
}

/**
 * Creates the shop's installation row, or — on reauthorization or
 * reinstall after uninstall — overwrites it in place. UNIQUE(shop_domain)
 * guarantees exactly one row per shop either way.
 */
export async function upsertShopInstallation(params: {
  shopDomain: string;
  accessToken: string;
  refreshToken: string | null;
  scope: string;
  tokenExpiresAt: string | null;
}): Promise<void> {
  const db = getDbClient();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO shop_installations
            (shop_domain, access_token_enc, refresh_token_enc, scope, token_expires_at,
             revoked, installed_at, uninstalled_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?)
          ON CONFLICT (shop_domain) DO UPDATE SET
            access_token_enc = excluded.access_token_enc,
            refresh_token_enc = excluded.refresh_token_enc,
            scope = excluded.scope,
            token_expires_at = excluded.token_expires_at,
            revoked = 0,
            uninstalled_at = NULL,
            updated_at = excluded.updated_at`,
    args: [
      params.shopDomain,
      encryptSecret(params.accessToken),
      params.refreshToken ? encryptSecret(params.refreshToken) : null,
      params.scope,
      params.tokenExpiresAt,
      now,
      now,
    ],
  });
}

/** Returns the shop's installation, or null if never installed, uninstalled, or revoked. */
export async function getActiveShopInstallation(
  shopDomain: string
): Promise<ShopInstallation | null> {
  const db = getDbClient();
  const result = await db.execute({
    sql: "SELECT * FROM shop_installations WHERE shop_domain = ? AND revoked = 0 AND uninstalled_at IS NULL",
    args: [shopDomain],
  });
  const row = result.rows[0];
  return row ? rowToInstallation(row) : null;
}

/** Persists a refreshed access/refresh token pair for an already-installed shop. */
export async function updateShopTokens(params: {
  shopDomain: string;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
}): Promise<void> {
  const db = getDbClient();
  const now = new Date().toISOString();
  await db.execute({
    sql: `UPDATE shop_installations
          SET access_token_enc = ?, refresh_token_enc = ?, token_expires_at = ?, updated_at = ?
          WHERE shop_domain = ?`,
    args: [
      encryptSecret(params.accessToken),
      params.refreshToken ? encryptSecret(params.refreshToken) : null,
      params.tokenExpiresAt,
      now,
      params.shopDomain,
    ],
  });
}

/**
 * Marks a shop's installation revoked (app/uninstalled webhook). The row
 * is kept for audit, but getActiveShopInstallation will no longer return
 * it, so any later Admin API call for this shop fails closed.
 */
export async function markShopUninstalled(shopDomain: string): Promise<void> {
  const db = getDbClient();
  const now = new Date().toISOString();
  await db.execute({
    sql: `UPDATE shop_installations
          SET revoked = 1, uninstalled_at = ?, updated_at = ?
          WHERE shop_domain = ?`,
    args: [now, now, shopDomain],
  });
}
