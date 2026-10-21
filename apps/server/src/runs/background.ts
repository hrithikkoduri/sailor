/**
 * Background commands — the delivery half (decision #70).
 *
 * The engine detaches a shell command after `backgroundAfterSecs` and emits
 * `background_started` with a guest job id. This module:
 *
 *   1. persists that handle (background_jobs) when the event is recorded;
 *   2. polls it through the thread's RETAINED sandbox from the worker sweep;
 *   3. turns completion into a `background_result` inbox event, which the
 *      existing drain wakes as a normal next turn.
 *
 * Nothing here cancels a run and nothing here asks the model to poll. The
 * completion is delivered the same way a webhook is: an event that waits for
 * its turn.
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  type Sandbox,
  type SandboxSpec,
} from "anchor-ai-sdk";
import { local } from "anchor-ai-sdk/sandbox/local";
import { loadConfig } from "../config.js";
import { schema, type Db } from "../db/index.js";
import type { BackgroundJob } from "../db/schema.js";
import { sandboxProvider } from "../sandbox-provider.js";
import { appendEvent, drainInbox } from "../threads/inbox.js";
import type { Queues } from "../queue/index.js";
import type { GitHubAppService } from "../github/app.js";

export interface BackgroundSweepDeps {
  db: Db;
  queues: Queues;
  /** Dev/test: adopt local sandboxes instead of Heyo VMs. */
  local?: boolean;
  githubApp?: GitHubAppService;
  gitIdentity?: { name: string; email: string };
}

export interface BackgroundSweepResult {
  threadId: string;
  jobId: string;
  status: "done" | "lost";
  exitCode?: number;
}

const MAX_OUTPUT = 12_000;

/** Keep the tail: failures and totals live at the end of a long log. */
function trimOutput(output: string): string {
  if (output.length <= MAX_OUTPUT) return output;
  return `… (${output.length - MAX_OUTPUT} chars trimmed)\n${output.slice(-MAX_OUTPUT)}`;
}

/** Record the launch. Called from the run's trace chain — never the model. */
export async function recordBackgroundJob(
  db: Db,
  job: {
    runId: string;
    threadId: string;
    jobId: string;
    command?: string;
    sandboxId?: string;
    timeoutSecs?: number;
  },
): Promise<void> {
  await db
    .insert(schema.backgroundJobs)
    .values({
      runId: job.runId,
      threadId: job.threadId,
      jobId: job.jobId,
      command: job.command ?? null,
      sandboxId: job.sandboxId ?? null,
      timeoutSecs: job.timeoutSecs ?? 3600,
    })
    .onConflictDoNothing();
}

/**
 * Settle one job exactly once and enqueue its completion. The conditional
 * update is the claim: two sweep workers cannot both deliver the same result.
 */
