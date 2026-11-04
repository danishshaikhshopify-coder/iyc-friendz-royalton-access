/**
 * app/uninstalled webhook — revokes the shop's stored installation so
 * getValidAccessToken fails closed for it immediately, without waiting
 * for Shopify's own token invalidation. Not registered live yet (see
 * scripts/register-webhooks.ts); the handler exists so registration can
 * happen without a follow-up deploy once OAuth is live.
 *
 * Deliberately not routed through handleShopifyOrderWebhook (src/lib/
 * webhook-handler.ts), which is typed for order/refund payloads — this
 * topic's payload only carries shop identification, so verification is
 * done directly here with the same primitives instead of widening that
 * shared helper's type for one unrelated case.
 */
import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { verifyShopifyWebhookHmac } from "@/lib/shopify-hmac";
import { recordWebhookEventOnce } from "@/lib/webhook-events";
import { markShopUninstalled } from "@/lib/shop-installations";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const hmacHeader = request.headers.get("x-shopify-hmac-sha256");
  const verification = verifyShopifyWebhookHmac(
    rawBody,
    hmacHeader,
    config.shopify.webhookSigningSecret
  );
  if (!verification.valid) {
    // eslint-disable-next-line no-console
    console.warn("[app/uninstalled] HMAC verification failed", {
      reason: verification.reason,
    });
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  const shopDomain = request.headers.get("x-shopify-shop-domain") ?? "unknown";
  const webhookId = request.headers.get("x-shopify-webhook-id");
  const topic = request.headers.get("x-shopify-topic") ?? "app/uninstalled";

  if (!webhookId) {
    return NextResponse.json({ error: "missing_webhook_id" }, { status: 400 });
  }

  const isNewDelivery = await recordWebhookEventOnce(shopDomain, webhookId, topic);
  if (!isNewDelivery) {
    // eslint-disable-next-line no-console
    console.log("[app/uninstalled] duplicate delivery skipped", { webhookId });
    return NextResponse.json({ ok: true, duplicate: true }, { status: 200 });
  }

  await markShopUninstalled(shopDomain);
  // eslint-disable-next-line no-console
  console.log("[app/uninstalled] shop installation revoked", { shop: shopDomain });

  return NextResponse.json({ ok: true }, { status: 200 });
}
