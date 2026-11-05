/**
 * Idempotency tracking for inbound Shopify webhooks.
 *
 * Shopify may deliver the same webhook more than once (retries on slow/
 * failed responses are expected and normal, and Shopify reuses the SAME
 * X-Shopify-Webhook-Id for a retry of the same delivery — confirmed
 * against real production logs during Task 19 QA). A webhook delivery
 * must only ever be treated as a true duplicate once it has actually
 * finished processing successfully:
 *
 *   processing -> completed   handler ran to completion without throwing.
 *                              Any later delivery of this webhook_id is a
 *                              real duplicate and must be skipped.
 *   processing -> failed      handler threw. A later delivery of this same
 *                              webhook_id (a Shopify retry) must be allowed
 *                              to reclaim and retry it — never silently
 *                              dropped as a "duplicate" of a delivery that
 *                              never actually succeeded.
 *
 * `claimWebhookEvent` is the single entry point webhook routes call,
 * immediately after HMAC verification succeeds, to find out whether to
 * proceed. Exactly one of three outcomes:
 *   "claimed"     — this call owns processing; proceed, then call
 *                    markWebhookEventCompleted or markWebhookEventFailed.
 *   "duplicate"   — already completed successfully; skip, no reprocessing.
 *   "in_progress" — another delivery (a genuinely concurrent one, or a
 *                    stale/abandoned attempt within the lease window) is
 *                    currently processing this webhook_id; skip rather
 *                    than process the same event twice in parallel.
 *
 * Concurrency safety: claiming is done with an atomic
 * `INSERT ... ON CONFLICT DO NOTHING` for a brand-new row, and a
 * compare-and-swap `UPDATE ... WHERE status = <expected>` to reclaim an
 * existing `failed` (or stale `processing`) row — so if two deliveries
 * race for the same webhook_id, only one of them can ever receive
 * "claimed".
 */

import { getDbClient } from "@/lib/db";

export type WebhookClaimOutcome = "claimed" | "duplicate" | "in_progress";

/**
 * A `processing` row older than this is assumed to belong to an attempt
 * that crashed or was killed mid-handler (e.g. a function timeout) without
 * ever reaching markWebhookEventCompleted/Failed — it's treated the same
 * as `failed` and may be reclaimed, rather than blocking that webhook_id
 * forever.
 */
const STALE_PROCESSING_LEASE_MS = 60_000;

interface WebhookEventRow {
  status: string;
  updated_at: string;
}

async function readWebhookEventRow(
  shopDomain: string,
  webhookId: string
): Promise<WebhookEventRow | null> {
  const db = getDbClient();
  const result = await db.execute({
    sql: `SELECT status, updated_at FROM webhook_events WHERE shop_domain = ? AND webhook_id = ?`,
    args: [shopDomain, webhookId],
  });
  const row = result.rows[0];
  if (!row) return null;
  return { status: String(row.status), updated_at: String(row.updated_at) };
}

/**
 * Attempts to claim (shopDomain, webhookId) for processing. See the
 * module doc comment above for the three possible outcomes.
 */
export async function claimWebhookEvent(
  shopDomain: string,
  webhookId: string,
  topic: string
): Promise<WebhookClaimOutcome> {
  const db = getDbClient();
  const nowIso = new Date().toISOString();

  // 1. Try to claim it as a brand-new delivery.
  const inserted = await db.execute({
    sql: `INSERT INTO webhook_events (shop_domain, webhook_id, topic, status, processed_at, updated_at)
          VALUES (?, ?, ?, 'processing', ?, ?)
          ON CONFLICT (shop_domain, webhook_id) DO NOTHING`,
    args: [shopDomain, webhookId, topic, nowIso, nowIso],
  });
  if (inserted.rowsAffected > 0) {
    return "claimed";
  }

  // 2. A row already exists (this webhook_id has been seen before) —
  //    inspect its status to decide what a conflicting insert means.
  const existing = await readWebhookEventRow(shopDomain, webhookId);
  if (!existing) {
    // Vanished between the insert-conflict and this read (shouldn't
    // normally happen — rows are never deleted). Fail safe: don't
    // reprocess something we can't positively identify as retryable.
    return "in_progress";
  }

  if (existing.status === "completed") {
    return "duplicate";
  }

  if (existing.status === "failed") {
    // Reclaim it for retry. CAS on status = 'failed' so that if two
    // retries race here, only one wins the reclaim.
    const reclaimed = await db.execute({
      sql: `UPDATE webhook_events SET status = 'processing', updated_at = ?
            WHERE shop_domain = ? AND webhook_id = ? AND status = 'failed'`,
      args: [nowIso, shopDomain, webhookId],
    });
    return reclaimed.rowsAffected > 0 ? "claimed" : "in_progress";
  }

  // existing.status === "processing": either a genuinely concurrent
  // delivery is handling this right now, or a previous attempt crashed
  // without ever marking completed/failed. Only reclaim if its lease
  // looks abandoned (stale), using the row's own last-seen updated_at as
  // the CAS guard so a still-live attempt can't be stolen out from under
  // itself.
  const updatedAtMs = Date.parse(existing.updated_at);
  const isStale =
    Number.isNaN(updatedAtMs) ||
    Date.now() - updatedAtMs > STALE_PROCESSING_LEASE_MS;
  if (!isStale) {
    return "in_progress";
  }

  const reclaimedStale = await db.execute({
    sql: `UPDATE webhook_events SET status = 'processing', updated_at = ?
          WHERE shop_domain = ? AND webhook_id = ? AND status = 'processing' AND updated_at = ?`,
    args: [nowIso, shopDomain, webhookId, existing.updated_at],
  });
  return reclaimedStale.rowsAffected > 0 ? "claimed" : "in_progress";
}

/** Marks a claimed webhook event as successfully processed. */
export async function markWebhookEventCompleted(
  shopDomain: string,
  webhookId: string
): Promise<void> {
  const db = getDbClient();
  await db.execute({
    sql: `UPDATE webhook_events SET status = 'completed', updated_at = ?
          WHERE shop_domain = ? AND webhook_id = ?`,
    args: [new Date().toISOString(), shopDomain, webhookId],
  });
}

/** Marks a claimed webhook event as failed, making it retryable. */
export async function markWebhookEventFailed(
  shopDomain: string,
  webhookId: string
): Promise<void> {
  const db = getDbClient();
  await db.execute({
    sql: `UPDATE webhook_events SET status = 'failed', updated_at = ?
          WHERE shop_domain = ? AND webhook_id = ?`,
    args: [new Date().toISOString(), shopDomain, webhookId],
  });
}
