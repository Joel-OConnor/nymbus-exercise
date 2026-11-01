import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "./pool";

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "sql");
const MIGRATION_LOCK = 4200;

/**
 * Apply every sql/*.sql file not yet recorded in schema_migrations, in name
 * order, under an advisory lock so several instances booting at once don't
 * trip over each other. Idempotent; safe to call from every service at start.
 */
export async function runMigrations(pool: Pool, log: (msg: string) => void = () => {}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const applied = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    const files = (await readdir(SQL_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(SQL_DIR, file), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      log(`applied migration ${file}`);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
