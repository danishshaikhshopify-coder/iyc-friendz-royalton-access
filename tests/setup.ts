/**
 * Vitest global setup: provides fake-but-valid env vars so config.ts's
 * required() checks pass with no live Shopify/Turso/email credentials,
 * points the DB at a fresh temp SQLite file, and applies migrations to it
 * before any test runs.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dbPath = join(
  os.tmpdir(),
  `royalton-access-test-${process.pid}-${Date.now()}.db`
);

process.env.SHOPIFY_SHOP_DOMAIN = "test-shop.myshopify.com";
process.env.SHOPIFY_STOREFRONT_DOMAIN = "test-shop.example.com";
process.env.SHOPIFY_ADMIN_API_VERSION = "2026-01";
process.env.SHOPIFY_WEBHOOK_SIGNING_SECRET = "test-webhook-secret";
process.env.SHOPIFY_APP_PROXY_SIGNING_SECRET = "test-app-proxy-secret";
process.env.SHOPIFY_APP_PROXY_SUBPATH = "/apps/royalton-access";
process.env.ACCESS_TOKEN_SIGNING_SECRET = "test-token-signing-secret";
process.env.SHOPIFY_API_KEY = "test-oauth-client-id";
process.env.SHOPIFY_API_SECRET = "test-oauth-client-secret";
// Must be valid base64 for exactly 32 bytes — crypto.ts enforces this.
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
process.env.EMAIL_PROVIDER = "none";
process.env.PARTIAL_REFUND_POLICY = "deny";
process.env.EVENT_PASS_PRODUCT_HANDLE = "iyc-friendz-weekend-pass";
// Deliberately left unset, matching production default behavior:
delete process.env.ROYALTON_BOOKING_URL;

const { getDbClient } = await import("../src/lib/db");

const db = getDbClient();
const migrationsDir = join(__dirname, "..", "src", "db", "migrations");
const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

for (const file of files) {
  const sql = readFileSync(join(migrationsDir, file), "utf-8");
  const statements = sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const statement of statements) {
    await db.execute(statement);
  }
}
