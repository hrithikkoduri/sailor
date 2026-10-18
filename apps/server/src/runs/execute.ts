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
import { eq, sql } from "drizzle-orm";
import {
  JsonlTrace,
  compactionForContextWindow,
  createLLMClient,
  createSandbox,
  fetchModelCatalog,
  openSandbox,
  releaseSandbox,
  runAgent,
  upsertHeyoSecret,
  type AgentEvent,
  type BudgetLimits,
  type CompactionConfig,
  type CreateSandboxOptions,
  type HeyoSandboxConfig,
  type LLMClient,
  type ModelCatalogEntry,
  type RevivalRequest,
  type Sandbox,
  type SandboxHandle,
  type SandboxSpec,
} from "@anchor/core";
import { loadConfig } from "../config.js";
import { schema, type Db } from "../db/index.js";
import { PostgresThreadStore } from "../threads/thread-store.js";
import {
  ensureThreadState,
  isTerminal,
  type ThreadState,
} from "../threads/state.js";
import { TraceRecorder } from "../trace/store.js";
import type { GitHubAppService } from "../github/app.js";
import type { DeliveredPullRequest } from "../github/pr.js";
import {
  assertSafeCheckpointRef,
  checkpointRefFor,
  githubRepoUrl,
  headRefFor,
} from "../github/repo.js";
import { withHeartbeat } from "./lease.js";
import { createLiveProjector } from "./live-projector.js";
import { createSailorAgent } from "../agents/sailor.js";
import { githubTools, type PublicationPolicy } from "../agents/github-tools.js";

/** Live AbortControllers, keyed by run id — the cancel button's registry. */
const activeControllers = new Map<string, AbortController>();

/**
 * Provider-catalog lookups, cached per endpoint+model for the process
 * lifetime — one fetch, not one per run. Failures cache as null: fallback
 * values apply and we don't hammer a dead endpoint.
 */
const catalogCache = new Map<string, Promise<ModelCatalogEntry | null>>();
function catalogFor(cfg: {
  baseUrl: string;
  apiKey?: string;
  model?: string;
}): Promise<ModelCatalogEntry | null> {
  const key = `${cfg.baseUrl}|${cfg.model ?? ""}`;
  let hit = catalogCache.get(key);
  if (!hit) {
    hit = fetchModelCatalog({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey ?? "",
      model: cfg.model ?? "",
    });
    catalogCache.set(key, hit);
  }
  return hit;
}

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
  /** Optional descriptive starting phase, not a workflow instruction. */
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
  /**
   * Live projections for the chat stream (step 18): assistant text deltas
   * (cumulative, ~10/s), phase/tool activity, run finish. Fire-and-forget —
   * the persisted trace remains the source of truth; this is the live view.
   */
  live?: (threadId: string, payload: Record<string, unknown>) => void;
  publicationPolicy?: PublicationPolicy;
  /** Test seam: override the engine budget for this run. */
  budgets?: Partial<BudgetLimits>;
  /** Test seam: pin the engine compaction budgets (default: model-window derived). */
  compaction?: CompactionConfig;
  /** Test seam: budget revival on/off (default: config, SAILOR_BUDGET_REVIVAL). */
  revival?: boolean;
}

export interface ExecuteRunOutcome {
  runId: string;
  threadId: string;
  status: "succeeded" | "failed" | "cancelled" | "paused" | "budget_exhausted";
  reason: string;
  summary?: string;
  /** Set when the agent declared one via finish(): done | watch | blocked. */
  disposition?: "done" | "watch" | "blocked";
  /** Product-defined watch spec (e.g. { checks: true, comments: true }). */
  watch?: Record<string, unknown>;
  resumeAt?: string;
  /** The phase the run ended in — the drain uses it to resume cancelled work. */
  phase?: string;
  /** The agent's handoff when the budget won — evidence for revival. */
  revival?: RevivalRequest;
  /** The run's checkpoint commit, when changed work was snapshotted. */
  checkpointRef?: string;
}

const isUrl = (repo: string) => /^(https?:\/\/|git@|ssh:\/\/)/.test(repo);

/**
 * Where a thread's work happens. GitHub threads clone the repo — and once a PR
 * exists, its HEAD BRANCH: the pushed branch is the handoff point across runs
 * (babysitting continues on it; first runs start from the default branch and
 * push a new one at delivery).
 */
