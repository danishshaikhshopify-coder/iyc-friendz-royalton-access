/**
 * CLI wrapper around registerWebhooks() (src/lib/webhook-registration.ts)
 * — registers this app's required webhook topics on the configured shop.
 *
 * Idempotent — safe to re-run any number of times, never creates
 * duplicates.
 *
 * Usage (after deploy + OAuth, run by the owner or CI):
 *   npm run register-webhooks
 * (defaults APP_BASE_URL to the production URL below; override it by
 * setting APP_BASE_URL yourself, e.g. against a preview deployment)
 */
import { registerWebhooks } from "@/lib/webhook-registration";

const DEFAULT_APP_BASE_URL = "https://iyc-friendz-royalton-access.vercel.app";

async function main() {
  const baseUrl = process.env.APP_BASE_URL || DEFAULT_APP_BASE_URL;
  const results = await registerWebhooks(baseUrl);

  for (const r of results) {
    if (r.status === "already_registered") {
      console.log(`[register-webhooks] ${r.topic} already points at ${r.callbackUrl} — skipping`);
    } else {
      console.log(`[register-webhooks] created ${r.topic} -> ${r.callbackUrl} (id ${r.id})`);
    }
  }
  console.log("[register-webhooks] done.");
}

main().catch((err) => {
  console.error("[register-webhooks] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
