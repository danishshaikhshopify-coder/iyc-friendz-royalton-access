/**
 * Central, typed access to environment configuration.
 *
 * Nothing in this file is safe to import from client/browser code — it is
 * server-only (Next.js route handlers / server components).
 *
 * See .env.example for the full list of variables and where each one
 * comes from.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}. See .env.example.`
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

export const config = {
  shopify: {
    shopDomain: required("SHOPIFY_SHOP_DOMAIN"), // e.g. "inyourcitycorp.myshopify.com"
    storefrontDomain: optional(
      "SHOPIFY_STOREFRONT_DOMAIN",
      "inyourcitycorp.com"
    ),
    adminApiVersion: optional("SHOPIFY_ADMIN_API_VERSION", "2026-01"),
    adminApiAccessToken: required("SHOPIFY_ADMIN_API_ACCESS_TOKEN"),
    webhookSigningSecret: required("SHOPIFY_WEBHOOK_SIGNING_SECRET"),
    appProxySigningSecret: required("SHOPIFY_APP_PROXY_SIGNING_SECRET"),
    eventPassProductHandle: optional(
      "EVENT_PASS_PRODUCT_HANDLE",
      "iyc-friendz-weekend-pass"
    ),
    // The App Proxy subpath this app is registered under in the Shopify
    // Partner/Dev Dashboard app's App Proxy settings (Admin > Apps >
    // Develop apps > [app] > App proxy). Must match exactly, including
    // the leading slash, or Shopify won't forward requests here. Not yet
    // confirmed configured — see Task 17 report, Deployment section.
    appProxySubpath: optional("SHOPIFY_APP_PROXY_SUBPATH", "/apps/royalton-access"),
  },

  // Royalton URL is intentionally NOT bundled with a default. Absence is a
  // valid, expected state until the client supplies the real URL — the
  // access page must degrade gracefully, not invent one. See
  // src/lib/royalton-url.ts.
  royalton: {
    bookingUrl: process.env.ROYALTON_BOOKING_URL || null,
  },

  tokens: {
    // HMAC key used to derive/verify tokens. 32+ random bytes, base64 or hex.
    signingSecret: required("ACCESS_TOKEN_SIGNING_SECRET"),
  },

  db: {
    // Turso/libSQL connection. For local dev, use "file:./dev.db" and leave
    // authToken unset.
    url: optional("TURSO_DATABASE_URL", "file:./dev.db"),
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  },

  email: {
    // Which provider to use for sending the access-page email.
    // Implemented: "klaviyo" | "omnisend" | "none" (logs only, for local
    // dev). "smtp" is a documented future option, not yet implemented —
    // see src/lib/email.ts, which throws rather than silently falling
    // back to "none" for any value other than the three above.
    provider: optional("EMAIL_PROVIDER", "none"),
    klaviyoApiKey: process.env.KLAVIYO_PRIVATE_API_KEY || undefined,
    klaviyoListOrFlowId: process.env.KLAVIYO_TRANSACTIONAL_FLOW_ID || undefined,
    omnisendApiKey: process.env.OMNISEND_API_KEY || undefined,
    fromAddress: optional("EMAIL_FROM_ADDRESS", "bookings@inyourcitycorp.com"),
  },

  rateLimit: {
    // Requests per window, per token+IP, for the App Proxy access route.
    windowMs: Number(optional("RATE_LIMIT_WINDOW_MS", "60000")),
    maxRequests: Number(optional("RATE_LIMIT_MAX_REQUESTS", "20")),
  },

  // Governs how a PARTIALLY refunded order is treated. CONFIRMED client
  // decision (Task 17): a partial refund revokes access, same as a full
  // refund. "deny" is both the default and the decision — "allow" is kept
  // only as a config knob for a future, explicit, written policy change.
  partialRefundPolicy: optional("PARTIAL_REFUND_POLICY", "deny") as
    | "deny"
    | "allow",
} as const;
