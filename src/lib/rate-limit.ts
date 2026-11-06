/**
 * Shared, persistent rate limiter for the App Proxy access route, backed
 * by Turso (this service's existing DB) instead of an in-memory Map.
 *
 * Why not in-memory: Vercel can run several concurrent instances of the
 * same route, each with its own process memory — an in-memory counter
 * gives each instance an independent "N requests per window" budget, so
 * the effective limit in production is N * (number of warm instances),
 * not a real global N. A fixed-window counter in Turso is shared by every
 * instance.
 *
 * Concurrency: the check-and-increment happens in a single atomic
 * INSERT ... ON CONFLICT DO UPDATE ... RETURNING statement, so two
 * requests racing for the same key can't both read a stale pre-increment
 * count — each gets its own consistent post-increment value back from
 * the database.
 */

import { getDbClient } from "@/lib/db";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs?: number;
}

export async function checkRateLimit(
  key: string,
  windowMs: number,
  maxRequests: number,
  now: number = Date.now()
): Promise<RateLimitResult> {
  const db = getDbClient();
  const result = await db.execute({
    sql: `INSERT INTO rate_limit_buckets (key, count, window_start)
          VALUES (?, 1, ?)
          ON CONFLICT (key) DO UPDATE SET
            count = CASE WHEN ? - window_start >= ? THEN 1 ELSE count + 1 END,
            window_start = CASE WHEN ? - window_start >= ? THEN ? ELSE window_start END
          RETURNING count, window_start`,
    args: [key, now, now, windowMs, now, windowMs, now],
  });

  const row = result.rows[0];
  const count = Number(row?.count);
  const windowStart = Number(row?.window_start);

  if (count > maxRequests) {
    return { allowed: false, remaining: 0, retryAfterMs: windowStart + windowMs - now };
  }
  return { allowed: true, remaining: maxRequests - count };
}

/** Test-only helper to reset state between test cases. */
export async function _resetRateLimitStateForTests(): Promise<void> {
  const db = getDbClient();
  await db.execute("DELETE FROM rate_limit_buckets");
}
