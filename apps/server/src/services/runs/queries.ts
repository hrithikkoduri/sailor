import { asc, eq } from "drizzle-orm";
import { schema, type Db } from "../../db/index.js";

/** One run plus its full journal. */
export async function runDetailData(db: Db, runId: string) {
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  if (!run) return { run: undefined, trace: [] };
  const trace = await db.select().from(schema.traceEvents)
    .where(eq(schema.traceEvents.runId, run.id))
    .orderBy(asc(schema.traceEvents.seq));
  return { run, trace };
}

/** One run row by id. */
export async function findRun(db: Db, runId: string) {
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  return run;
}
