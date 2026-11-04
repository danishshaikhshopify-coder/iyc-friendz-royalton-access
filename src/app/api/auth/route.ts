/**
 * OAuth initiation. GET /api/auth?shop={shop}.myshopify.com redirects the
 * merchant to Shopify's authorization screen. The CSRF-defense `state`
 * value is stored in a short-lived, httpOnly cookie (scoped to /api/auth)
 * rather than a server-side session table — the callback compares the
 * cookie to Shopify's returned `state` query param (double-submit
 * pattern); an attacker can't read or set this cookie in the merchant's
 * browser, so they can't forge a matching pair.
 */
import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { isValidShopDomain, generateOAuthState, buildAuthorizeUrl } from "@/lib/shopify-oauth";

export const runtime = "nodejs";

const STATE_COOKIE = "shopify_oauth_state";

export async function GET(request: NextRequest) {
  const shop = request.nextUrl.searchParams.get("shop");

  if (!shop || !isValidShopDomain(shop)) {
    return NextResponse.json({ error: "invalid_shop" }, { status: 400 });
  }

  // This is a single-tenant, standalone app (one configured shop) — only
  // ever start OAuth for the shop it's actually built for.
  if (shop !== config.shopify.shopDomain) {
    // eslint-disable-next-line no-console
    console.warn("[auth] OAuth start requested for an unconfigured shop", { shop });
    return NextResponse.json({ error: "shop_not_configured" }, { status: 403 });
  }

  const state = generateOAuthState();
  const redirectUri = `${request.nextUrl.origin}/api/auth/callback`;
  const authorizeUrl = buildAuthorizeUrl(shop, state, redirectUri);

  const response = NextResponse.redirect(authorizeUrl, 302);
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 300,
    path: "/api/auth",
  });
  return response;
}
