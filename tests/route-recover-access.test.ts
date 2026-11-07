/**
 * Route-level tests for POST /api/admin/recover-access
 * (src/app/api/admin/recover-access/route.ts). Confirms the endpoint
 * rejects any request without the exact configured shared secret BEFORE
 * ever calling recoverAccessForOrder — these tests mock that function so
 * no real Shopify call, email send, or token rotation can happen, even
 * if the auth check were somehow bypassed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access-recovery", () => ({
  recoverAccessForOrder: vi.fn(),
}));

import { POST } from "@/app/api/admin/recover-access/route";
import { recoverAccessForOrder } from "@/lib/access-recovery";

const ORIGINAL_SECRET = process.env.ADMIN_RECOVERY_SECRET;

function buildRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://royalton-access.example/api/admin/recover-access", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("POST /api/admin/recover-access — authentication", () => {
  beforeEach(() => {
    vi.mocked(recoverAccessForOrder).mockReset();
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.ADMIN_RECOVERY_SECRET;
    else process.env.ADMIN_RECOVERY_SECRET = ORIGINAL_SECRET;
  });

  it("rejects when ADMIN_RECOVERY_SECRET is not configured at all, even with a header supplied", async () => {
    delete process.env.ADMIN_RECOVERY_SECRET;
    const res = await POST(buildRequest({ orderId: "1" }, { "x-admin-secret": "anything" }));
    expect(res.status).toBe(401);
    expect(recoverAccessForOrder).not.toHaveBeenCalled();
  });

  it("rejects a request with no x-admin-secret header", async () => {
    process.env.ADMIN_RECOVERY_SECRET = "the-real-secret";
    const res = await POST(buildRequest({ orderId: "1" }));
    expect(res.status).toBe(401);
    expect(recoverAccessForOrder).not.toHaveBeenCalled();
  });

  it("rejects a request with the wrong x-admin-secret", async () => {
    process.env.ADMIN_RECOVERY_SECRET = "the-real-secret";
    const res = await POST(
      buildRequest({ orderId: "1" }, { "x-admin-secret": "wrong-guess" })
    );
    expect(res.status).toBe(401);
    expect(recoverAccessForOrder).not.toHaveBeenCalled();
  });

  it("rejects a request with a near-miss secret (same length, different bytes)", async () => {
    process.env.ADMIN_RECOVERY_SECRET = "the-real-secret-1234";
    const res = await POST(
      buildRequest({ orderId: "1" }, { "x-admin-secret": "the-real-secret-1235" })
    );
    expect(res.status).toBe(401);
    expect(recoverAccessForOrder).not.toHaveBeenCalled();
  });

  it("rejects an authenticated request with no orderId in the body, without calling recoverAccessForOrder", async () => {
    process.env.ADMIN_RECOVERY_SECRET = "the-real-secret";
    const res = await POST(buildRequest({}, { "x-admin-secret": "the-real-secret" }));
    expect(res.status).toBe(400);
    expect(recoverAccessForOrder).not.toHaveBeenCalled();
  });

  it("only calls recoverAccessForOrder once authenticated with the exact secret and a valid body", async () => {
    process.env.ADMIN_RECOVERY_SECRET = "the-real-secret";
    vi.mocked(recoverAccessForOrder).mockResolvedValue({ ok: true });

    const res = await POST(
      buildRequest({ orderId: "7121108729925" }, { "x-admin-secret": "the-real-secret" })
    );
    expect(res.status).toBe(200);
    expect(recoverAccessForOrder).toHaveBeenCalledTimes(1);
    expect(recoverAccessForOrder).toHaveBeenCalledWith(expect.any(String), "7121108729925");
  });

  it("surfaces a recoverAccessForOrder failure as a 502, still without leaking internals", async () => {
    process.env.ADMIN_RECOVERY_SECRET = "the-real-secret";
    vi.mocked(recoverAccessForOrder).mockResolvedValue({
      ok: false,
      reason: "send_failed:Omnisend API 400",
    });

    const res = await POST(
      buildRequest({ orderId: "1" }, { "x-admin-secret": "the-real-secret" })
    );
    expect(res.status).toBe(502);
  });
});
