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
import { createGitHubClient, type GitHubClient } from "../github/client.js";
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
  github?: GitHubClient;
}

export interface ExecuteRunOutcome {
  runId: string;
  threadId: string;
  status: "succeeded" | "failed" | "cancelled" | "paused";
  reason: string;
  summary?: string;
}

const isUrl = (repo: string) => /^(https?:\/\/|git@|ssh:\/\/)/.test(repo);

export async function executeRun(deps: ExecuteRunDeps): Promise<ExecuteRunOutcome> {
  const { db } = deps;
  const cfg = loadConfig();

  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, deps.runId));
  if (!run) throw new Error(`run ${deps.runId} not found`);
  const [thread] = await db.select().from(schema.threads).where(eq(schema.threads.id, run.threadId));
  if (!thread) throw new Error(`run ${run.id}: thread ${run.threadId} not found`);

  const controller = new AbortController();
  activeControllers.set(run.id, controller);

  await db
    .update(schema.runs)
    .set({ status: "running", startedAt: new Date(), error: null })
    .where(eq(schema.runs.id, run.id));

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
    sinkTail = sinkTail.then(() => recorder.record(e)).catch(() => undefined);
  };

  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const spec: SandboxSpec =
    thread.source === "github"
      ? { repoUrl: githubRepoUrl(thread.repo) }
      : isUrl(thread.repo)
        ? { repoUrl: thread.repo }
        : { localPath: path.resolve(baseDir, thread.repo) };
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
              githubToken: cfg.github.token,
            },
          },
    );
  const llm = deps.llm ?? createLLMClient(cfg.llm);

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

    // The last mile (step 12): a succeeded GitHub run becomes a PR. Delivery
    // is best-effort for the run's status, but it must happen BEFORE the
    // sandbox dies — the work lives there.
    let delivered: { prNumber: number; prUrl: string } | null = null;
    if (status === "succeeded" && !thread.prNumber && thread.source === "github") {
      const github =
        deps.github ?? (cfg.github.token ? createGitHubClient({ token: cfg.github.token }) : undefined);
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

    const finalState: ThreadState =
      status === "succeeded" ? (delivered || thread.prNumber ? "pr_open" : "queued") : "queued";
    await ensureThreadState(db, thread.id, finalState);

    await sandbox.destroy();
    return { runId: run.id, threadId: thread.id, status, reason: outcome.reason, summary: outcome.summary };
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
