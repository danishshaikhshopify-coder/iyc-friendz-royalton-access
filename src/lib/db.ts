/**
 * Turso / libSQL client singleton.
 *
 * For local dev and tests, config.db.url defaults to "file:./dev.db" so
 * this works with no live Turso credentials at all. In production it
 * points at a real Turso database URL + auth token.
 */

import { createClient, type Client } from "@libsql/client";
import { config } from "@/lib/config";

let client: Client | null = null;

export function getDbClient(): Client {
  if (!client) {
    client = createClient({
      url: config.db.url,
      authToken: config.db.authToken,
    });
  }
  return client;
}

/** Test-only helper to force a fresh client (e.g. pointed at a new file:/memory db). */
export function _resetDbClientForTests(): void {
  client = null;
}
