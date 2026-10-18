/**
 * `harness worker` — the long-lived process.
 *
 * Consumes the BullMQ `runs` queue (concurrency 1: one agent run at a time in
 * this process) and drives the recurring sweep on the `babysit` queue. A
 * killed worker is exactly what the sweep exists for: its stale heartbeat is
 * detected, the run is interrupted, and a resume run is queued — which the
 * NEXT worker instance picks up and completes.
 *
 * Failure policy: a run that ends `failed` is RECORDED, not thrown — BullMQ
 * retries are reserved for infrastructure errors (a throw from executeRun),
 * while "the agent couldn't fix it" is a product outcome with a trace.
 */
import { Worker } from "bullmq";
import { loadConfig } from "../config.js";
import { createDb, createPool } from "../db/index.js";
import {
  BABYSIT_REPEAT_MS,
  createQueueConnection,
  createQueues,
  type BabysitJobData,
  type RunJobData,
} from "../queue/index.js";
import { createGitHubClient } from "../github/client.js";
import { executeRun } from "../runs/execute.js";
import { drainInbox } from "../threads/inbox.js";
import { handleSweep } from "./sweep.js";
import { runBabysitSweep } from "./babysit.js";

const USAGE = `Usage: harness worker [options]

  --local                  run sandboxes on this machine (dev; default: heyo microVMs)
  --sweep-every-ms <n>     how often to check for stale runs (default 60000, min 5000)
  --heartbeat-every-ms <n> lease cadence while running (default 30000, min 500)
  --stale-after-ms <n>     heartbeat age that marks a run dead (default 120000;
                           must be at least 1.5x the heartbeat interval)
`;

export async function workerCommand(argv: string[]): Promise<number> {
  const local = argv.includes("--local");
  const sweepIdx = argv.indexOf("--sweep-every-ms");
  const sweepEveryMs = sweepIdx !== -1 ? Number(argv[sweepIdx + 1]) : 60_000;
  const heartbeatIdx = argv.indexOf("--heartbeat-every-ms");
  const heartbeatEveryMs = heartbeatIdx !== -1 ? Number(argv[heartbeatIdx + 1]) : 30_000;
  const staleIdx = argv.indexOf("--stale-after-ms");
  const staleAfterMs = staleIdx !== -1 ? Number(argv[staleIdx + 1]) : 120_000;
  if (
    !Number.isFinite(sweepEveryMs) ||
    sweepEveryMs < 5_000 ||
    !Number.isFinite(heartbeatEveryMs) ||
    heartbeatEveryMs < 500 ||
    !Number.isFinite(staleAfterMs) ||
    staleAfterMs < heartbeatEveryMs * 1.5
  ) {
    // The threshold must outlive the cadence, or the sweep eats its own live
    // runs (learned the hard way in the kill-the-worker demo).
    process.stderr.write(USAGE);
    return 1;
  }

  const cfg = loadConfig();
  const pool = createPool(cfg.postgres.url);
  const db = createDb(pool);

  // GitHub access for the babysitter + PR delivery (optional in dev).
  const github = cfg.github.token ? createGitHubClient({ token: cfg.github.token }) : undefined;

  const queueConnection = createQueueConnection(cfg.redis.url);
  const queues = createQueues(queueConnection);
  const runsWorkerConnection = createQueueConnection(cfg.redis.url);
  const babysitWorkerConnection = createQueueConnection(cfg.redis.url);

  const runs = new Worker<RunJobData>(
    "runs",
    async (job) => {
      const outcome = await executeRun({
        db,
        runId: job.data.runId,
        local,
        heartbeatEveryMs,
        ...(github ? { github } : {}),
      });
      const watching =
        outcome.disposition === "watch"
          ? ` [watch${outcome.resumeAt ? ` → resume at ${outcome.resumeAt}` : ""}]`
          : "";
      process.stdout.write(
        `[worker] run ${job.data.runId} → ${outcome.status}${outcome.summary ? ` — ${outcome.summary.replace(/\s+/g, " ").slice(0, 90)}` : ""}${watching}\n`,
      );
      // Post-turn consumer: events that queued up while this run was busy
      // become the NEXT run (coalesced into one task). A cancelled run
      // (interjected — decision #28) resumes the batch at the phase it stopped.
      const drained = await drainInbox(
        { db, queues },
        outcome.threadId,
        outcome.status === "cancelled" && outcome.phase ? { startPhase: outcome.phase } : {},
      );
      if (drained) process.stdout.write(`[worker] inbox drain → run ${drained.id} queued\n`);
    },
    { connection: runsWorkerConnection, concurrency: 1 },
  );

  const babysit = new Worker<BabysitJobData>(
    "babysit",
    async (job) => {
      // Two kinds of scheduled work share this queue: the stale-run sweep
      // (recovery) and the PR babysitter (step 13).
      if (job.name === "babysit") {
        if (!github) return; // no token — nothing to inspect
        const results = await runBabysitSweep(
          { db, queues, github, botLogin: cfg.github.botLogin },
          { threadId: job.data.threadId },
        );
        const notable = results.filter((r) => r.action !== "quiet" && r.action !== "busy");
        if (notable.length > 0) {
          process.stdout.write(
            `[worker] babysit: ${notable.map((r) => `${r.threadId.slice(0, 8)} → ${r.action}`).join("; ")}\n`,
          );
        }
        return;
      }
      const results = await handleSweep({ db, queues }, { staleAfterMs });
      if (results.length > 0) {
        process.stdout.write(`[worker] sweep: ${results.length} stale run(s) recovered → resume queued\n`);
      }
    },
    { connection: babysitWorkerConnection, concurrency: 1 },
  );

  // The recurring sweep (BullMQ 6 Job Scheduler — the modern replacement for
  // repeatable jobs; the scheduler id keeps it singular).
  await queues.babysit.upsertJobScheduler("sweep-stale-runs", { every: sweepEveryMs }, { name: "sweep", data: {} });
  // The PR babysitter: every 10 minutes, check open agent PRs for silent
  // problems (merge conflicts, failed checks, missed comments) — step 13.
  await queues.babysit.upsertJobScheduler("babysit-prs", { every: BABYSIT_REPEAT_MS }, { name: "babysit", data: {} });

  process.stdout.write(
    `[worker] up — backend: ${local ? "local (dev, no isolation)" : "heyo"}, sweep every ${sweepEveryMs}ms, queue: runs (concurrency 1)` +
      `${github ? `, babysit every ${Math.round(BABYSIT_REPEAT_MS / 60_000)}min` : " (no GITHUB_TOKEN — babysitter idle)"}\n`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`[worker] ${signal} — draining (finishing the active run)…\n`);
    await runs.close().catch(() => undefined); // waits for the active job
    await babysit.close().catch(() => undefined);
    await queues.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Stay alive until a signal arrives.
  return await new Promise<number>(() => undefined);
}
