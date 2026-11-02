import { config } from "@/lib/config";

/**
 * Builds the customer-facing secure access page URL for a raw token. This
 * is what goes in the email — never the real Royalton URL.
 */
export function buildAccessPageUrl(rawToken: string): string {
  const base = `https://${config.shopify.storefrontDomain}${config.shopify.appProxySubpath}`;
  const url = new URL(base);
  url.searchParams.set("token", rawToken);
  return url.toString();
}
