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
import { and, eq, sql } from "drizzle-orm";
import {
  JsonlTrace,
  createLiveProjector,
  gitSnapshot,
  llmFromCatalog,
  openSandboxSession,
  releaseSandbox,
  runAgent,
  type AgentEvent,
  type BudgetLimits,
  type CompactionConfig,
  type HeyoSandboxConfig,
  type LLMClient,
  type RevivalRequest,
  type Sandbox,
  type SandboxProvider,
  type SandboxSpec,
} from "anchor-ai-sdk";
import { local } from "anchor-ai-sdk/sandbox/local";
import { redactEvent } from "anchor-ai-sdk";
import { attachRepository, questionTools } from "../agents/tools/questions.js";
import { secretTools } from "../agents/tools/secret.js";
import { SecretRedactor } from "../secrets/redactor.js";
import { secretCatalog, secretValues } from "../secrets/store.js";
import { enabledRepositories } from "../threads/repositories.js";
import { repoEnabled } from "../github/installations.js";
import {
  providerForBackend,
  sandboxProvider,
} from "../../sandbox/index.js";
import { loadConfig } from "../../config.js";
import { schema, type Db } from "../../db/index.js";
import { PostgresThreadStore } from "../threads/thread-store.js";
import { postgresSandboxStore } from "../threads/sandbox-store.js";
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
import { heartbeatRun } from "./lease.js";
import { createSailorAgent } from "../agents/sailor.js";
import { githubTools, type PublicationPolicy } from "../agents/tools/github.js";
import { readSailorHandoff, SAILOR_HANDOFF } from "../agents/sailor-handoff.js";
import { recordBackgroundJob } from "./background.js";

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
  /** Commit attribution inside the sandbox — the App's bot identity. */
  gitIdentity?: { name: string; email: string };
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
 * Git credentials are scoped to THIS thread's repository (plus repositories it
 * explicitly attached) — never to the installation's whole enabled set.
 *
 * Enabling a repository in Settings makes it *selectable*; it does not grant
 * every thread write access to it. Cross-repository work must be an explicit,
 * recorded action on the thread (attach / change), so 1000 threads never mean
 * 1000 holders of a global write grant.
 */
