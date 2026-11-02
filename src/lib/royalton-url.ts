/**
 * Single choke point for reading the private Royalton booking URL.
 *
 * The URL is configuration (ROYALTON_BOOKING_URL, see .env.example), never
 * a literal in source code, never sent to the browser directly, and never
 * stored in a publicly-readable database record. Every caller — the email
 * template, the App Proxy access page — must go through this module rather
 * than reading `process.env.ROYALTON_BOOKING_URL` itself, so there is one
 * place that enforces "absence is valid, never invent a fallback."
 */

import { config } from "@/lib/config";

/**
 * Returns the configured Royalton booking URL, or null if the client has
 * not supplied it yet. Callers MUST handle the null case by hiding/omitting
 * the booking button or link — never by substituting a placeholder.
 */
export function getRoyaltonBookingUrl(): string | null {
  return config.royalton.bookingUrl;
}

export function isRoyaltonUrlConfigured(): boolean {
  return getRoyaltonBookingUrl() !== null;
}
