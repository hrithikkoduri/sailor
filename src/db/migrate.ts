/**
 * Migration runner (Drizzle's).
 *
 * Migrations are generated SQL files in /drizzle (created by
 * `npm run db:generate` from src/db/schema.ts), applied in order and recorded
 * in Drizzle's own `__drizzle_migrations` table. Re-running is a no-op —
 * safe on every deploy/boot.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Db } from "./index.js";

// repo-root/drizzle — resolves correctly from src/ (tsx) and from dist/ (built)
const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