const repoName = (fullName: string) => fullName.split("/")[1] ?? fullName;

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
  if (thread.source === "workspace") return {};
  if (thread.source === "github" || thread.source === "manual") {
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

/**
 * Repositories the agent checked out BESIDE the thread's workspace.
 *
 * A `git clone` into a sibling directory is invisible to Sailor: no
 * attach_repository call, no authorization check. We cannot prevent a clone of
 * public code, but the thread must not pretend the work happened in its own
 * repository — so the run records what it finds, and the composer shows it.
 */
export async function findAdHocCheckouts(
  sandbox: Sandbox,
  workspace: string,
): Promise<Array<{ repository: string; path: string }>> {
  const found = await sandbox.exec(
    "for root in /home /workspace /root /tmp; do " +
      "[ -d \"$root\" ] && find \"$root\" -maxdepth 4 -type d -name .git -prune 2>/dev/null; done | head -20",
    { cwd: "/", timeoutSecs: 60 },
  );
  if (found.exitCode !== 0) return [];
  const repos = new Map<string, string>();
  for (const dotGit of found.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const dir = dotGit.replace(/\/\.git$/, "");
    if (!dir || dir === workspace.replace(/\/+$/, "")) continue;
    const remote = await sandbox.exec("git config --get remote.origin.url", {
      cwd: dir,
      timeoutSecs: 30,
    });
    const match = /github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
      remote.stdout.trim(),
    );
    if (remote.exitCode === 0 && match) repos.set(match[1]!, dir);
  }
  return [...repos].map(([repository, path]) => ({ repository, path }));
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

  // A token carries the permissions it was minted with, so the repository
  // toggles a user changed since the last run only take effect on a fresh
  // mint — invalidate at run start, then re-check access for THIS thread.
  if (deps.githubApp && thread.installationId != null)
    deps.githubApp.invalidateTokens(thread.installationId);
  const repoAccess =
    thread.installationId == null
      ? true
      : await repoEnabled(db, thread.installationId, thread.repo);
  const gitScopes = [repoName(thread.repo)];

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

  // Secrets are known values, not patterns: load them once so every tool
  // result and trace event is scrubbed, including a later read of a file a
  // secret was accidentally written to. Best-effort: a missing key must not
  // break non-secret runs, but a secret run will fail at its own boundary.
  const redactor = new SecretRedactor();
  if (thread.userId) {
    try {
      for (const value of await secretValues(db, thread.userId)) redactor.add(value);
    } catch (err) {
      process.stdout.write(
        `[run ${run.id}] secret preload failed: ${err instanceof Error ? err.message : String(err)} — continuing without value redaction\n`,
      );
    }
  }

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

  // Traces: NDJSON file + trace_events rows + the live stream — the sinks are
  // handed to the engine, whose fanout owns the sequence number and redaction
  // and flushes them before the run resolves.
  const jsonl = new JsonlTrace(path.join(cfg.paths.traceDir, `${run.id}.jsonl`));
  const jsonlSink = redactor.wrapSink(jsonl);

  // Live projections for the chat stream (step 18): cumulative assistant text
  // at ~10/s + activity markers. Fire-and-forget; the trace is the truth.
  const live = (payload: Record<string, unknown>) =>
    deps.live?.(thread.id, { runId: run.id, ...payload });
  // Anchor batches live text at a 100ms clock tick. On a token stream that
  // arrives in bursts, that can look like paragraph-sized updates. A 2x clock
  // halves the batch to ~50ms without forking the package; the UI still
  // receives cumulative text, so no frame is lost.
  const projectLive = createLiveProjector(live, () => Date.now() * 2);
  let liveSequence = 0;
  const events: AgentEvent[] = [];
  // Live usage: the runs row feeds the trace header, the thread rail and any
  // other reader, so accrue tokens/dollars as calls finish — the run-end
  // write stays authoritative and overwrites this.
  const liveUsage = {
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    steps: 0,
  };

  const recorder = new TraceRecorder({
    db,
    runId: run.id,
    // Product bookkeeping rides the recorder's chain, after the row is in:
    // a dashboard nudge can never race the row a refresh would read.
    afterRecord: async (entry) => {
      const e = entry.event;
      if (e.type === "llm_call_finished") {
        liveUsage.promptTokens += e.usage.promptTokens;
        liveUsage.completionTokens += e.usage.completionTokens;
        liveUsage.costUsd += e.usage.costUsd ?? 0;
        liveUsage.steps = Math.max(liveUsage.steps, e.step);
        await db
          .update(schema.runs)
          .set({
            steps: liveUsage.steps,
            tokensIn: liveUsage.promptTokens,
            tokensOut: liveUsage.completionTokens,
            usd: liveUsage.costUsd.toFixed(4),
          })
          .where(eq(schema.runs.id, run.id));
      }
      // A detached command's handle is durable state, not trace trivia: the
      // worker sweep needs it after this run (and this process) is gone.
      if (e.type === "background_started") {
        await recordBackgroundJob(db, {
          runId: run.id,
          threadId: thread.id,
          jobId: e.jobId,
          command: e.command,
          sandboxId: opened?.id,
          // The bash tool's hard lifetime; 3600 is the tool's cap.
          timeoutSecs: e.timeoutSecs ?? 3600,
        });
      }
      if (e.type === "background_completed") {
        // Anchor 0.1.7 already delivered this result in-run. The fallback
        // sweep must not enqueue the same completion as another user turn.
        await db.update(schema.backgroundJobs).set({ status: "done", exitCode: e.exitCode, finishedAt: new Date() })
          .where(and(eq(schema.backgroundJobs.runId, run.id), eq(schema.backgroundJobs.jobId, e.jobId)));
      }
      // Every recorded step nudges the dashboard watching this thread.
      if (e.type !== "llm_text_delta" && e.type !== "llm_reasoning_delta")
        deps.notify?.(thread.id);
    },
  });
  const sink = (e: AgentEvent) => {
    // Live frames must not wait behind async journal sinks. Keep the same
    // event order and redaction, but publish synchronously at receipt.
    const event = redactor.redactDeep(redactEvent(e));
    projectLive.record({ seq: liveSequence++, ts: new Date().toISOString(), event });
    if (e.type !== "llm_text_delta" && e.type !== "llm_reasoning_delta")
      events.push(event);
  };

  const baseDir = cfg.paths.baseDir;
  // Retain the sandbox while the thread is alive: the next run (interjection,
  // sweep resume, follow-up) adopts it and finds the workspace — branch,
  // edits, and all — exactly as left. Terminal threads are torn down instead.
  const retain = ["github", "manual", "workspace"].includes(thread.source) && !isTerminal(thread.state);
  /** A clone candidate: the same run fields, for one ref (null = base). */
  const specWith = (checkpointRef: string | null): SandboxSpec => ({
    ...sandboxSpecForThread({ ...thread, checkpointRef }, baseDir),
    retain,
    ...(deps.gitIdentity ? { gitIdentity: deps.gitIdentity } : {}),
    ...(deps.githubApp && thread.installationId != null && repoAccess
      ? {
          git: {
            token: () => deps.githubApp!.tokenFor(thread.installationId!, gitScopes),
          },
        }
      : {}),
  });

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

  // The provider for this run, named and explicit: the retained handle's
  // backend is passed verbatim, so a future provider can never be
  // misclassified as heyo (the old `backend === "local" ? … : "heyo"` trap).
  const provider: SandboxProvider = deps.local
    ? local()
    : sandboxProvider(cfg);
  const make = (s: SandboxSpec): Sandbox =>
    deps.sandboxFactory?.(s) ?? provider.create(s);
  // Provider-side preparation (e.g. the git-kind build-secret refresh): the
  // provider owns its own policy now; best-effort — an older secret beats a
  // failed run.
  try {
    await provider.prepare?.({
      ...(deps.githubApp && thread.installationId != null
        ? { gitToken: () => deps.githubApp!.tokenFor(thread.installationId!, gitScopes) }
        : {}),
    });
  } catch (err) {
    process.stdout.write(
      `[run ${run.id}] provider prepare failed: ${err instanceof Error ? err.message : String(err)} — continuing\n`,
    );
  }

  // Provider catalog → live prices → compaction derived from the model's real
  // window: one call in anchor-ai-sdk, shared with the eval so the precedence
  // rules cannot drift apart (2026-10-18: hand-rolled catalog→prices wiring
  // mispriced a whole eval round). Explicit cfg prices win when set — operator
  // intent — and injected LLMs (tests) stay offline with the static fallbacks.
  const built = deps.llm
    ? null
    : await llmFromCatalog({
        baseUrl: cfg.llm.baseUrl,
        apiKey: cfg.llm.apiKey,
        model: cfg.llm.model ?? "",
        priceInPerMTok: cfg.llm.priceInPerMTok,
        priceOutPerMTok: cfg.llm.priceOutPerMTok,
        priceCacheReadPerMTok: cfg.llm.priceCacheReadPerMTok,
        // Big context, big memory: fold only when the conversation truly
        // grows past the model's working window (clamped to the 200–300k
        // product range). Unknown window → these static values.
        fallbackCompaction: {
          maxEstimatedTokens: 256_000,
          keepRecentTokens: 64_000,
        },
      });
  const llm = deps.llm ?? built!.llm;
  const compaction = deps.compaction ??
    built?.compaction ?? {
      maxEstimatedTokens: 256_000,
      keepRecentTokens: 64_000,
    };

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
  let questionRequestId: string | undefined;
  let opened: Sandbox | undefined;
  try {
    await ensureThreadState(db, thread.id, "running");
    if (run.repoAttachment) {
      const repo = (await enabledRepositories(db, thread.userId)).find((r) => r.fullName === run.repoAttachment);
      if (!repo) throw new Error("The selected repository is no longer enabled for this account.");
      if (thread.source !== "workspace" && thread.repo !== repo.fullName)
        throw new Error("A different repository is already attached. Start a new thread instead of overwriting work.");
      if (thread.source === "workspace") {
        const update = { source: "manual", repo: repo.fullName, installationId: repo.installationId, baseRef: repo.defaultBranch ?? "main" };
        Object.assign(thread, update);
      }
    }
    // The store keeps continuity (the thread row's sandbox columns); the
    // package runs the session: adopt the retained handle, clear the stale
    // pointer when it is gone, then try the checkpoint branch, then the base.
    const sandbox = await openSandboxSession({
      provider,
      create: make,
      store: postgresSandboxStore(db, provider.name),
      key: thread.id,
      sources: [
        ...(thread.checkpointRef
          ? [{ spec: specWith(thread.checkpointRef) }]
          : []),
        { spec: specWith(null) },
      ],
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
    // A repository answer may attach a repo to a retained, initially empty
    // sandbox. Fresh sandboxes already cloned it via sandboxSpecForThread.
    if (thread.source === "manual") {
      await attachRepository({ sandbox, repo: thread.repo, branch: thread.baseRef,
        ...(deps.githubApp && thread.installationId != null && repoAccess
          ? { token: await deps.githubApp.tokenFor(thread.installationId, gitScopes) } : {}) });
      // Only label the thread attached after checkout succeeds. A refused
      // attachment (existing work, revoked access) leaves its workspace intact.
      if (run.repoAttachment) await db.update(schema.threads).set({
        source: "manual", repo: thread.repo, installationId: thread.installationId,
        baseRef: thread.baseRef, updatedAt: new Date(),
      }).where(eq(schema.threads.id, thread.id));
    }
    const availableRepos = thread.source === "workspace"
      ? await enabledRepositories(db, thread.userId) : [];
    // Names and env vars only — never values. This lets the agent use an
    // existing secret under the right name instead of asking the user to
    // create a duplicate.
    const availableSecrets = thread.userId
      ? await secretCatalog(db, thread.userId) : [];
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
          availablePublication: ["github", "manual"].includes(thread.source) && !!deps.githubApp,
          publicationAfterRepositoryAttachment: thread.source === "workspace" && !!deps.githubApp,
          availableRepositories: availableRepos.map((r) => ({ repository: r.fullName, defaultBranch: r.defaultBranch })),
          availableSecrets,
        },
        null,
        2,
      ),
      [...secretTools({
        db,
        threadId: thread.id,
        userId: thread.userId,
        sandbox,
        redactor,
        onQuestions: (id) => { questionRequestId = id; controller.abort("waiting_for_answers"); },
        notify: () => deps.notify?.(thread.id),
      }),
       ...questionTools({ db, threadId: thread.id, userId: thread.userId, sandbox,
        hasRepository: thread.source !== "workspace",
        ...(deps.githubApp
          ? {
              tokenFor: (id: number, repository: string) => {
                // The attached repository is enabled (checked before the call);
                // the token is minted for exactly that repository.
                return deps.githubApp!.tokenFor(id, [repository.split("/")[1] ?? repository]);
              },
            }
          : {}),
        onQuestions: (id) => { questionRequestId = id; controller.abort("waiting_for_answers"); },
        notify: () => deps.notify?.(thread.id),
      }), ...(["github", "manual", "workspace"].includes(thread.source) && deps.githubApp
        ? githubTools({
            db,
            thread,
            runId: run.id,
            sandbox,
            publicUrl: cfg.server.publicUrl,
            github: githubClientForThread,
            gitToken: () => deps.githubApp!.tokenFor(thread.installationId!, gitScopes),
            events,
            startRef,
            policy: deps.publicationPolicy ?? cfg.publication,
            onPublished: (result) => {
              delivered = result;
            },
          })
        : [])],
    );
    // Every tool result passes through the redactor before it becomes a model
    // observation or a trace event. This covers built-in bash/read_file as
    // well as Sailor's product tools; `secrets use_secret` additionally registers
    // the value as soon as it is read.
    const redactedAgent = { ...agent, tools: agent.tools.map((tool) => redactor.wrap(tool)) };
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

    const outcome = await runAgent(
      { task: run.task ?? "(no task recorded)" },
      {
        llm,
        sandbox,
        agent: redactedAgent,
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
        // Off-machine durability via the package's git snapshot: commit the
        // turn boundary and force-push the side branch (reported, not fatal).
        ...(checkpointPushRef
          ? { snapshot: gitSnapshot({ push: checkpointPushRef }) }
          : {}),
        // The worker is presumed dead when heartbeats go stale (lease.ts).
        heartbeat: {
          everyMs: deps.heartbeatEveryMs,
          beat: () => heartbeatRun(db, run.id),
        },
        // Durable cross-process cancel: any process can stamp the flag.
        cancel: {
          everyMs: deps.cancelWatchEveryMs,
          isCancelled: async () => {
            const [row] = await db
              .select({ requested: schema.runs.cancelRequestedAt })
              .from(schema.runs)
              .where(eq(schema.runs.id, run.id));
            return Boolean(row?.requested);
          },
        },
        signal: controller.signal,
        // The engine's fanout owns sequencing + redaction and flushes these
        // before the run resolves; the product's sink stays live-only.
        traceSinks: [jsonlSink, redactor.wrapSink(recorder)],
        // Sailor's finish() vocabulary — a consumer schema now, not the engine's.
        handoff: SAILOR_HANDOFF,
        // Long commands detach instead of timing out the turn (decision #70).
        ...(cfg.exec.backgroundAfterSecs > 0
          ? { backgroundAfterSecs: cfg.exec.backgroundAfterSecs }
          : {}),
        onEvent: sink,
      },
    );
    // An explicit finish supersedes an old watch even when it omitted the
    // optional handoff. Plain prose still leaves product intent unset.
    const sailor = readSailorHandoff(
      outcome.handoff ?? (outcome.completion === "declared" ? {} : undefined), outcome.ok,
    );

    const status: ExecuteRunOutcome["status"] =
      questionRequestId ? "paused" : outcome.reason === "finished" && outcome.ok
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
        disposition: questionRequestId ? "blocked" : sailor.disposition ?? null,
        steps: outcome.steps,
        tokensIn: outcome.usage.promptTokens,
        tokensOut: outcome.usage.completionTokens,
        usd:
          outcome.usage.costUsd !== undefined
            ? String(outcome.usage.costUsd)
            : "0",
        error: questionRequestId ? null : outcome.error ?? null,
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
    if (sailor.disposition === "watch") {
      await db
        .update(schema.threads)
        .set({
          watch: (sailor.watch ?? {}) as Record<string, unknown>,
          updatedAt: new Date(),
        })
        .where(eq(schema.threads.id, thread.id));
    } else if (sailor.disposition !== undefined) {
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

    // Sibling clones are real work Sailor did not authorize or record. Persist
    // them as an event so the composer shows where the agent actually went.
    if (opened) {
      const checkouts = await findAdHocCheckouts(opened, opened.workspace).catch(
        () => [],
      );
      const extra = checkouts.filter((c) => c.repository !== thread.repo);
      if (extra.length)
        await db.insert(schema.events).values({
          threadId: thread.id,
          kind: "repository_checkout",
          payload: { repositories: extra, runId: run.id },
          status: "consumed",
          consumedAt: new Date(),
        });
    }

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
      disposition: sailor.disposition,
      watch: sailor.watch,
      resumeAt: sailor.resumeAt,
      phase: outcome.phase,
      ...(outcome.revival ? { revival: outcome.revival } : {}),
      ...(outcome.checkpointRef
        ? { checkpointRef: outcome.checkpointRef }
        : {}),
    };
  } catch (err) {
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
  const provider =
    providerForBackend(thread.sandboxBackend, cfg);
  await releaseSandbox(
    { id: thread.sandboxId, backend: thread.sandboxBackend ?? provider.name },
    provider,
  );
  await db
    .update(schema.threads)
    .set({ sandboxId: null, sandboxBackend: null, updatedAt: new Date() })
    .where(eq(schema.threads.id, thread.id));
}
