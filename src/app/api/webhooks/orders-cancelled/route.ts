import { NextRequest } from "next/server";
import { handleShopifyOrderWebhook } from "@/lib/webhook-handler";
import { revokeAccessGrantForOrder } from "@/lib/access-grants";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  return handleShopifyOrderWebhook(request, "orders/cancelled", async (payload, ctx) => {
    const orderIdKey = String(payload.id);

    // A cancellation webhook from Shopify (HMAC-verified) is authoritative
    // on its own — unlike granting access, revoking it carries no
    // security downside if applied eagerly, and the App Proxy route
    // re-verifies live against the Admin API on every request regardless.
    await revokeAccessGrantForOrder(ctx.shopDomain, orderIdKey);

    // eslint-disable-next-line no-console
    console.log("[orders/cancelled] grant revoked (if one existed)", {
      orderId: orderIdKey,
    });
  });
}
