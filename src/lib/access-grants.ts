/**
 * Data access for the access_grants table — the one row per order that
 * tracks its (hashed) access token, revocation state, and email delivery
 * status. See src/db/migrations/0001_init.sql for the schema and the
 * reasoning behind what is/isn't stored here.
 *
 * Nothing in this module ever handles a raw token — callers pass in
 * `tokenHash` (from src/lib/token.ts) already hashed.
 */

import type { Row } from "@libsql/client";
import { getDbClient } from "@/lib/db";

export type EmailDeliveryStatus = "not_sent" | "accepted" | "failed";

export interface AccessGrant {
  id: number;
  shopDomain: string;
  orderId: string;
  tokenHash: string;
  tokenCreatedAt: string;
  revoked: boolean;
  revokedAt: string | null;
  emailSent: boolean;
  emailSentAt: string | null;
  emailStatus: EmailDeliveryStatus;
  emailAttempts: number;
  emailLastError: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToGrant(row: Row): AccessGrant {
  return {
    id: Number(row.id),
    shopDomain: String(row.shop_domain),
    orderId: String(row.order_id),
    tokenHash: String(row.token_hash),
    tokenCreatedAt: String(row.token_created_at),
    revoked: Number(row.revoked) === 1,
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    emailSent: Number(row.email_sent) === 1,
    emailSentAt: row.email_sent_at ? String(row.email_sent_at) : null,
    emailStatus: String(row.email_status) as EmailDeliveryStatus,
    emailAttempts: Number(row.email_attempts),
    emailLastError: row.email_last_error ? String(row.email_last_error) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Returns the existing grant for this order, if any. A webhook handler
 * should call this BEFORE generating a new token: if a grant already
 * exists (e.g. a retried/duplicate orders/paid delivery, or the customer
 * was already granted access), do not mint a second token or send a
 * second email.
 */
export async function findAccessGrantByOrder(
  shopDomain: string,
  orderId: string
): Promise<AccessGrant | null> {
  const db = getDbClient();
  const result = await db.execute({
    sql: "SELECT * FROM access_grants WHERE shop_domain = ? AND order_id = ?",
    args: [shopDomain, orderId],
  });
  const row = result.rows[0];
  return row ? rowToGrant(row) : null;
}

export async function findAccessGrantByTokenHash(
  tokenHash: string
): Promise<AccessGrant | null> {
  const db = getDbClient();
  const result = await db.execute({
    sql: "SELECT * FROM access_grants WHERE token_hash = ?",
    args: [tokenHash],
  });
  const row = result.rows[0];
  return row ? rowToGrant(row) : null;
}

/**
 * Creates a new grant for an order. Call only after confirming (via
 * findAccessGrantByOrder) that one doesn't already exist — the UNIQUE
 * (shop_domain, order_id) constraint will reject a duplicate insert
 * anyway, as a second line of defense.
 */
export async function createAccessGrant(params: {
  shopDomain: string;
  orderId: string;
  tokenHash: string;
}): Promise<AccessGrant> {
  const db = getDbClient();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO access_grants
            (shop_domain, order_id, token_hash, token_created_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [params.shopDomain, params.orderId, params.tokenHash, now, now, now],
  });
  const grant = await findAccessGrantByOrder(params.shopDomain, params.orderId);
  if (!grant) {
    throw new Error("Failed to read back newly created access grant");
  }
  return grant;
}

export async function revokeAccessGrantForOrder(
  shopDomain: string,
  orderId: string
): Promise<void> {
  const db = getDbClient();
  const now = new Date().toISOString();
  await db.execute({
    sql: `UPDATE access_grants
          SET revoked = 1, revoked_at = ?, updated_at = ?
          WHERE shop_domain = ? AND order_id = ? AND revoked = 0`,
    args: [now, now, shopDomain, orderId],
  });
}

/** Call only after the email provider has genuinely accepted the send. */
export async function markAccessGrantEmailSent(
  shopDomain: string,
  orderId: string
): Promise<void> {
  const db = getDbClient();
  const now = new Date().toISOString();
  await db.execute({
    sql: `UPDATE access_grants
          SET email_sent = 1, email_sent_at = ?, email_status = 'accepted',
              email_attempts = email_attempts + 1, email_last_error = NULL,
              updated_at = ?
          WHERE shop_domain = ? AND order_id = ?`,
    args: [now, now, shopDomain, orderId],
  });
}

/**
 * Call when the email provider genuinely rejected the send, timed out, or
 * was not configured — never for the "none" no-op succeeding, which isn't
 * a send attempt at all. Does NOT touch email_sent/email_sent_at, so a
 * grant that was already successfully emailed before a later resend
 * attempt fails doesn't retroactively look like it was never sent.
 */
export async function markAccessGrantEmailFailed(
  shopDomain: string,
  orderId: string,
  errorMessage: string
): Promise<void> {
  const db = getDbClient();
  const now = new Date().toISOString();
  await db.execute({
    sql: `UPDATE access_grants
          SET email_status = 'failed', email_attempts = email_attempts + 1,
              email_last_error = ?, updated_at = ?
          WHERE shop_domain = ? AND order_id = ?`,
    // Truncated defensively — this is a provider error string, never a
    // raw token, but it's still external input and shouldn't grow the
    // column unbounded.
    args: [errorMessage.slice(0, 500), now, shopDomain, orderId],
  });
}

/**
 * Rotates an existing grant's token (new hash persisted, the raw value
 * never is) ahead of a resend — the only way to send a *usable* link
 * again, since the previous raw token was never retained anywhere. Resets
 * email_status to 'not_sent' for the new token; a stale failure reason
 * tied to the old token is no longer meaningful. No-ops (0 rows affected)
 * if the grant is revoked — callers must check `revoked` themselves and
 * refuse before calling this; the WHERE clause is defense in depth, not
 * the primary guard.
 */
export async function rotateAccessGrantToken(
  shopDomain: string,
  orderId: string,
  newTokenHash: string
): Promise<void> {
  const db = getDbClient();
  const now = new Date().toISOString();
  await db.execute({
    sql: `UPDATE access_grants
          SET token_hash = ?, token_created_at = ?, email_status = 'not_sent',
              email_last_error = NULL, updated_at = ?
          WHERE shop_domain = ? AND order_id = ? AND revoked = 0`,
    args: [newTokenHash, now, now, shopDomain, orderId],
  });
}
