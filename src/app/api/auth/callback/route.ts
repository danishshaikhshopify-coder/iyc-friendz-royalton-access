/**
 * OAuth callback. GET /api/auth/callback is where Shopify redirects
 * after merchant approval. Verification order, each a hard stop on
 * failure, before any network call or DB write:
 *   1. Shop domain shape + matches the one shop this app is configured
 *      for (single-tenant).
 *   2. State — the query param must exactly match the httpOnly cookie
 *      set by /api/auth (CSRF defense; see that route's header comment).
 *   3. HMAC over the callback's own query params, proving Shopify (not
 *      merely someone who intercepted/guessed the state) generated this
 *      redirect.
 * Only then is the authorization code exchanged, server-side, for an
 * offline access token — which is encrypted before being persisted.
 * Nothing here ever logs the code, access token, refresh token, or
 * client secret.
 */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { config } from "@/lib/config";
import {
  isValidShopDomain,
  verifyOAuthCallbackHmac,
  exchangeCodeForToken,
  OAuthError,
} from "@/lib/shopify-oauth";
import { upsertShopInstallation } from "@/lib/shop-installations";

export const runtime = "nodejs";

const STATE_COOKIE = "shopify_oauth_state";

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const shop = params.get("shop");
  const code = params.get("code");
  const state = params.get("state");
  const cookieState = request.cookies.get(STATE_COOKIE)?.value;

  if (!shop || !isValidShopDomain(shop) || shop !== config.shopify.shopDomain) {
    // eslint-disable-next-line no-console
    console.warn("[auth/callback] invalid or unexpected shop", { shop });
    return NextResponse.json({ error: "invalid_shop" }, { status: 400 });
  }

  if (!state || !cookieState || !safeEqual(state, cookieState)) {
    // eslint-disable-next-line no-console
    console.warn("[auth/callback] OAuth state missing or mismatched");
    return NextResponse.json({ error: "invalid_state" }, { status: 400 });
  }

  const hmacResult = verifyOAuthCallbackHmac(params, config.oauth.apiSecret);
  if (!hmacResult.valid) {
    // eslint-disable-next-line no-console
    console.warn("[auth/callback] HMAC verification failed", { reason: hmacResult.reason });
    return NextResponse.json({ error: "invalid_hmac" }, { status: 400 });
  }

  if (!code) {
    return NextResponse.json({ error: "missing_code" }, { status: 400 });
  }

  try {
    const result = await exchangeCodeForToken(shop, code);
    await upsertShopInstallation({
      shopDomain: shop,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      scope: result.scope,
      tokenExpiresAt: result.expiresAt,
    });
  } catch (err) {
    const message = err instanceof OAuthError ? err.message : "unexpected error";
    // eslint-disable-next-line no-console
    console.error("[auth/callback] token exchange failed", { error: message });
    return NextResponse.json({ error: "token_exchange_failed" }, { status: 502 });
  }

  const response = NextResponse.json({ ok: true, shop }, { status: 200 });
  response.cookies.set(STATE_COOKIE, "", { maxAge: 0, path: "/api/auth" });
  return response;
}
