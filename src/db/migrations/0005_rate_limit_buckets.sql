-- Royalton Access — persistent rate-limit storage.
--
-- Bug this fixes: the App Proxy access route's rate limiter
-- (src/lib/rate-limit.ts) was an in-memory Map, which does not coordinate
-- across multiple concurrent Vercel serverless instances — each instance
-- got its own independent "N requests per window" budget, so the actual
-- effective limit in production was N * (number of concurrently warm
-- instances), not N. Moving the counter into Turso (already this
-- service's shared store) makes it a real, single global limit.

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