export function sandboxSpecForThread(
  thread: Pick<
    typeof schema.threads.$inferSelect,
    "source" | "repo" | "headRef" | "prNumber" | "checkpointRef"
  >,
  baseDir: string,
): SandboxSpec {
  if (thread.source === "github") {
    // Clone precedence: the off-machine checkpoint branch carries the LATEST
    // workspace (it is force-pushed every turn), then the PR branch, then the
    // default branch.
    const ref =
      thread.checkpointRef ??
      (thread.prNumber != null && thread.headRef ? thread.headRef : undefined);
    return {
      repoUrl: githubRepoUrl(thread.repo),
      ...(ref ? { ref } : {}),
    };
  }
  return isUrl(thread.repo)
    ? { repoUrl: thread.repo }
    : { localPath: path.resolve(baseDir, thread.repo) };
}

/** The heyo connection config for this product's sandboxes — credentials live
 * here and only here; the package owns what to do with them. */
function heyoSandboxConfig(
  cfg: ReturnType<typeof loadConfig>,
  gitToken?: string,
): HeyoSandboxConfig {
  return {
    token: cfg.heyo.token ?? "",
    server: cfg.heyo.server,
    namespace: cfg.heyo.namespace,
    image: cfg.heyo.image,
    imageKind: cfg.heyo.imageKind,
    ...(cfg.heyo.imageRepo ? { imageRepo: cfg.heyo.imageRepo } : {}),
    ...(cfg.heyo.imageRef ? { imageRef: cfg.heyo.imageRef } : {}),
    ...(cfg.heyo.imageDockerfile
      ? { imageDockerfile: cfg.heyo.imageDockerfile }
      : {}),
    ...(cfg.heyo.imageAuth ? { imageAuth: cfg.heyo.imageAuth } : {}),
    sizeClass: cfg.heyo.sizeClass,
    diskSizeGb: cfg.heyo.diskSizeGb,
    githubToken: gitToken,
  };
}

