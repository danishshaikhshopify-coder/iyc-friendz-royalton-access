-- Royalton Access — webhook_events idempotency fix.
--
-- Bug this fixes: the original webhook_events table recorded a
-- (shop_domain, webhook_id) row the moment a delivery was accepted,
-- BEFORE its handler ran. If the handler then threw (e.g. a missing
-- Admin API scope, a transient network error), Shopify's automatic retry
-- reused the same X-Shopify-Webhook-Id — and that retry was skipped as a
-- "duplicate", because the row already existed. Net effect: a failed
-- delivery could never be recovered by Shopify's own retry mechanism, and
-- silently never produced an access grant.
--
-- Fix: add a status column so a row only counts as a true duplicate once
-- its handler has actually completed successfully. See
-- src/lib/webhook-events.ts (claimWebhookEvent / markWebhookEventCompleted
-- / markWebhookEventFailed) for the state machine this supports:
--   processing -> completed   (handler succeeded, future deliveries of
--                               this webhook_id are now real duplicates)
--   processing -> failed      (handler threw, a future delivery of this
--                               same webhook_id — a Shopify retry — is
--                               allowed to reclaim and retry it)
--   failed -> processing      (a retry reclaiming a previously-failed row)
--
-- Existing rows predate this column and, under the old code, their mere
-- presence meant "already processed" — so they default to 'completed' to
-- preserve that historical behavior for anything already recorded. (Any
-- specific row known to have actually failed under the old code, such as
-- the one tied to the Task 19 QA incident, is corrected separately via an
-- explicit, audited one-row UPDATE — not by changing this default.)
--
-- updated_at's default must be a constant, not an expression: SQLite's
-- `ALTER TABLE ... ADD COLUMN` only accepts a non-constant default
-- (CURRENT_TIMESTAMP or an expression) when the column is nullable, and
-- this one is NOT NULL — Turso/libSQL rejects the `strftime(...)` form
-- below with a schema error. This was caught when applying this migration
-- to production, where it was run with the literal epoch constant used
-- here instead. Every row's `updated_at` gets overwritten by the webhook
-- state machine on its first real claim/complete/fail anyway, so the
-- placeholder default is never actually read as a meaningful timestamp.

ALTER TABLE webhook_events ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE webhook_events ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';

CREATE INDEX IF NOT EXISTS idx_webhook_events_status
  ON webhook_events (status);
