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
      await db.execute(statement);
    }
  }

  console.log("Migrations complete.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
