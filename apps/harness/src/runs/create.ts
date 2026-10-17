/**
 * createRun — the one way a new run enters the pipeline.
 *
 * Two steps, deliberately: the Postgres row is the source of truth (the run
 * exists even if every worker is dead), the queue job is just the doorbell a
 * worker answers. Every producer uses this: the CLI, the sweep's resumes, and
 * (steps 11/12/18) the webhook and interjection handlers.
 */
import type { Queues } from "../queue/index.js";
import { RUN_JOB_OPTIONS } from "../queue/index.js";
import { schema, type Db } from "../db/index.js";

export interface NewRunSpec {
  threadId: string;
  /** Why this run exists: label | manual | resume | chat | babysit_ci | … */
  trigger: string;
  /** The instruction this run works on. */
  task?: string;
}

export async function createRun(deps: { db: Db; queues: Queues }, spec: NewRunSpec) {
  const [run] = await deps.db
    .insert(schema.runs)
    .values({ threadId: spec.threadId, trigger: spec.trigger, task: spec.task ?? null, status: "queued" })
    .returning();
  await deps.queues.runs.add("run", { runId: run!.id }, RUN_JOB_OPTIONS);
  return run!;
}
