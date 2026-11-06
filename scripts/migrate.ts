/**
 * Runs every .sql file in src/db/migrations, in filename order, against the
 * configured database. Safe to re-run (migrations use IF NOT EXISTS).
 *
 * Usage: npm run db:migrate
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDbClient } from "@/lib/db";

async function main() {
  const migrationsDir = join(process.cwd(), "src/db/migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const db = getDbClient();

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    const statements = sql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    console.log(`Applying ${file} (${statements.length} statement(s))...`);
    for (const statement of statements) {
      try {
        await db.execute(statement);
      } catch (err) {
        // ALTER TABLE ADD COLUMN has no IF NOT EXISTS in SQLite/libSQL, so
        // a column added by an already-applied migration makes a re-run
        // throw here rather than no-op. Treat that specific case as
        // already-done and keep going, so this script stays safe to
        // re-run (its own doc comment's promise) instead of requiring the
        // next migration to be applied by hand against production, as
        // 0003 had to be.
        const message = err instanceof Error ? err.message : String(err);
        if (/duplicate column name|already exists/i.test(message)) {
          console.log(`  (already applied, skipping) ${statement.split("\n")[0]}`);
          continue;
        }
        throw err;
      }
    }
  }

  console.log("Migrations complete.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
