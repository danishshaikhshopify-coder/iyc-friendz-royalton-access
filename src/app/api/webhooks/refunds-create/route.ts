import { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { handleShopifyOrderWebhook } from "@/lib/webhook-handler";
import { shopifyAdminApiClient, orderGidFromNumericId } from "@/lib/admin-api";
import { checkOrderEligibility } from "@/lib/eligibility";
import { revokeAccessGrantForOrder } from "@/lib/access-grants";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  return handleShopifyOrderWebhook(request, "refunds/create", async (payload, ctx) => {
    const orderIdRaw = payload.order_id;
    if (orderIdRaw === undefined || orderIdRaw === null) {
      // eslint-disable-next-line no-console
      console.warn("[refunds/create] payload missing order_id, skipping");
      return;
    }

    const orderIdKey = String(orderIdRaw);
    const orderGid = orderGidFromNumericId(orderIdRaw);

    // A refund can be partial or full, and the webhook payload alone
    // doesn't cleanly tell us the resulting order-level financial status
    // (that's a function of ALL refunds + the original payment, not just
    // this one event) — always re-check live against the Admin API.
    const orderData = await shopifyAdminApiClient.fetchOrderEligibilityData(orderGid);
    const verdict = checkOrderEligibility(orderData, {
      eventPassProductHandle: config.shopify.eventPassProductHandle,
      partialRefundPolicy: config.partialRefundPolicy,
    });

    if (!verdict.eligible) {
      await revokeAccessGrantForOrder(ctx.shopDomain, orderIdKey);
      // eslint-disable-next-line no-console
      console.log("[refunds/create] grant revoked after refund", {
        orderId: orderIdKey,
        reason: verdict.reason,
      });
    } else {
      // eslint-disable-next-line no-console
      console.log("[refunds/create] order still eligible after refund, no change", {
        orderId: orderIdKey,
      });
    }
  });
}