export async function executeRun(
  deps: ExecuteRunDeps,
): Promise<ExecuteRunOutcome> {
  const { db } = deps;
  const cfg = loadConfig();

  const [run] = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, deps.runId));
  if (!run) throw new Error(`run ${deps.runId} not found`);
  const [thread] = await db
    .select()
    .from(schema.threads)
    .where(eq(schema.threads.id, run.threadId));
  if (!thread)
    throw new Error(`run ${run.id}: thread ${run.threadId} not found`);

  // A dashboard cancel of a QUEUED run flips it before any worker touches it
  // (there is no watcher to notice a flag on a run that never started) — such
  // a run never executes.
  if (run.status === "cancelled") {
    return {
      runId: run.id,
      threadId: run.threadId,
      status: "cancelled",
      reason: "cancelled",
    };
  }

  const controller = new AbortController();
  activeControllers.set(run.id, controller);

  await db
    .update(schema.runs)
    .set({ status: "running", startedAt: new Date(), error: null })
    .where(eq(schema.runs.id, run.id));
  await db
    .update(schema.threads)
    .set({
      turnsUsed: sql`${schema.threads.turnsUsed} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(schema.threads.id, thread.id));
  deps.notify?.(thread.id);

  // Chat and machine turns now share one identity and completion contract.
  // Legacy phase positions are not instructions for the new agent runtime.

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

  // Live projections for the chat stream (step 18): cumulative assistant text
  // at ~10/s + activity markers. Fire-and-forget; the trace is the truth.
  const live = (payload: Record<string, unknown>) =>
    deps.live?.(thread.id, { runId: run.id, ...payload });
  const projectLive = createLiveProjector(live);
  const events: AgentEvent[] = [];

  const sink = (e: AgentEvent) => {
    if (e.type !== "llm_text_delta" && e.type !== "llm_reasoning_delta")
      events.push(e);
    projectLive(e);
    sinkTail = sinkTail
      .then(() => recorder.record(e))
      .then(() => {
        // Every recorded step nudges the dashboard watching this thread.
        if (e.type !== "llm_text_delta" && e.type !== "llm_reasoning_delta")
          deps.notify?.(thread.id);
      })
      .catch(() => undefined);
  };

  const baseDir = process.env.INIT_CWD ?? process.cwd();
  // Retain the sandbox while the thread is alive: the next run (interjection,
  // sweep resume, follow-up) adopts it and finds the workspace — branch,
  // edits, and all — exactly as left. Terminal threads are torn down instead.
  const retain = thread.source === "github" && !isTerminal(thread.state);
  const spec: SandboxSpec = {
    ...sandboxSpecForThread(thread, baseDir),
    retain,
  };

  // Off-machine checkpoints (B): the side branch the push webhook ignores. It
  // is recorded only after a push actually succeeded, so a fresh clone never
  // chases a branch that does not exist.
  let checkpointPushRef: string | undefined;
  if (thread.source === "github") {
    checkpointPushRef =
      thread.checkpointRef ??
      checkpointRefFor(thread.headRef ?? headRefFor(thread.issueNumber));
    assertSafeCheckpointRef(checkpointPushRef);
  }

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
  // Git-kind image builds run on Heyo's host and read their credential from
  // the namespace secret store; installation tokens live an hour, so refresh
  // the stored value on the way in (the same fresh token also clones the
  // workspace). The upsert mechanic lives in @anchor/core; when/whether is
  // Sailor policy. Best-effort — an older secret beats a failed run.
  if (
    !deps.local &&
    cfg.heyo.imageKind === "git" &&
    cfg.heyo.buildSecretRefresh &&
    cfg.heyo.imageAuth?.secret &&
    cfg.heyo.imageAuth.key &&
    gitToken &&
    cfg.heyo.token
  ) {
    try {
      await upsertHeyoSecret({
        server: cfg.heyo.server,
        token: cfg.heyo.token,
        namespace: cfg.heyo.namespace,
        secret: cfg.heyo.imageAuth.secret,
        key: cfg.heyo.imageAuth.key,
        value: gitToken,
      });
    } catch (err) {
      process.stdout.write(
        `[run ${run.id}] build-secret refresh failed: ${err instanceof Error ? err.message : String(err)} — continuing with the stored value\n`,
      );
    }
  }
  const sandboxOptions: CreateSandboxOptions = deps.local
    ? { local: true }
    : { heyo: heyoSandboxConfig(cfg, gitToken) };
  const make = (s: SandboxSpec): Sandbox =>
    deps.sandboxFactory?.(s) ?? createSandbox(s, sandboxOptions);
  // Provider catalog (cached): the real context window and prices. Real runs
  // only — injected LLMs (tests) stay offline and keep the static fallbacks.
  const catalog =
    !deps.llm && cfg.llm.apiKey && cfg.llm.model
      ? await catalogFor(cfg.llm)
      : null;
  const llm =
    deps.llm ??
    createLLMClient({
      ...cfg.llm,
      priceInPerMTok: cfg.llm.priceInPerMTok ?? catalog?.priceInPerMTok,
      priceOutPerMTok: cfg.llm.priceOutPerMTok ?? catalog?.priceOutPerMTok,
      priceCacheReadPerMTok:
        cfg.llm.priceCacheReadPerMTok ?? catalog?.priceCacheReadPerMTok,
    });
  // Big context, big memory: fold only when the conversation truly grows past
  // the model's working window (derived from the catalog, clamped to the
  // 200–300k product range), so long investigations keep their accumulated
  // findings instead of re-deriving them. Unknown window → the static values.
  const compaction =
    deps.compaction ??
    (catalog?.contextLength
      ? compactionForContextWindow(catalog.contextLength)
      : { maxEstimatedTokens: 256_000, keepRecentTokens: 64_000 });

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

  let delivered: DeliveredPullRequest | null = null;
  let opened: Sandbox | undefined;
  try {
    await ensureThreadState(db, thread.id, "running");
    const sandbox = await openSandbox({
      ...sandboxOptions,
      create: make,
      spec,
      ...(thread.sandboxId
        ? {
            adopt: {
              id: thread.sandboxId,
              backend: thread.sandboxBackend === "local" ? "local" : "heyo",
            } satisfies SandboxHandle,
          }
        : {}),
      ...(thread.checkpointRef
        ? {
            fallbackSpec: {
              ...sandboxSpecForThread(
                { ...thread, checkpointRef: null },
                baseDir,
              ),
              retain,
            },
          }
        : {}),
      onRetainedGone: async (handle) => {
        process.stdout.write(
          `[run ${run.id}] retained sandbox ${handle.id} unavailable — re-cloning\n`,
        );
        await db
          .update(schema.threads)
          .set({ sandboxId: null, sandboxBackend: null, updatedAt: new Date() })
          .where(eq(schema.threads.id, thread.id));
      },
      onRefUnusable: async (ref) => {
        process.stdout.write(
          `[run ${run.id}] checkpoint branch ${ref} unusable — cloning the base branch\n`,
        );
        await db
          .update(schema.threads)
          .set({ checkpointRef: null, updatedAt: new Date() })
          .where(eq(schema.threads.id, thread.id));
      },
    });
    opened = sandbox;
    // Record which sandbox this thread now owns — the next run adopts it.
    await db
      .update(schema.threads)
      .set({
        sandboxId: sandbox.id,
        sandboxBackend: sandbox.backend,
        updatedAt: new Date(),
      })
      .where(eq(schema.threads.id, thread.id));
    const initial =
      thread.source === "github"
        ? await sandbox.exec("git rev-parse --verify HEAD", { timeoutSecs: 60 })
        : undefined;
    const startRef =
      initial?.exitCode === 0 && /^[a-f0-9]{40}$/.test(initial.stdout.trim())
        ? initial.stdout.trim()
        : undefined;
    const agent = createSailorAgent(
      JSON.stringify(
        {
          repository: thread.repo,
          source: thread.source,
          workspace: sandbox.workspace,
          issue: thread.issueNumber,
          pullRequest: thread.prNumber,
          headBranch: thread.headRef,
          baseBranch: thread.baseRef,
          availablePublication: thread.source === "github" && !!deps.githubApp,
        },
        null,
        2,
      ),
      thread.source === "github" && deps.githubApp
        ? githubTools({
            db,
            thread,
            runId: run.id,
            sandbox,
            publicUrl: cfg.server.publicUrl,
            github: githubClientForThread,
            events,
            startRef,
            policy: deps.publicationPolicy ?? cfg.publication,
            onPublished: (result) => {
              delivered = result;
            },
          })
        : [],
    );
    const requestedPhase = deps.startPhase ?? run.startPhase;
    const startPhase = agent.strategy.phases.some(
      (item) => item.id === requestedPhase,
    )
      ? (requestedPhase ?? undefined)
      : undefined;

    const engineBudgets: Partial<BudgetLimits> = {
      maxSteps: cfg.budget.maxSteps,
      maxTokens: cfg.budget.maxTokens,
      maxUsd: cfg.budget.maxUsd,
      ...deps.budgets,
    };
    const revivalOn = deps.revival ?? cfg.budget.revival;

    const outcome = await withHeartbeat(
      db,
      run.id,
      () =>
        runAgent(
          { task: run.task ?? "(no task recorded)" },
          {
            llm,
            sandbox,
            agent,
            startPhase,
            thread: { store: new PostgresThreadStore(db), id: thread.id },
            compaction,
            // Product budget dials (SAILOR_MAX_STEPS / TOKENS / USD). The
            // package defaults (40 steps, 1.5M tokens) stop long-horizon work
            // around the 20th call — cumulative tokens grow with every call,
            // and compaction only bounds the per-call context. Steps and
            // dollars are the real runaway backstops.
            budgets: engineBudgets,
            // Revival (SAILOR_BUDGET_REVIVAL): warn at 85%, offer the
            // request_revival handoff; the aftermath is this product's call.
            ...(revivalOn ? { revival: {} } : {}),
            checkpointPushRef,
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
            : outcome.reason === "budget_exceeded" ||
                outcome.reason === "max_steps"
              ? "budget_exhausted"
              : "failed";

    // The evidence a revival would run on: the agent's handoff and/or a
    // checkpoint of in-flight work. No evidence → no revival.
    const revivalEvidence =
      status === "budget_exhausted"
        ? outcome.revival || outcome.checkpointRef
          ? {
              ...(outcome.revival ? { request: outcome.revival } : {}),
              ...(outcome.checkpointRef
                ? { checkpointRef: outcome.checkpointRef }
                : {}),
            }
          : null
        : null;

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
        usd:
          outcome.usage.costUsd !== undefined
            ? String(outcome.usage.costUsd)
            : "0",
        error: outcome.error ?? null,
        revival: revivalEvidence,
      })
      .where(eq(schema.runs.id, run.id));

    if (outcome.checkpointRef) {
      await db
        .update(schema.threads)
        .set({ checkpointSha: outcome.checkpointRef, updatedAt: new Date() })
        .where(eq(schema.threads.id, thread.id));
    }

    // B: the first successful checkpoint push makes the side branch the
    // thread's resume source for any future fresh clone.
    if (
      checkpointPushRef &&
      events.some((event) => event.type === "checkpoint" && event.pushedTo)
    ) {
      await db
        .update(schema.threads)
        .set({ checkpointRef: checkpointPushRef, updatedAt: new Date() })
        .where(eq(schema.threads.id, thread.id));
    }

    // Honest accounting: the run's cost accrues to the thread (the budget cap
    // and the dashboard read these).
    if (outcome.usage.costUsd !== undefined) {
      await db
        .update(schema.threads)
        .set({
          usdSpent: sql`${schema.threads.usdSpent} + ${outcome.usage.costUsd}`,
          updatedAt: new Date(),
        })
        .where(eq(schema.threads.id, thread.id));
    }

    // Standing watch intent: a "watch" conclusion is recorded for the
    // babysitter (step 13 reads it); any other declared conclusion supersedes it.
    if (outcome.disposition === "watch") {
      await db
        .update(schema.threads)
        .set({
          watch: (outcome.watch ?? {}) as Record<string, unknown>,
          updatedAt: new Date(),
        })
        .where(eq(schema.threads.id, thread.id));
    } else if (outcome.disposition !== undefined) {
      await db
        .update(schema.threads)
        .set({ watch: null, updatedAt: new Date() })
        .where(eq(schema.threads.id, thread.id));
    }

    // Publication is an explicit tool result, never inferred from turn success.

    // GitHub comments likewise require reply_on_github; a blocked response is
    // not permission to post or label an issue behind the user's back.

    const finalState: ThreadState =
      status === "succeeded"
        ? delivered || thread.prNumber
          ? "pr_open"
          : "queued"
        : "queued";
    await ensureThreadState(db, thread.id, finalState);

    // Dashboard debugging switch (17b): re-read right before destruction — a
    // flip made while the run was live still wins.
    const [fresh] = await db
      .select({ keep: schema.runs.keepSandbox })
      .from(schema.runs)
      .where(eq(schema.runs.id, run.id));
    if (opened) {
      if (fresh?.keep) {
        process.stdout.write(
          `[run ${run.id}] sandbox kept for debugging: ${opened.backend}/${opened.id}\n`,
        );
      } else {
        // destroy() retains when the spec says so — the thread continues.
        await opened.destroy();
      }
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
      ...(outcome.revival ? { revival: outcome.revival } : {}),
      ...(outcome.checkpointRef
        ? { checkpointRef: outcome.checkpointRef }
        : {}),
    };
  } catch (err) {
    await sinkTail.catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.runs)
      .set({ status: "failed", finishedAt: new Date(), error: message })
      .where(eq(schema.runs.id, run.id));
    await ensureThreadState(db, thread.id, "queued").catch(() => undefined);
    await opened?.destroy().catch(() => undefined);
    return {
      runId: run.id,
      threadId: thread.id,
      status: "failed",
      reason: "error",
    };
  } finally {
    clearInterval(cancelWatch);
    activeControllers.delete(run.id);
  }
}

/**
 * Tear down a thread's retained sandbox (A) — terminal threads release their
 * VM so nothing keeps paying for a finished issue. Best-effort: the thread
 * row's sandbox pointers are cleared regardless.
 */
export async function releaseThreadSandbox(
  db: Db,
  thread: Pick<
    typeof schema.threads.$inferSelect,
    "id" | "sandboxId" | "sandboxBackend"
  >,
): Promise<void> {
  if (!thread.sandboxId) return;
  const cfg = loadConfig();
  await releaseSandbox(
    {
      id: thread.sandboxId,
      backend: thread.sandboxBackend === "local" ? "local" : "heyo",
    },
    { heyo: heyoSandboxConfig(cfg) },
  );
  await db
    .update(schema.threads)
    .set({ sandboxId: null, sandboxBackend: null, updatedAt: new Date() })
    .where(eq(schema.threads.id, thread.id));
}
