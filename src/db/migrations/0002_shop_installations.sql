-- Royalton Access — Shopify OAuth installation storage (Task 17 OAuth
-- migration). Stores one row per installed shop: the encrypted offline
-- access token (and refresh token, when Shopify issues one), granted
-- scope, and installation/uninstallation state.
--
-- Design notes:
--  * access_token_enc / refresh_token_enc store ONLY encrypted values
--    (AES-256-GCM via src/lib/crypto.ts, keyed by TOKEN_ENCRYPTION_KEY) —
--    never plaintext.
--  * UNIQUE(shop_domain) enforces exactly one installation row per shop —
--    both reauthorization and uninstall/reinstall upsert this same row.
--  * revoked / uninstalled_at let token retrieval fail closed for a shop
--    that has uninstalled the app, without deleting the audit trail.
--  * Purely additive — does not touch access_grants or webhook_events.

CREATE TABLE IF NOT EXISTS shop_installations (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_domain        TEXT NOT NULL UNIQUE,
  access_token_enc   TEXT NOT NULL,
  refresh_token_enc  TEXT,
  scope              TEXT NOT NULL,
  token_expires_at   TEXT,
  revoked            INTEGER NOT NULL DEFAULT 0,
  installed_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  uninstalled_at     TEXT,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
