import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

/**
 * Resend adapter tests (src/lib/email.ts). config.ts reads process.env
 * once at import time, so switching EMAIL_PROVIDER/RESEND_API_KEY between
 * tests requires resetting the module registry before each re-import,
 * same pattern as tests/email-provider.test.ts.
 */

const ORIGINAL_PROVIDER = process.env.EMAIL_PROVIDER;
const ORIGINAL_KEY = process.env.RESEND_API_KEY;

beforeEach(() => {
  vi.resetModules();
  process.env.EMAIL_PROVIDER = "resend";
  process.env.RESEND_API_KEY = "test-resend-key";
});

afterEach(() => {
  process.env.EMAIL_PROVIDER = ORIGINAL_PROVIDER;
  process.env.RESEND_API_KEY = ORIGINAL_KEY;
  vi.unstubAllGlobals();
  vi.resetModules();
});

const PARAMS = {
  accessPageUrl: "https://test-shop.example.com/apps/royalton-access?token=abc",
  orderName: "#1234",
};

describe("Resend email adapter", () => {
  it("reports success and returns the provider message id when Resend accepts the email", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: "resend-msg-123" }),
      })
    );
    const { sendAccessReadyEmail } = await import("@/lib/email");
    const result = await sendAccessReadyEmail("customer@example.com", PARAMS);
    expect(result.success).toBe(true);
    expect(result.providerMessageId).toBe("resend-msg-123");
  });

  it("reports a genuine failure when Resend rejects the request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: async () => "invalid from address",
      })
    );
    const { sendAccessReadyEmail } = await import("@/lib/email");
    const result = await sendAccessReadyEmail("customer@example.com", PARAMS);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/422/);
  });

  it("reports failure, not a throw, when RESEND_API_KEY is missing", async () => {
    process.env.RESEND_API_KEY = "";
    const { sendAccessReadyEmail } = await import("@/lib/email");
    const result = await sendAccessReadyEmail("customer@example.com", PARAMS);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/RESEND_API_KEY/);
  });

  it("REGRESSION: a request timeout (AbortError) is reported as a failure (safe to retry), not thrown and not reported as success", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));
    const { sendAccessReadyEmail } = await import("@/lib/email");
    const result = await sendAccessReadyEmail("customer@example.com", PARAMS);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });

  it("passes the idempotencyKey through as the Idempotency-Key header when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const { sendAccessReadyEmail } = await import("@/lib/email");
    await sendAccessReadyEmail("customer@example.com", PARAMS, "key-123");
    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers["Idempotency-Key"]).toBe("key-123");
  });

  it("does not set an Idempotency-Key header when none is provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const { sendAccessReadyEmail } = await import("@/lib/email");
    await sendAccessReadyEmail("customer@example.com", PARAMS);
    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers["Idempotency-Key"]).toBeUndefined();
  });
});
