/**
 * Pure eligibility logic — no network calls, no DB access, fully unit
 * testable. Given order data (fresh from the Admin API, or from a webhook
 * payload shaped the same way) and the current business-policy
 * configuration, decides whether the order is eligible for Royalton
 * booking access right now.
 *
 * This function is called from two places, and MUST produce the same
 * verdict logic in both:
 *  1. Webhook handlers — to decide whether to mint a token + send email.
 *  2. The App Proxy access route — to decide, on every single request,
 *     whether to reveal the booking URL. This second call is the one that
 *     actually gates access; the first is only a convenience trigger for
 *     onboarding the customer.
 */

import type { OrderEligibilityData } from "@/lib/admin-api";

export type IneligibilityReason =
  | "no_line_items"
  | "unrelated_product"
  | "not_paid"
  | "cancelled"
  | "fully_refunded"
  | "partially_refunded_denied";

export interface EligibilityVerdict {
  eligible: boolean;
  reason: IneligibilityReason | "eligible";
}

export interface EligibilityOptions {
  eventPassProductHandle: string;
  partialRefundPolicy: "deny" | "allow";
}

const FINANCIAL_STATUSES_CONSIDERED_PAID = new Set(["PAID"]);

export function checkOrderEligibility(
  data: OrderEligibilityData,
  options: EligibilityOptions
): EligibilityVerdict {
  // 1. Cancellation always blocks access, regardless of financial status.
  if (data.cancelledAt !== null) {
    return { eligible: false, reason: "cancelled" };
  }

  // 2. Every line item must be the exact Event Pass product. An order with
  //    no line items, or with ANY unrelated product mixed in, is denied.
  if (data.lineItems.length === 0) {
    return { eligible: false, reason: "no_line_items" };
  }
  const allLineItemsAreEventPass = data.lineItems.every(
    (item) => item.productHandle === options.eventPassProductHandle
  );
  if (!allLineItemsAreEventPass) {
    return { eligible: false, reason: "unrelated_product" };
  }

  // 3. Financial status.
  const status = data.displayFinancialStatus;

  if (status === "REFUNDED") {
    // Fully refunded — always denied, policy does not apply.
    return { eligible: false, reason: "fully_refunded" };
  }

  if (status === "PARTIALLY_REFUNDED") {
    if (options.partialRefundPolicy === "allow") {
      return { eligible: true, reason: "eligible" };
    }
    return { eligible: false, reason: "partially_refunded_denied" };
  }

  if (!FINANCIAL_STATUSES_CONSIDERED_PAID.has(status)) {
    // Covers PENDING, AUTHORIZED, PARTIALLY_PAID, VOIDED, EXPEDITED, EXPIRED,
    // and any other non-PAID status Shopify reports — fail closed.
    return { eligible: false, reason: "not_paid" };
  }

  return { eligible: true, reason: "eligible" };
}
