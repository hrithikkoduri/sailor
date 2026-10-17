/**
 * Postgres access via Drizzle.
 *
 * One connection pool per process; `createDb` wraps it in Drizzle's typed
 * query builder (see ./schema.ts for the table definitions this types off).
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export { schema };

export type Db = NodePgDatabase<typeof schema>;

export function createPool(url: string, max = 10): Pool {
  return new Pool({ connectionString: url, max });
}

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}
