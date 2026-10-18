/**
 * executeRun — one DB-backed agent run, end to end.
 *
 * The worker's core, but deliberately a plain function so the CLI, evals, and
 * tests can call it with injected dependencies. It owns the full lifecycle:
 *
 *   load run + thread → sandbox (local/heyo) → runAgent with
 *   heartbeat + AbortController + dual-sink traces → status transitions,
 *   usage, and the thread's checkpoint pointer recorded.
 *
 * Status mapping: finished+ok → succeeded; cancelled/paused/anything else →
 * the matching run status. A cancel button elsewhere calls cancelRun(runId).
 */
import path from "node:path";
import { eq } from "drizzle-orm";
import {
  JsonlTrace,
  codingAgent,
  createLLMClient,
  createSandbox,
  runAgent,
  type AgentEvent,
  type LLMClient,
  type Sandbox,
  type SandboxSpec,
} from "@harness/agent";
import { loadConfig } from "../config.js";
import { schema, type Db } from "../db/index.js";
import { PostgresThreadStore } from "../threads/thread-store.js";
import { ensureThreadState, type ThreadState } from "../threads/state.js";
import { TraceRecorder } from "../trace/store.js";
import type { GitHubAppService } from "../github/app.js";
import { deliverPullRequest } from "../github/pr.js";
import { githubRepoUrl } from "../github/repo.js";
import { withHeartbeat } from "./lease.js";

/** Live AbortControllers, keyed by run id — the cancel button's registry. */
const activeControllers = new Map<string, AbortController>();

