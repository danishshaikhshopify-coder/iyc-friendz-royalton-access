import { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { handleShopifyOrderWebhook } from "@/lib/webhook-handler";
import {
  shopifyAdminApiClient,
  orderGidFromNumericId,
} from "@/lib/admin-api";
import { checkOrderEligibility } from "@/lib/eligibility";
import {
  createAccessGrant,
  findAccessGrantByOrder,
  markAccessGrantEmailSent,
} from "@/lib/access-grants";
import { generateAccessToken, hashToken } from "@/lib/token";
import { buildAccessPageUrl } from "@/lib/access-url";
import { sendAccessReadyEmail } from "@/lib/email";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  return handleShopifyOrderWebhook(request, "orders/paid", async (payload, ctx) => {
    const orderGid =
      payload.admin_graphql_api_id ?? orderGidFromNumericId(payload.id);
    const orderIdKey = String(payload.id);

    // Already has a grant (e.g. a near-duplicate paid event on an order
    // we've already processed)? Don't mint a second token or send a
    // second email — idempotent by design, independent of the
    // webhook_events table (belt and suspenders).
    const existingGrant = await findAccessGrantByOrder(ctx.shopDomain, orderIdKey);
    if (existingGrant) {
      // eslint-disable-next-line no-console
      console.log("[orders/paid] grant already exists, skipping", {
        orderId: orderIdKey,
      });
      return;
    }

    // Live eligibility check — never trust the webhook payload's own
    // financial_status/line_items as the final word.
    const orderData = await shopifyAdminApiClient.fetchOrderEligibilityData(orderGid);
    const verdict = checkOrderEligibility(orderData, {
      eventPassProductHandle: config.shopify.eventPassProductHandle,
      partialRefundPolicy: config.partialRefundPolicy,
    });

    if (!verdict.eligible) {
      // eslint-disable-next-line no-console
      console.log("[orders/paid] order not eligible, no grant created", {
        orderId: orderIdKey,
        reason: verdict.reason,
      });
      return;
    }

    const rawToken = generateAccessToken();
    const tokenHash = hashToken(rawToken, config.tokens.signingSecret);

    await createAccessGrant({
      shopDomain: ctx.shopDomain,
      orderId: orderIdKey,
      tokenHash,
    });

    const to = payload.email ?? payload.contact_email;
    if (!to) {
      // eslint-disable-next-line no-console
      console.warn("[orders/paid] eligible order has no email on the webhook payload", {
        orderId: orderIdKey,
      });
      return;
    }

    const accessPageUrl = buildAccessPageUrl(rawToken);
    const result = await sendAccessReadyEmail(to, {
      accessPageUrl,
      orderName: payload.name ?? orderIdKey,
    });

    if (result.success) {
      await markAccessGrantEmailSent(ctx.shopDomain, orderIdKey);
    } else {
      // eslint-disable-next-line no-console
      console.error("[orders/paid] email send failed", {
        orderId: orderIdKey,
        error: result.error,
      });
    }
  });
}
