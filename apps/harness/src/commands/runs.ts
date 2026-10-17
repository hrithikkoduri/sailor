/**
 * `harness runs enqueue` — create a thread (find-or-create) plus a queued run,
 * and push it into the runs queue. The manual door into the pipeline; the
 * webhook (step 12) will be the automatic one.
 */
import { and, eq } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { createDb, createPool, schema } from "../db/index.js";
import { createQueueConnection, createQueues, RUN_JOB_OPTIONS } from "../queue/index.js";

const USAGE = `Usage: harness runs enqueue --repo <url-or-path> --task "<text>" [options]

  --repo <url|path>   git URL, or a local path (dev)
  --task <text>       the instruction this run works on
  --issue <n>         issue number for the thread identity (default 1)
  --trigger <t>       label | manual | … (default manual)
`;

export async function runsCommand(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub !== "enqueue") {
    process.stderr.write(USAGE);
    return 1;
  }

  const flags = new Map<string, string>();
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined) {
      process.stderr.write(USAGE);
      return 1;
    }
    flags.set(key.slice(2), value);
  }

  const repo = flags.get("repo");
  const task = flags.get("task");
  if (!repo || !task) {
    process.stderr.write(USAGE);
    return 1;
  }
  const issueNumber = Number(flags.get("issue") ?? "1");
  const trigger = flags.get("trigger") ?? "manual";

  const cfg = loadConfig();
  const pool = createPool(cfg.postgres.url);
  const db = createDb(pool);
  const connection = createQueueConnection(cfg.redis.url);
  const queues = createQueues(connection);

  try {
    let [thread] = await db
      .select()
      .from(schema.threads)
      .where(and(eq(schema.threads.repo, repo), eq(schema.threads.issueNumber, issueNumber)));
    if (!thread) {
      [thread] = await db
        .insert(schema.threads)
        .values({ repo, issueNumber })
        .returning();
    }

    const [run] = await db
      .insert(schema.runs)
      .values({ threadId: thread!.id, trigger, task, status: "queued" })
      .returning();

    await queues.runs.add("run", { runId: run!.id }, RUN_JOB_OPTIONS);

    process.stdout.write(`thread ${thread!.id}\nrun    ${run!.id} (queued, trigger=${trigger})\n`);
    return 0;
  } finally {
    await queues.close();
    await pool.end();
  }
}