async function settle(
  deps: BackgroundSweepDeps,
  job: BackgroundJob,
  status: "done" | "lost",
  result?: { exitCode: number; output: string },
  note?: string,
): Promise<boolean> {
  const output = result ? trimOutput(result.output) : undefined;
  const [updated] = await deps.db
    .update(schema.backgroundJobs)
    .set({
      status,
      exitCode: result?.exitCode ?? null,
      output: output ?? null,
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(schema.backgroundJobs.id, job.id),
        eq(schema.backgroundJobs.status, "running"),
      ),
    )
    .returning({ id: schema.backgroundJobs.id });
  if (!updated) return false;
  await appendEvent(deps.db, {
    threadId: job.threadId,
    kind: "background_result",
    payload: {
      jobId: job.jobId,
      command: job.command ?? "",
      status,
      ...(result ? { exitCode: result.exitCode } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(note ? { note } : {}),
    },
  });
  return true;
}

function specFor(
  deps: BackgroundSweepDeps,
  thread: { installationId: number | null; repo: string },
): SandboxSpec {
  return {
    // Adoption must keep the parked disk; the job lives on it.
    retain: true,
    ...(deps.gitIdentity ? { gitIdentity: deps.gitIdentity } : {}),
    ...(deps.githubApp && thread.installationId != null
      ? {
          git: {
            token: () => deps.githubApp!.tokenFor(thread.installationId!, [thread.repo.split("/")[1] ?? thread.repo]),
          },
        }
      : {}),
  };
}

/**
 * One sweep pass. Cheap when nothing is running. A job whose deadline has
 * passed without a receipt is killed and reported as lost — the same
 * fail-fast rule the exec adapter applies inside a run.
 */
export async function sweepBackgroundJobs(
  deps: BackgroundSweepDeps,
  opts: { now?: number } = {},
): Promise<BackgroundSweepResult[]> {
  const now = opts.now ?? Date.now();
  const running = await deps.db
    .select()
    .from(schema.backgroundJobs)
    .where(eq(schema.backgroundJobs.status, "running"));
  if (running.length === 0) return [];

  const byThread = new Map<string, BackgroundJob[]>();
  const active = await deps.db.select({ threadId: schema.runs.threadId }).from(schema.runs)
    .where(inArray(schema.runs.status, ["queued", "running"]));
  const activeThreads = new Set(active.map((r) => r.threadId));
  for (const job of running) {
    if (activeThreads.has(job.threadId)) continue; // the SDK owns live delivery
    const list = byThread.get(job.threadId) ?? [];
    list.push(job);
    byThread.set(job.threadId, list);
  }

  const cfg = loadConfig();
  const provider = deps.local ? local() : sandboxProvider(cfg);
  const results: BackgroundSweepResult[] = [];

  for (const [threadId, jobs] of byThread) {
    const [thread] = await deps.db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.id, threadId));
    if (!thread) {
      for (const job of jobs)
        await settle(deps, job, "lost", undefined, "thread no longer exists");
      continue;
    }
    if (!thread.sandboxId) {
      for (const job of jobs)
        await settle(
          deps,
          job,
          "lost",
          undefined,
          "the thread's sandbox was released before the command finished",
        );
      continue;
    }

    let sandbox: Sandbox;
    try {
      sandbox = provider.adopt(
        {
          id: thread.sandboxId,
          backend: thread.sandboxBackend ?? provider.name,
        },
        specFor(deps, thread),
      );
      await sandbox.start();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const job of jobs)
        await settle(
          deps,
          job,
          "lost",
          undefined,
          `retained sandbox unavailable: ${message}`,
        );
      continue;
    }

    let settledHere = 0;
    let stillRunning = 0;
    for (const job of jobs) {
      const expired =
        now - job.launchedAt.getTime() > (job.timeoutSecs + 90) * 1000;
      try {
        if (!sandbox.pollJob || !sandbox.killJob) {
          if (await settle(deps, job, "lost", undefined, "backend cannot poll background jobs"))
            settledHere++;
          continue;
        }
        if (expired) {
          const killed = await sandbox.killJob(job.jobId).catch(() => false);
          if (
            await settle(
              deps,
              job,
              "lost",
              undefined,
              killed
                ? "no completion receipt arrived; the job was killed"
                : "no completion receipt arrived; the sandbox may still be busy",
            )
          )
            settledHere++;
          continue;
        }
        const result = await sandbox.pollJob(job.jobId, {
          startedAt: job.launchedAt.getTime(),
          timeoutSecs: job.timeoutSecs,
        });
        if (!result) {
          stillRunning++;
          continue;
        }
        if (result.failure) {
          if (
            await settle(
              deps,
              job,
              "lost",
              undefined,
              result.failure.message,
            )
          )
            settledHere++;
          continue;
        }
        if (
          await settle(deps, job, "done", {
            exitCode: result.exitCode,
            output: result.output,
          })
        ) {
          settledHere++;
          results.push({
            threadId,
            jobId: job.jobId,
            status: "done",
            exitCode: result.exitCode,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/gone/i.test(message)) {
          if (await settle(deps, job, "lost", undefined, message)) settledHere++;
        } else {
          // Transient control-plane failure: try again next sweep, keep the
          // sandbox running (parking it would kill the job).
          stillRunning++;
        }
      }
    }

    if (stillRunning === 0) {
      // Never park a sandbox a run has adopted in the meantime.
      const active = await deps.db
        .select({ id: schema.runs.id })
        .from(schema.runs)
        .where(
          and(
            eq(schema.runs.threadId, threadId),
            inArray(schema.runs.status, ["queued", "running"]),
          ),
        )
        .limit(1);
      if (active.length === 0) await sandbox.destroy().catch(() => undefined);
    }

    if (settledHere > 0) {
      // The completion waits for its turn like any other event; the drain
      // returns null while a run is active and the post-turn drain picks it up.
      await drainInbox(deps, threadId);
    }
  }

  return results;
}
