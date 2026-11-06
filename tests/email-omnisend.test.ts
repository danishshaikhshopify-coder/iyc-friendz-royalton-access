import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

/**
 * Omnisend adapter tests (src/lib/email.ts), against the CURRENT Events
 * API (POST /api/events, Omnisend-Version: 2026-03-15) — not the
 * deprecated /v3/events or /v5/events shapes. config.ts reads
 * process.env once at import time, so switching EMAIL_PROVIDER/
 * OMNISEND_API_KEY between tests requires resetting the module registry
 * before each re-import, same pattern as tests/email-provider.test.ts.
 */

const ORIGINAL_PROVIDER = process.env.EMAIL_PROVIDER;
const ORIGINAL_KEY = process.env.OMNISEND_API_KEY;

beforeEach(() => {
  vi.resetModules();
  process.env.EMAIL_PROVIDER = "omnisend";
  process.env.OMNISEND_API_KEY = "test-omnisend-key";
});

afterEach(() => {
  process.env.EMAIL_PROVIDER = ORIGINAL_PROVIDER;
  process.env.OMNISEND_API_KEY = ORIGINAL_KEY;
  vi.unstubAllGlobals();
  vi.resetModules();
});

const PARAMS = {
  accessPageUrl: "https://test-shop.example.com/apps/royalton-access?token=abc",
  orderName: "#1234",
};

describe("Omnisend email adapter", () => {
  it("reports success only for the documented 202 Accepted response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 202, text: async () => "" }));
    const { sendAccessReadyEmail } = await import("@/lib/email");
    const result = await sendAccessReadyEmail("customer@example.com", PARAMS);
    expect(result.success).toBe(true);
  });

  it("hits the current Events API endpoint with the documented auth, version and content-type headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 202, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
    const { sendAccessReadyEmail } = await import("@/lib/email");
    await sendAccessReadyEmail("customer@example.com", PARAMS);

    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://api.omnisend.com/api/events");
    expect(init.headers["Authorization"]).toBe("Omnisend-API-Key test-omnisend-key");
    expect(init.headers["Omnisend-Version"]).toBe("2026-03-15");
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("fires the dedicated royalton_access_ready event with the contact email nested correctly and the access URL in properties", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 202, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
    const { sendAccessReadyEmail } = await import("@/lib/email");
    await sendAccessReadyEmail("customer@example.com", PARAMS);

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.eventName).toBe("royalton_access_ready");
    expect(body.origin).toBe("api");
    expect(body.contact.email).toBe("customer@example.com");
    expect(body.properties.access_page_url).toBe(PARAMS.accessPageUrl);
    expect(body.properties.order_name).toBe(PARAMS.orderName);
  });

  it("reports a genuine failure, with the validation detail, when Omnisend rejects the request (400)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 400,
        text: async () =>
          JSON.stringify({
            title: "Validation failed",
            errors: [{ field: "contact.email", message: "Must be a valid email address" }],
          }),
      })
    );
    const { sendAccessReadyEmail } = await import("@/lib/email");
    const result = await sendAccessReadyEmail("customer@example.com", PARAMS);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/400/);
    expect(result.error).toMatch(/valid email address/i);
  });

  it("REGRESSION: a non-202 2xx response is not treated as acceptance (only 202 is documented)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, text: async () => "" }));
    const { sendAccessReadyEmail } = await import("@/lib/email");
    const result = await sendAccessReadyEmail("customer@example.com", PARAMS);
    expect(result.success).toBe(false);
  });

  it("reports failure, not a throw, when OMNISEND_API_KEY is missing", async () => {
    process.env.OMNISEND_API_KEY = "";
    const { sendAccessReadyEmail } = await import("@/lib/email");
    const result = await sendAccessReadyEmail("customer@example.com", PARAMS);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/OMNISEND_API_KEY/);
  });

  it("REGRESSION: a request timeout (AbortError) is reported as a failure, not thrown and not reported as success", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));
    const { sendAccessReadyEmail } = await import("@/lib/email");
    const result = await sendAccessReadyEmail("customer@example.com", PARAMS);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });
});
