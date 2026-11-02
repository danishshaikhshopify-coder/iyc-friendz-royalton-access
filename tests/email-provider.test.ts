import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * EMAIL_PROVIDER must fail loudly for anything it can't actually send
 * through — never silently fall back to the log-only "none" provider,
 * which would mean a real customer's access-ready email just vanishes
 * with no error anywhere. See src/lib/email.ts.
 *
 * config.ts reads process.env once at module-import time (it's a frozen
 * `as const` object), so each case here resets the module registry and
 * re-imports with EMAIL_PROVIDER already set, rather than mutating
 * process.env after config has already loaded (which would have no
 * effect on the already-evaluated config singleton).
 */

const ORIGINAL_PROVIDER = process.env.EMAIL_PROVIDER;

afterEach(() => {
  process.env.EMAIL_PROVIDER = ORIGINAL_PROVIDER;
  vi.resetModules();
});

async function sendWithProvider(provider: string) {
  vi.resetModules();
  process.env.EMAIL_PROVIDER = provider;
  const { sendAccessReadyEmail } = await import("@/lib/email");
  return sendAccessReadyEmail("customer@example.com", {
    accessPageUrl: "https://test-shop.example.com/apps/royalton-access?token=abc",
    orderName: "#1001",
  });
}

describe("getEmailSender provider selection", () => {
  it("throws for the documented-but-unimplemented 'smtp' provider instead of silently no-op'ing", async () => {
    await expect(sendWithProvider("smtp")).rejects.toThrow(/not implemented/i);
  });

  it("throws for an unrecognized provider value (typo) instead of silently no-op'ing", async () => {
    await expect(sendWithProvider("sendgrid")).rejects.toThrow(/not implemented/i);
  });

  it("still succeeds (log-only) for the explicit 'none' provider", async () => {
    const result = await sendWithProvider("none");
    expect(result.success).toBe(true);
  });
});
