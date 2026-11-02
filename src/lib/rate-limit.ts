/**
 * Minimal in-memory rate limiter for the App Proxy access route.
 *
 * LIMITATION (documented, not hidden): this is a single-process, in-memory
 * sliding-window counter. It works correctly on a single long-running
 * server instance. It does NOT coordinate across multiple serverless
 * instances/regions (e.g. Vercel can run several concurrent instances of
 * the same route), so under that kind of deployment the effective limit
 * is "N requests per window, per instance" rather than a hard global cap.
 *
 * For this use case (slowing down token-guessing against the access
 * route, not protecting a high-traffic endpoint) that's an acceptable
 * first line of defense, but it is not a substitute for the token's own
 * entropy, and should be upgraded to a shared store (e.g. a Turso table,
 * or Redis) before relying on it as a hard limit in a multi-instance
 * production deployment. That upgrade is noted as a remaining item in the
 * Task 17 report rather than implemented here, to keep this service's
 * dependency footprint minimal until it's known whether it matters for
 * the actual deployment target.
 */

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs?: number;
}

export function checkRateLimit(
  key: string,
  windowMs: number,
  maxRequests: number,
  now: number = Date.now()
): RateLimitResult {
  const existing = buckets.get(key);

  if (!existing || now - existing.windowStart >= windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: maxRequests - 1 };
  }

  if (existing.count >= maxRequests) {
    const retryAfterMs = existing.windowStart + windowMs - now;
    return { allowed: false, remaining: 0, retryAfterMs };
  }

  existing.count += 1;
  return { allowed: true, remaining: maxRequests - existing.count };
}

/** Test-only helper to reset state between test cases. */
export function _resetRateLimitStateForTests(): void {
  buckets.clear();
}
