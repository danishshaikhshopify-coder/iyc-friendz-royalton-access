/**
 * Idempotency tracking for inbound Shopify webhooks.
 *
 * Shopify may deliver the same webhook more than once (retries on slow/
 * failed responses are expected and normal). Every webhook handler must
 * call `recordWebhookEventOnce` with the delivery's `X-Shopify-Webhook-Id`
 * header value immediately after HMAC verification succeeds, and skip all
 * further processing (no re-granting access, no duplicate email) if it
 * returns false.
 */

import { getDbClient } from "@/lib/db";

/**
 * Attempts to record this webhook delivery. Returns true if this is the
 * first time we've seen this (shopDomain, webhookId) pair (i.e. proceed
 * with processing), or false if it's a duplicate (i.e. skip — already
 * processed).
 */
export async function recordWebhookEventOnce(
  shopDomain: string,
  webhookId: string,
  topic: string
): Promise<boolean> {
  const db = getDbClient();
  try {
    const result = await db.execute({
      sql: `INSERT INTO webhook_events (shop_domain, webhook_id, topic)
            VALUES (?, ?, ?)
            ON CONFLICT (shop_domain, webhook_id) DO NOTHING`,
      args: [shopDomain, webhookId, topic],
    });
    // libSQL reports rowsAffected = 0 when the ON CONFLICT clause suppressed
    // the insert, i.e. this webhook_id was already recorded.
    return result.rowsAffected > 0;
  } catch (err) {
    // If the unique constraint rejects it outright (older SQLite without
    // ON CONFLICT support edge cases), treat as a duplicate rather than
    // crashing the handler — being conservative here means "skip", never
    // "process a duplicate".
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes("unique")) {
      return false;
    }
    throw err;
  }
}
