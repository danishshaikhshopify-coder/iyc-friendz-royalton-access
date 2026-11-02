import { describe, it, expect } from "vitest";
import { checkOrderEligibility } from "@/lib/eligibility";
import type { OrderEligibilityData } from "@/lib/admin-api";

const EVENT_PASS_HANDLE = "iyc-friendz-weekend-pass";

function order(overrides: Partial<OrderEligibilityData>): OrderEligibilityData {
  return {
    orderGid: "gid://shopify/Order/1",
    name: "#1001",
    displayFinancialStatus: "PAID",
    cancelledAt: null,
    lineItems: [{ productHandle: EVENT_PASS_HANDLE, quantity: 1 }],
    ...overrides,
  };
}

const denyPolicy = { eventPassProductHandle: EVENT_PASS_HANDLE, partialRefundPolicy: "deny" as const };
const allowPolicy = { eventPassProductHandle: EVENT_PASS_HANDLE, partialRefundPolicy: "allow" as const };

describe("checkOrderEligibility — the Task 17 test matrix", () => {
  it("1 Event Pass unit, paid -> eligible", () => {
    const data = order({ lineItems: [{ productHandle: EVENT_PASS_HANDLE, quantity: 1 }] });
    expect(checkOrderEligibility(data, denyPolicy)).toEqual({ eligible: true, reason: "eligible" });
  });

  it("2 Event Pass units, paid -> eligible", () => {
    const data = order({ lineItems: [{ productHandle: EVENT_PASS_HANDLE, quantity: 2 }] });
    expect(checkOrderEligibility(data, denyPolicy)).toEqual({ eligible: true, reason: "eligible" });
  });

  it("3 Event Pass units, paid -> eligible", () => {
    const data = order({ lineItems: [{ productHandle: EVENT_PASS_HANDLE, quantity: 3 }] });
    expect(checkOrderEligibility(data, denyPolicy)).toEqual({ eligible: true, reason: "eligible" });
  });

  it("Event Pass plus another product -> ineligible (unrelated_product)", () => {
    const data = order({
      lineItems: [
        { productHandle: EVENT_PASS_HANDLE, quantity: 1 },
        { productHandle: "some-other-product", quantity: 1 },
      ],
    });
    expect(checkOrderEligibility(data, denyPolicy)).toEqual({
      eligible: false,
      reason: "unrelated_product",
    });
  });

  it("another product only -> ineligible (unrelated_product)", () => {
    const data = order({ lineItems: [{ productHandle: "some-other-product", quantity: 1 }] });
    expect(checkOrderEligibility(data, denyPolicy)).toEqual({
      eligible: false,
      reason: "unrelated_product",
    });
  });

  it("no line items -> ineligible (no_line_items)", () => {
    const data = order({ lineItems: [] });
    expect(checkOrderEligibility(data, denyPolicy)).toEqual({
      eligible: false,
      reason: "no_line_items",
    });
  });

  it("pending payment -> ineligible (not_paid)", () => {
    const data = order({ displayFinancialStatus: "PENDING" });
    expect(checkOrderEligibility(data, denyPolicy)).toEqual({ eligible: false, reason: "not_paid" });
  });

  it("failed/voided payment -> ineligible (not_paid)", () => {
    const data = order({ displayFinancialStatus: "VOIDED" });
    expect(checkOrderEligibility(data, denyPolicy)).toEqual({ eligible: false, reason: "not_paid" });
  });

  it("authorized but not captured -> ineligible (not_paid)", () => {
    const data = order({ displayFinancialStatus: "AUTHORIZED" });
    expect(checkOrderEligibility(data, denyPolicy)).toEqual({ eligible: false, reason: "not_paid" });
  });

  it("cancelled order -> ineligible (cancelled), even if otherwise paid", () => {
    const data = order({ cancelledAt: "2026-01-01T00:00:00Z" });
    expect(checkOrderEligibility(data, denyPolicy)).toEqual({ eligible: false, reason: "cancelled" });
  });

  it("fully refunded order -> ineligible (fully_refunded), policy cannot override", () => {
    const data = order({ displayFinancialStatus: "REFUNDED" });
    expect(checkOrderEligibility(data, denyPolicy)).toEqual({
      eligible: false,
      reason: "fully_refunded",
    });
    expect(checkOrderEligibility(data, allowPolicy)).toEqual({
      eligible: false,
      reason: "fully_refunded",
    });
  });

  it("partially refunded order -> ineligible under deny policy (default)", () => {
    const data = order({ displayFinancialStatus: "PARTIALLY_REFUNDED" });
    expect(checkOrderEligibility(data, denyPolicy)).toEqual({
      eligible: false,
      reason: "partially_refunded_denied",
    });
  });

  it("partially refunded order -> eligible under explicit allow policy", () => {
    const data = order({ displayFinancialStatus: "PARTIALLY_REFUNDED" });
    expect(checkOrderEligibility(data, allowPolicy)).toEqual({ eligible: true, reason: "eligible" });
  });

  it("cancellation takes priority over an otherwise-eligible partial refund under allow policy", () => {
    const data = order({ displayFinancialStatus: "PARTIALLY_REFUNDED", cancelledAt: "2026-01-01T00:00:00Z" });
    expect(checkOrderEligibility(data, allowPolicy)).toEqual({ eligible: false, reason: "cancelled" });
  });
});
