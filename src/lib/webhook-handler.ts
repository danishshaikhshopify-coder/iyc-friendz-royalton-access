/**
 * Shared logic for the three order/refund webhook routes
 * (orders/paid, orders/cancelled, refunds/create).
 *
 * Flow, common to all three:
 *   1. Read the RAW body text (never request.json() first — that would
 *      lose the exact bytes the HMAC was computed over).
 *   2. Verify X-Shopify-Hmac-Sha256 against the raw body. Reject (401) on
 *      any failure, before touching the DB or parsing JSON as trusted
 *      data.
 *   3. Claim (shop, X-Shopify-Webhook-Id) for processing (see
 *      src/lib/webhook-events.ts). If it was already completed
 *      successfully, return 200 immediately without reprocessing — this
 *      is what prevents a duplicate email on webhook retries. If another
 *      delivery is currently processing it, also return 200 without
 *      reprocessing. A delivery is only ever skipped as a "duplicate"
 *      once its handler has actually finished successfully — a delivery
 *      whose handler previously threw is deliberately reclaimed and
 *      retried, not skipped.
 *   4. Parse the body JSON and hand off to the topic-specific callback,
 *      which re-checks eligibility against the LIVE Admin API (never the
 *      webhook payload's own financial_status field) before minting a
 *      token / sending an email / revoking a grant.
 *
 * No sensitive data (raw tokens, access tokens, signing secrets) is ever
 * written to logs by this module.
 */

import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { verifyShopifyWebhookHmac } from "@/lib/shopify-hmac";
import {
  claimWebhookEvent,
  markWebhookEventCompleted,
  markWebhookEventFailed,
} from "@/lib/webhook-events";

export interface ShopifyOrderWebhookPayload {
  id: number | string;
  admin_graphql_api_id?: string;
  name?: string;
  email?: string;
  contact_email?: string;
  cancelled_at?: string | null;
  financial_status?: string;
  order_id?: number | string; // present on Refund webhook payloads
  [key: string]: unknown;
}

export type WebhookTopicHandler = (
  payload: ShopifyOrderWebhookPayload,
  context: { shopDomain: string; webhookId: string; topic: string }
) => Promise<void>;

export async function handleShopifyOrderWebhook(
  request: NextRequest,
  expectedTopic: string,
  onVerified: WebhookTopicHandler
): Promise<NextResponse> {
  const rawBody = await request.text();

  const hmacHeader = request.headers.get("x-shopify-hmac-sha256");
  const verification = verifyShopifyWebhookHmac(
    rawBody,
    hmacHeader,
    config.shopify.webhookSigningSecret
  );

  if (!verification.valid) {
    // eslint-disable-next-line no-console
    console.warn("[webhook] HMAC verification failed", {
      topic: expectedTopic,
      reason: verification.reason,
    });
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  const shopDomain = request.headers.get("x-shopify-shop-domain") ?? "unknown";
  const webhookId = request.headers.get("x-shopify-webhook-id");
  const topic = request.headers.get("x-shopify-topic") ?? expectedTopic;

  if (!webhookId) {
    // Shopify always sends this header; if it's missing something is very
    // wrong (not a real Shopify delivery) — reject rather than process
    // something we can't deduplicate.
    return NextResponse.json({ error: "missing_webhook_id" }, { status: 400 });
  }

  const claim = await claimWebhookEvent(shopDomain, webhookId, topic);
  if (claim === "duplicate") {
    // eslint-disable-next-line no-console
    console.log("[webhook] duplicate delivery skipped", { topic, webhookId });
    return NextResponse.json({ ok: true, duplicate: true }, { status: 200 });
  }
  if (claim === "in_progress") {
    // eslint-disable-next-line no-console
    console.log("[webhook] delivery already in progress, skipped", { topic, webhookId });
    return NextResponse.json({ ok: true, inProgress: true }, { status: 200 });
  }
  // claim === "claimed" — this call owns processing for this webhook_id.

  let payload: ShopifyOrderWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    await markWebhookEventFailed(shopDomain, webhookId);
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    await onVerified(payload, { shopDomain, webhookId, topic });
  } catch (err) {
    // Mark failed (not completed) so a Shopify retry — which reuses this
    // same webhook_id — is reclaimed and reprocessed rather than skipped
    // as a duplicate of a delivery that never actually succeeded. Log and
    // return 500 so Shopify actually does retry; don't leak internal
    // error detail to the response.
    await markWebhookEventFailed(shopDomain, webhookId);
    // eslint-disable-next-line no-console
    console.error("[webhook] handler error", {
      topic,
      webhookId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "processing_failed" }, { status: 500 });
  }

  await markWebhookEventCompleted(shopDomain, webhookId);
  return NextResponse.json({ ok: true }, { status: 200 });
}
