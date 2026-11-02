-- Royalton Access — initial schema.
--
-- Design notes (see Task 17 report, section on data model):
--  * Minimum fields only. No customer name, email, or other PII is stored
--    here — the email address lives in Shopify/the email provider, not in
--    this database. Only the Shopify order id is kept, as the join key.
--  * The real Royalton booking URL is never stored in this database. It
--    lives only in server-side configuration (ROYALTON_BOOKING_URL).
--  * access_grants.token_hash is the ONLY token-related value ever
--    persisted — never the raw token.
--  * webhook_events exists purely for idempotency: Shopify may deliver the
--    same webhook more than once (retries), and this table lets the
--    webhook handlers detect and skip a duplicate before it would
--    re-process an order or re-send an email.

CREATE TABLE IF NOT EXISTS access_grants (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_domain        TEXT NOT NULL,
  order_id           TEXT NOT NULL,
  token_hash         TEXT NOT NULL,
  token_created_at   TEXT NOT NULL,
  revoked            INTEGER NOT NULL DEFAULT 0,
  revoked_at         TEXT,
  email_sent         INTEGER NOT NULL DEFAULT 0,
  email_sent_at      TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  UNIQUE (shop_domain, order_id),
  UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS idx_access_grants_token_hash
  ON access_grants (token_hash);

CREATE TABLE IF NOT EXISTS webhook_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_domain    TEXT NOT NULL,
  webhook_id     TEXT NOT NULL,
  topic          TEXT NOT NULL,
  processed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  UNIQUE (shop_domain, webhook_id)
);
