/**
 * Shopify OAuth — Authorization Code Grant, offline access (standalone
 * app; see https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps
 * and https://shopify.dev/docs/apps/auth/get-access-tokens/authorization-code-grant).
 *
 * Two distinct, separately-documented HMAC schemes are involved across
 * this codebase and must not be confused:
 *  - OAuth callback HMAC (this file): sorted `key=value` pairs joined by
 *    `&`, hex digest. Proves Shopify generated the callback redirect.
 *  - App Proxy signature (src/lib/app-proxy.ts): sorted, comma-grouped
 *    `key=value1,value2` pairs with NO separator, hex digest. Proves
 *    Shopify forwarded a storefront request. Different algorithm,
 *    different purpose — never share code between the two.
 * Both use the same underlying secret in practice (the app's Client
 * secret — confirmed against shopify.dev's webhook/client-secret docs),
 * but are verified independently here, matching the existing codebase's
 * webhook/App Proxy secrets being configured as separate values.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "@/lib/config";
import {
  getActiveShopInstallation,
  updateShopTokens,
} from "@/lib/shop-installations";

// read_orders: core order data (financial status, cancellation, line item
// quantities). read_products: required separately — Shopify's GraphQL
// Admin API enforces field-level access on the nested `lineItems.product`
// object even when queried through an Order the app can already read, so
// resolving `product.handle` (how eligibility is matched to the configured
// event-pass product; see src/lib/admin-api.ts and src/lib/eligibility.ts)
// 403s without it. No other scope is used anywhere in this service.
const OAUTH_SCOPES = "read_orders,read_products";
const SHOP_DOMAIN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

export class OAuthError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "OAuthError";
  }
}

export class ShopNotInstalledError extends Error {
  constructor() {
    super("Shop is not installed, or has been uninstalled/revoked.");
    this.name = "ShopNotInstalledError";
  }
}

/** Shopify's documented shop-domain shape, anchored at both ends. */
export function isValidShopDomain(shop: string): boolean {
  return SHOP_DOMAIN_PATTERN.test(shop);
}

export function generateOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function buildAuthorizeUrl(
  shop: string,
  state: string,
  redirectUri: string
): string {
  const params = new URLSearchParams({
    client_id: config.oauth.apiKey,
    scope: OAUTH_SCOPES,
    redirect_uri: redirectUri,
    state,
  });
  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
}

export interface OAuthCallbackHmacResult {
  valid: boolean;
  reason?: string;
}

/**
 * Shopify's documented OAuth-callback HMAC scheme (distinct from the App
 * Proxy scheme — see file header): every query param except `hmac` and
 * `signature`, sorted by key, joined as `key=value` pairs with `&`,
 * HMAC-SHA256 hex digest keyed by the app's Client secret.
 */
export function verifyOAuthCallbackHmac(
  searchParams: URLSearchParams,
  secret: string
): OAuthCallbackHmacResult {
  const providedHmac = searchParams.get("hmac");
  if (!providedHmac) {
    return { valid: false, reason: "missing_hmac" };
  }

  const pairs: string[] = [];
  for (const [key, value] of searchParams.entries()) {
    if (key === "hmac" || key === "signature") continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const message = pairs.join("&");

  const digestHex = createHmac("sha256", secret).update(message).digest("hex");

  let providedBuf: Buffer;
  let digestBuf: Buffer;
  try {
    providedBuf = Buffer.from(providedHmac, "hex");
    digestBuf = Buffer.from(digestHex, "hex");
  } catch {
    return { valid: false, reason: "hmac_not_hex" };
  }
  if (providedBuf.length !== digestBuf.length) {
    return { valid: false, reason: "hmac_length_mismatch" };
  }
  return timingSafeEqual(digestBuf, providedBuf)
    ? { valid: true }
    : { valid: false, reason: "hmac_mismatch" };
}

export interface TokenExchangeResult {
  accessToken: string;
  scope: string;
  refreshToken: string | null;
  expiresAt: string | null; // ISO; null = non-expiring offline token
}

interface TokenEndpointResponse {
  access_token?: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
}

async function postToTokenEndpoint(
  shop: string,
  body: Record<string, string>
): Promise<TokenExchangeResult> {
  const url = `https://${shop}/admin/oauth/access_token`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new OAuthError("Network error calling Shopify's OAuth token endpoint", err);
  }
  if (!response.ok) {
    throw new OAuthError(`Shopify OAuth token endpoint returned HTTP ${response.status}`);
  }
  let json: TokenEndpointResponse;
  try {
    json = await response.json();
  } catch (err) {
    throw new OAuthError("Could not parse Shopify OAuth token endpoint response", err);
  }
  if (!json.access_token || !json.scope) {
    throw new OAuthError("Shopify OAuth token endpoint response missing access_token/scope");
  }
  return {
    accessToken: json.access_token,
    scope: json.scope,
    refreshToken: json.refresh_token ?? null,
    expiresAt: json.expires_in
      ? new Date(Date.now() + json.expires_in * 1000).toISOString()
      : null,
  };
}

/**
 * Exchanges an authorization code for an offline access token.
 * `expiring: "1"` opts into Shopify's expiring-offline-token behavior
 * (refresh token + expiry) per the current migration guidance; if the
 * shop/app combination doesn't return expiry fields, the result's
 * expiresAt is simply null (non-expiring), handled transparently by
 * getValidAccessToken below either way.
 */
export async function exchangeCodeForToken(
  shop: string,
  code: string
): Promise<TokenExchangeResult> {
  return postToTokenEndpoint(shop, {
    client_id: config.oauth.apiKey,
    client_secret: config.oauth.apiSecret,
    code,
    expiring: "1",
  });
}

export async function refreshAccessToken(
  shop: string,
  refreshToken: string
): Promise<TokenExchangeResult> {
  return postToTokenEndpoint(shop, {
    client_id: config.oauth.apiKey,
    client_secret: config.oauth.apiSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

const REFRESH_BUFFER_MS = 60_000;

/**
 * The single entry point background Admin API calls use to get a usable
 * access token for a shop: returns the stored token as-is if it isn't
 * expiring or isn't close to expiry yet; otherwise refreshes it first
 * (persisting the new pair) and returns the fresh token. Throws
 * ShopNotInstalledError if the shop has no active installation —
 * callers must treat that as "cannot verify eligibility" (fail closed),
 * exactly like any other AdminApiError.
 */
export async function getValidAccessToken(shopDomain: string): Promise<string> {
  const installation = await getActiveShopInstallation(shopDomain);
  if (!installation) {
    throw new ShopNotInstalledError();
  }

  if (!installation.tokenExpiresAt) {
    return installation.accessToken;
  }

  const expiresAtMs = new Date(installation.tokenExpiresAt).getTime();
  if (Date.now() < expiresAtMs - REFRESH_BUFFER_MS) {
    return installation.accessToken;
  }

  if (!installation.refreshToken) {
    throw new OAuthError(
      "Access token expired and no refresh token is stored; re-authorization required."
    );
  }

  const refreshed = await refreshAccessToken(shopDomain, installation.refreshToken);
  await updateShopTokens({
    shopDomain,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    tokenExpiresAt: refreshed.expiresAt,
  });
  return refreshed.accessToken;
}
