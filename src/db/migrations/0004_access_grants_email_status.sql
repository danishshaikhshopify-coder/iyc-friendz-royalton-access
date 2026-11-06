-- Royalton Access — accurate email delivery status for access_grants.
--
-- Bug this fixes: the no-op ("none") email provider returned success,
-- so the application recorded email_sent = 1 even though no email was
-- ever transmitted (see src/lib/email.ts). email_sent/email_sent_at are
-- kept as-is for backward compatibility (still set only on a genuine
-- provider acceptance), and these new columns become the detailed source
-- of truth: email_status distinguishes "never attempted" from "a real
-- provider rejected it", email_attempts bounds how many times a send has
-- been tried, and email_last_error records why the most recent attempt
-- failed (never the raw token) — letting a failed/never-sent grant be
-- retried safely without creating a second grant or a second order.

ALTER TABLE access_grants ADD COLUMN email_status TEXT NOT NULL DEFAULT 'not_sent';
ALTER TABLE access_grants ADD COLUMN email_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE access_grants ADD COLUMN email_last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_access_grants_email_status
  ON access_grants (email_status);
