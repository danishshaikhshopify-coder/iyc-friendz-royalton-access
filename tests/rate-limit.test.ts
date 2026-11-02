import { describe, it, expect, beforeEach } from "vitest";
import { checkRateLimit, _resetRateLimitStateForTests } from "@/lib/rate-limit";

describe("checkRateLimit", () => {
  beforeEach(() => {
    _resetRateLimitStateForTests();
  });

  it("allows requests up to the max, then blocks", () => {
    const key = "1.2.3.4|token-abc";
    const max = 3;
    const windowMs = 60_000;
    const now = 1_000_000;

    expect(checkRateLimit(key, windowMs, max, now).allowed).toBe(true);
    expect(checkRateLimit(key, windowMs, max, now).allowed).toBe(true);
    expect(checkRateLimit(key, windowMs, max, now).allowed).toBe(true);
    const fourth = checkRateLimit(key, windowMs, max, now);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });

  it("resets after the window elapses", () => {
    const key = "1.2.3.4|token-abc";
    const max = 1;
    const windowMs = 1000;

    expect(checkRateLimit(key, windowMs, max, 0).allowed).toBe(true);
    expect(checkRateLimit(key, windowMs, max, 500).allowed).toBe(false);
    expect(checkRateLimit(key, windowMs, max, 1500).allowed).toBe(true);
  });

  it("tracks different keys independently", () => {
    const windowMs = 60_000;
    const max = 1;
    expect(checkRateLimit("key-a", windowMs, max, 0).allowed).toBe(true);
    expect(checkRateLimit("key-b", windowMs, max, 0).allowed).toBe(true);
    expect(checkRateLimit("key-a", windowMs, max, 0).allowed).toBe(false);
  });
});
