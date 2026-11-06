import { describe, it, expect, beforeEach } from "vitest";
import { checkRateLimit, _resetRateLimitStateForTests } from "@/lib/rate-limit";

describe("checkRateLimit", () => {
  beforeEach(async () => {
    await _resetRateLimitStateForTests();
  });

  it("allows requests up to the max, then blocks", async () => {
    const key = "1.2.3.4|token-abc";
    const max = 3;
    const windowMs = 60_000;
    const now = 1_000_000;

    expect((await checkRateLimit(key, windowMs, max, now)).allowed).toBe(true);
    expect((await checkRateLimit(key, windowMs, max, now)).allowed).toBe(true);
    expect((await checkRateLimit(key, windowMs, max, now)).allowed).toBe(true);
    const fourth = await checkRateLimit(key, windowMs, max, now);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });

  it("resets after the window elapses", async () => {
    const key = "1.2.3.4|token-abc";
    const max = 1;
    const windowMs = 1000;

    expect((await checkRateLimit(key, windowMs, max, 0)).allowed).toBe(true);
    expect((await checkRateLimit(key, windowMs, max, 500)).allowed).toBe(false);
    expect((await checkRateLimit(key, windowMs, max, 1500)).allowed).toBe(true);
  });

  it("tracks different keys independently", async () => {
    const windowMs = 60_000;
    const max = 1;
    expect((await checkRateLimit("key-a", windowMs, max, 0)).allowed).toBe(true);
    expect((await checkRateLimit("key-b", windowMs, max, 0)).allowed).toBe(true);
    expect((await checkRateLimit("key-a", windowMs, max, 0)).allowed).toBe(false);
  });

  it("REGRESSION: concurrent requests for the same new key don't all get allowed (shared, not per-instance, counting)", async () => {
    const key = "concurrent-key";
    const max = 5;
    const windowMs = 60_000;
    const now = 1_000_000;

    const results = await Promise.all(
      Array.from({ length: 10 }, () => checkRateLimit(key, windowMs, max, now))
    );
    const allowedCount = results.filter((r) => r.allowed).length;
    expect(allowedCount).toBe(max);
  });
});
