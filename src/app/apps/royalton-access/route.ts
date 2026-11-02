/**
 * Shopify App Proxy route — serves the secure Royalton access page.
 *
 * Shopify forwards storefront requests to
 * https://{storefrontDomain}{appProxySubpath}?... to this route, adding
 * its own `shop`, `logged_in_customer_id`, `path_prefix`, `timestamp`, and
 * `signature` query parameters. EVERY request is re-verified here:
 *   1. App Proxy signature (proves Shopify forwarded this, not a direct
 *      hit on our origin with forged query params).
 *   2. Rate limit (per IP + token).
 *   3. Token lookup + live Admin API eligibility check — the actual,
 *      final access decision, made fresh on every single request. Nothing
 *      about a prior webhook or a cached status is trusted here.
 *
 * The real Royalton URL only ever appears in the HTML response when step
 * 3 passes; it is never present in this route's source, in a query
 * param, or in any state visible before that check.
 */

import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { verifyAppProxySignature } from "@/lib/app-proxy";
import { checkRateLimit } from "@/lib/rate-limit";
import { findAccessGrantByTokenHash, revokeAccessGrantForOrder } from "@/lib/access-grants";
import { hashToken } from "@/lib/token";
import { shopifyAdminApiClient, orderGidFromNumericId, AdminApiError } from "@/lib/admin-api";
import { checkOrderEligibility } from "@/lib/eligibility";
import { getRoyaltonBookingUrl } from "@/lib/royalton-url";
import { renderAccessPageHtml } from "@/lib/access-page";

export const runtime = "nodejs";

function htmlResponse(body: string, status: number): NextResponse {
  return new NextResponse(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  return "unknown";
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  // 1. App Proxy signature — reject anything that wasn't genuinely
  //    forwarded by Shopify before trusting ANY other query param.
  const sigResult = verifyAppProxySignature(
    searchParams,
    config.shopify.appProxySigningSecret
  );
  if (!sigResult.valid) {
    // eslint-disable-next-line no-console
    console.warn("[royalton-access] app proxy signature rejected", {
      reason: sigResult.reason,
    });
    return htmlResponse(renderAccessPageHtml({ kind: "ineligible" }), 401);
  }

  // Defense in depth: confirm the shop Shopify says this is for matches
  // our configured shop, even though the signature already covers this
  // param.
  const shop = searchParams.get("shop");
  if (shop && shop !== config.shopify.shopDomain) {
    // eslint-disable-next-line no-console
    console.warn("[royalton-access] shop param mismatch", { shop });
    return htmlResponse(renderAccessPageHtml({ kind: "ineligible" }), 401);
  }

  const token = searchParams.get("token");
  if (!token) {
    return htmlResponse(renderAccessPageHtml({ kind: "ineligible" }), 400);
  }

  // 2. Rate limit, keyed by IP + token so one leaked/guessed token can't
  //    be hammered, and so one IP can't brute-force many tokens quickly.
  const rateLimitKey = `${getClientIp(request)}|${token}`;
  const rate = checkRateLimit(
    rateLimitKey,
    config.rateLimit.windowMs,
    config.rateLimit.maxRequests
  );
  if (!rate.allowed) {
    return htmlResponse(renderAccessPageHtml({ kind: "rate_limited" }), 429);
  }

  // 3. Token lookup + LIVE eligibility check.
  const tokenHash = hashToken(token, config.tokens.signingSecret);
  const grant = await findAccessGrantByTokenHash(tokenHash);

  if (!grant || grant.revoked) {
    return htmlResponse(renderAccessPageHtml({ kind: "ineligible" }), 403);
  }

  try {
    const orderGid = orderGidFromNumericId(grant.orderId);
    const orderData = await shopifyAdminApiClient.fetchOrderEligibilityData(orderGid);
    const verdict = checkOrderEligibility(orderData, {
      eventPassProductHandle: config.shopify.eventPassProductHandle,
      partialRefundPolicy: config.partialRefundPolicy,
    });

    if (!verdict.eligible) {
      // Keep stored state in sync in case the triggering webhook for
      // this change hasn't arrived/processed yet — doesn't change the
      // response either way, just avoids relying on that webhook alone.
      await revokeAccessGrantForOrder(grant.shopDomain, grant.orderId);
      return htmlResponse(renderAccessPageHtml({ kind: "ineligible" }), 403);
    }

    const bookingUrl = getRoyaltonBookingUrl();
    if (!bookingUrl) {
      return htmlResponse(renderAccessPageHtml({ kind: "eligible_url_pending" }), 200);
    }

    return htmlResponse(renderAccessPageHtml({ kind: "eligible", bookingUrl }), 200);
  } catch (err) {
    // Fail CLOSED: any Admin API failure means we could not verify
    // eligibility, so we do not reveal anything.
    const message = err instanceof AdminApiError ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error("[royalton-access] eligibility check failed", { error: message });
    return htmlResponse(renderAccessPageHtml({ kind: "error" }), 502);
  }
}