export function cancelRun(runId: string): boolean {
  const controller = activeControllers.get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export interface ExecuteRunDeps {
  db: Db;
  runId: string;
  /** Dev/test: run the sandbox locally. Explicit injection — never config. */
  local?: boolean;
  /** Lease cadence (default 30s). Must stay well below the sweep's stale threshold. */
  heartbeatEveryMs?: number;
  /** Force where the run starts (the package's startPhase). The product uses
   * this to resume interjected work at the phase the interrupted run reports
   * (read from its `runs.phase` column). Undefined = the thread's resume
   * position, else the first phase. */
  startPhase?: string;
  /**
   * How often the run watches for a durable cancel request (default 2000ms).
   * `requestCancel()` (lease.ts) works from ANY process; this watcher is the
   * worker half. Cancel latency = this interval.
   */
  cancelWatchEveryMs?: number;
  /** Test seams. */
  llm?: LLMClient;
  sandboxFactory?: (spec: SandboxSpec) => Sandbox;
  /** The GitHub App service (decisions #42/#43) — minting tokens for this run. */
  githubApp?: GitHubAppService;
  /** Live-update nudge (step 17b): "thread changed — refetch" (server/stream.ts). */
  notify?: (threadId: string) => void;
}

export interface ExecuteRunOutcome {
  runId: string;
  threadId: string;
  status: "succeeded" | "failed" | "cancelled" | "paused";
  reason: string;
  summary?: string;
  /** Set when the agent declared one via finish(): done | watch | blocked. */
  disposition?: "done" | "watch" | "blocked";
  /** Product-defined watch spec (e.g. { checks: true, comments: true }). */
  watch?: Record<string, unknown>;
  resumeAt?: string;
  /** The phase the run ended in — the drain uses it to resume cancelled work. */
  phase?: string;
}

const isUrl = (repo: string) => /^(https?:\/\/|git@|ssh:\/\/)/.test(repo);

/**
 * Where a thread's work happens. GitHub threads clone the repo — and once a PR
 * exists, its HEAD BRANCH: the pushed branch is the handoff point across runs
 * (babysitting continues on it; first runs start from the default branch and
 * push a new one at delivery).
 */
export function sandboxSpecForThread(
  thread: Pick<typeof schema.threads.$inferSelect, "source" | "repo" | "headRef" | "prNumber">,
  baseDir: string,
): SandboxSpec {
  if (thread.source === "github") {
    return {
      repoUrl: githubRepoUrl(thread.repo),
      ...(thread.prNumber != null && thread.headRef ? { ref: thread.headRef } : {}),
    };
  }
  return isUrl(thread.repo) ? { repoUrl: thread.repo } : { localPath: path.resolve(baseDir, thread.repo) };
}

export async function executeRun(deps: ExecuteRunDeps): Promise<ExecuteRunOutcome> {
  const { db } = deps;
  const cfg = loadConfig();

  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, deps.runId));
  if (!run) throw new Error(`run ${deps.runId} not found`);
  const [thread] = await db.select().from(schema.threads).where(eq(schema.threads.id, run.threadId));
  if (!thread) throw new Error(`run ${run.id}: thread ${run.threadId} not found`);

  // A dashboard cancel of a QUEUED run flips it before any worker touches it
  // (there is no watcher to notice a flag on a run that never started) — such
  // a run never executes.
  if (run.status === "cancelled") {
    return { runId: run.id, threadId: run.threadId, status: "cancelled", reason: "cancelled" };
  }

  const controller = new AbortController();
  activeControllers.set(run.id, controller);

  await db
    .update(schema.runs)
    .set({ status: "running", startedAt: new Date(), error: null })
    .where(eq(schema.runs.id, run.id));
  deps.notify?.(thread.id);

  // Cross-process cancel: poll the durable flag; any process can set it.
  const cancelWatch = setInterval(() => {
    void db
      .select({ requested: schema.runs.cancelRequestedAt })
      .from(schema.runs)
      .where(eq(schema.runs.id, run.id))
      .then(([row]) => {
        if (row?.requested) controller.abort();
      })
      .catch(() => undefined);
  }, deps.cancelWatchEveryMs ?? 2_000);
  cancelWatch.unref?.();

  // Traces: NDJSON file + trace_events rows, one sequence (step 8).
  const traceDir = path.join(process.env.INIT_CWD ?? process.cwd(), "traces");
  const jsonl = new JsonlTrace(path.join(traceDir, `${run.id}.jsonl`));
  const recorder = new TraceRecorder({ jsonl, db, runId: run.id });
  let sinkTail: Promise<void> = Promise.resolve();
  const sink = (e: AgentEvent) => {
    sinkTail = sinkTail
      .then(() => recorder.record(e))
      .then(() => {
        // Every recorded step nudges the dashboard watching this thread.
        deps.notify?.(thread.id);
      })
      .catch(() => undefined);
  };

  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const spec = sandboxSpecForThread(thread, baseDir);

  // Git credentials for the run (decision #42): the FRESH installation token
  // for this thread's repo — the sandbox layer installs it for clone + push.
  let gitToken: string | undefined;
  if (deps.githubApp && thread.installationId != null) {
    try {
      gitToken = await deps.githubApp.tokenFor(thread.installationId);
    } catch (err) {
      process.stdout.write(
        `[run ${run.id}] installation token mint failed: ${err instanceof Error ? err.message : String(err)} — continuing without credentials\n`,
      );
    }
  }
  const sandbox =
    deps.sandboxFactory?.(spec) ??
    createSandbox(
      spec,
      deps.local
        ? { local: true }
        : {
            heyo: {
              token: cfg.heyo.token ?? "",
              server: cfg.heyo.server,
              namespace: cfg.heyo.namespace,
              image: cfg.heyo.image,
              sizeClass: cfg.heyo.sizeClass,
              diskSizeGb: cfg.heyo.diskSizeGb,
              githubToken: gitToken,
            },
          },
    );
  const llm = deps.llm ?? createLLMClient(cfg.llm);

  /** The installation-scoped client for this thread (decisions #42/#43). */
  const githubClientForThread = async () => {
    if (!deps.githubApp || thread.installationId == null) return undefined;
    try {
      return await deps.githubApp.clientFor(thread.installationId);
    } catch (err) {
      process.stdout.write(
        `[run ${run.id}] github client failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return undefined;
    }
  };

  try {
    await ensureThreadState(db, thread.id, "running");
    await sandbox.start();

    const outcome = await withHeartbeat(
      db,
      run.id,
      () =>
        runAgent(
          { task: run.task ?? "(no task recorded)" },
          {
            llm,
            sandbox,
            agent: codingAgent,
            thread: { store: new PostgresThreadStore(db), id: thread.id },
            startPhase: deps.startPhase ?? run.startPhase ?? undefined,
            signal: controller.signal,
            onEvent: sink,
          },
        ),
      deps.heartbeatEveryMs,
    );
    await sinkTail;

    const status: ExecuteRunOutcome["status"] =
      outcome.reason === "finished" && outcome.ok
        ? "succeeded"
        : outcome.reason === "cancelled"
          ? "cancelled"
          : outcome.reason === "paused"
            ? "paused"
            : "failed";

    await db
      .update(schema.runs)
      .set({
        status,
        finishedAt: new Date(),
        phase: outcome.phase ?? null,
        disposition: outcome.disposition ?? null,
        steps: outcome.steps,
        tokensIn: outcome.usage.promptTokens,
        tokensOut: outcome.usage.completionTokens,
        usd: outcome.usage.costUsd !== undefined ? String(outcome.usage.costUsd) : "0",
        error: outcome.error ?? null,
      })
      .where(eq(schema.runs.id, run.id));

    if (outcome.checkpointRef) {
      await db
        .update(schema.threads)
        .set({ checkpointSha: outcome.checkpointRef, updatedAt: new Date() })
        .where(eq(schema.threads.id, thread.id));
    }

    // Standing watch intent: a "watch" conclusion is recorded for the
    // babysitter (step 13 reads it); any other declared conclusion supersedes it.
    if (outcome.disposition === "watch") {
      await db
        .update(schema.threads)
        .set({ watch: (outcome.watch ?? {}) as Record<string, unknown>, updatedAt: new Date() })
        .where(eq(schema.threads.id, thread.id));
    } else if (outcome.disposition !== undefined) {
      await db
        .update(schema.threads)
        .set({ watch: null, updatedAt: new Date() })
        .where(eq(schema.threads.id, thread.id));
    }

    // The last mile (steps 12–13): a succeeded GitHub run pushes its work.
    // First delivery opens the PR; follow-ups (PR already open) update the
    // branch in place. Delivery is best-effort for the run's status, but it
    // must happen BEFORE the sandbox dies — the work lives there.
    let delivered: { prNumber: number; prUrl: string } | null = null;
    if (status === "succeeded" && thread.source === "github") {
      const github = await githubClientForThread();
      if (github) {
        try {
          delivered = await deliverPullRequest({
            db,
            sandbox,
            github,
            thread,
            runId: run.id,
            publicUrl: cfg.server.publicUrl,
            summary: outcome.summary,
          });
          process.stdout.write(`[run ${run.id}] PR delivered: ${delivered?.prUrl ?? "(none)"}\n`);
        } catch (err) {
          const message = `pr delivery failed: ${err instanceof Error ? err.message : String(err)}`;
          process.stdout.write(`[run ${run.id}] ${message}\n`);
          await db.update(schema.runs).set({ error: message }).where(eq(schema.runs.id, run.id));
        }
      } else {
        process.stdout.write(`[run ${run.id}] GITHUB_TOKEN not set — PR delivery skipped\n`);
      }
    }

    // A blocked conclusion reaches the humans where the work lives: the
    // question is posted as a comment + a needs-input label (decision #40).
    if (outcome.disposition === "blocked" && thread.source === "github") {
      const github = await githubClientForThread();
      if (github) {
        const target = thread.prNumber ?? thread.issueNumber;
        try {
          const question = outcome.summary?.trim() || "I need a human decision to continue.";
          await github.commentOnIssue(thread.repo, target, `🤖 **Blocked — needs input**\n\n${question}`);
          await github.addLabels(thread.repo, target, ["agent:needs-input"]);
          process.stdout.write(`[run ${run.id}] blocked → commented on ${thread.repo}#${target}\n`);
        } catch (err) {
          process.stdout.write(
            `[run ${run.id}] blocked comment failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    }

    const finalState: ThreadState =
      status === "succeeded" ? (delivered || thread.prNumber ? "pr_open" : "queued") : "queued";
    await ensureThreadState(db, thread.id, finalState);

    // Dashboard debugging switch (17b): re-read right before destruction — a
    // flip made while the run was live still wins.
    const [fresh] = await db
      .select({ keep: schema.runs.keepSandbox })
      .from(schema.runs)
      .where(eq(schema.runs.id, run.id));
    if (fresh?.keep) {
      process.stdout.write(
        `[run ${run.id}] sandbox kept for debugging: ${sandbox.backend}/${sandbox.id}\n`,
      );
    } else {
      await sandbox.destroy();
    }
    deps.notify?.(thread.id);
    return {
      runId: run.id,
      threadId: thread.id,
      status,
      reason: outcome.reason,
      summary: outcome.summary,
      disposition: outcome.disposition,
      watch: outcome.watch,
      resumeAt: outcome.resumeAt,
      phase: outcome.phase,
    };
  } catch (err) {
    await sinkTail.catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.runs)
      .set({ status: "failed", finishedAt: new Date(), error: message })
      .where(eq(schema.runs.id, run.id));
    await ensureThreadState(db, thread.id, "queued").catch(() => undefined);
    await sandbox.destroy().catch(() => undefined);
    return { runId: run.id, threadId: thread.id, status: "failed", reason: "error" };
  } finally {
    clearInterval(cancelWatch);
    activeControllers.delete(run.id);
  }
}
