import { describe, it, expect } from "vitest";
import { renderAccessReadyEmailForTests } from "@/lib/email";
import { renderAccessPageHtml } from "@/lib/access-page";

const FAKE_REAL_ROYALTON_URL = "https://booking.royaltonbavaro-secret.example/private/abc123";
const ACCESS_PAGE_URL = "https://test-shop.example.com/apps/royalton-access?token=sometoken";

describe("Royalton URL never leaks where it shouldn't", () => {
  it("the access-ready email (html + text) never contains the real booking URL", () => {
    const rendered = renderAccessReadyEmailForTests({
      accessPageUrl: ACCESS_PAGE_URL,
      orderName: "#1001",
    });
    expect(rendered.html).not.toContain(FAKE_REAL_ROYALTON_URL);
    expect(rendered.text).not.toContain(FAKE_REAL_ROYALTON_URL);
    // It DOES contain the secure access page link — that's the point.
    expect(rendered.html).toContain(ACCESS_PAGE_URL);
    expect(rendered.text).toContain(ACCESS_PAGE_URL);
  });

  it("the ineligible access-page state never contains the real booking URL", () => {
    const html = renderAccessPageHtml({ kind: "ineligible" });
    expect(html).not.toContain(FAKE_REAL_ROYALTON_URL);
    expect(html.toLowerCase()).not.toContain("royalton.com"); // no accidental hint of a real domain
  });

  it("the eligible-but-url-pending state never contains a booking URL (none is configured)", () => {
    const html = renderAccessPageHtml({ kind: "eligible_url_pending" });
    expect(html).not.toContain(FAKE_REAL_ROYALTON_URL);
    expect(html).not.toMatch(/href="https?:\/\//);
  });

  it("the error and rate-limited states never contain a booking URL", () => {
    expect(renderAccessPageHtml({ kind: "error" })).not.toContain(FAKE_REAL_ROYALTON_URL);
    expect(renderAccessPageHtml({ kind: "rate_limited" })).not.toContain(FAKE_REAL_ROYALTON_URL);
  });

  it("the eligible state contains the booking URL ONLY in the button href, and renders the exact required copy", () => {
    const html = renderAccessPageHtml({ kind: "eligible", bookingUrl: FAKE_REAL_ROYALTON_URL });
    expect(html).toContain(`href="${FAKE_REAL_ROYALTON_URL}"`);
    expect(html).toContain("YOUR ROYALTON BOOKING LINK IS READY!");
    expect(html).toContain("BOOK YOUR ROYALTON ROOM");
  });

  it("the ineligible state never reveals a specific denial reason", () => {
    const html = renderAccessPageHtml({ kind: "ineligible" });
    for (const forbidden of ["refund", "cancel", "unrelated", "unpaid", "pending"]) {
      expect(html.toLowerCase()).not.toContain(forbidden);
    }
  });
});
