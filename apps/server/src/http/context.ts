/**
 * Shared plumbing for the HTTP edge.
 *
 * Routes get a context instead of reaching into `deps` directly: auth gating,
 * visibility rules, and row loaders live here once, so every route applies the
 * same ownership rule.
 */
import type { Context } from "hono";
import { schema, type Db } from "../db/index.js";
import type { User } from "../db/schema.js";
import type { Queues } from "../queue/index.js";
import type { UserFromRequest } from "./routes/auth.js";
import { findThread } from "../services/threads/queries.js";
import { findRun } from "../services/runs/queries.js";
import type { StreamHub } from "./stream.js";

export interface ApiDeps {
  db: Db;
  queues: Queues;
  getUser: UserFromRequest;
  /** Shared with the server app; defaults to a fresh hub (tests). */
  hub?: StreamHub;
  log?: (line: string) => void;
}

export interface ResolvedDeps extends ApiDeps {
  hub: StreamHub;
  log: (line: string) => void;
}

type RunRow = typeof schema.runs.$inferSelect;
type ThreadRow = typeof schema.threads.$inferSelect;

export const runSummary = (r: RunRow) => ({
  id: r.id,
  status: r.status,
  trigger: r.trigger,
  agent: r.agent,
  phase: r.phase,
  disposition: r.disposition,
  error: r.error,
  task: r.task,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
  createdAt: r.createdAt,
});

export const threadSummary = (t: ThreadRow) => ({
  id: t.id,
  title: t.title,
  repo: t.repo,
  issueNumber: t.issueNumber,
  state: t.state,
  source: t.source,
  prNumber: t.prNumber,
  prUrl: t.prUrl,
  headRef: t.headRef,
  baseRef: t.baseRef,
  phase: t.phase,
  summary: t.summary,
  turnsUsed: t.turnsUsed,
  budgetMaxTurns: t.budgetMaxTurns,
  usdSpent: t.usdSpent,
  budgetMaxUsd: t.budgetMaxUsd,
  checkpointSha: t.checkpointSha,
  watch: t.watch,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
});

export interface ApiContext {
  deps: ResolvedDeps;
  /** Auth gate — returns the user or a 401 Response. */
  requireUser(c: Context): Promise<User | Response>;
  ok(value: User | Response): value is User;
  threadVisibleTo(
    thread: Pick<ThreadRow, "userId" | "installationId">,
    userId: string,
  ): boolean;
  loadThread(threadId: string): Promise<ThreadRow | undefined>;
  loadRunForAction(runId: string, userId: string): Promise<RunRow | undefined>;
}

export function createApiContext(deps: ResolvedDeps): ApiContext {
  const threadVisibleTo = (
    thread: Pick<ThreadRow, "userId" | "installationId">,
    userId: string,
  ) => thread.userId === userId || (thread.installationId === null && thread.userId === null);

  const loadThread = (threadId: string) => findThread(deps.db, threadId);

  return {
    deps,
    requireUser: async (c) => {
      const user = await deps.getUser(c);
      return user ?? c.json({ error: "unauthorized" }, 401);
    },
    ok: (value): value is User => !(value instanceof Response),
    threadVisibleTo,
    loadThread,
    loadRunForAction: async (runId, userId) => {
      const run = await findRun(deps.db, runId);
      if (!run) return undefined;
      const thread = await loadThread(run.threadId);
      if (!thread || !threadVisibleTo(thread, userId)) return undefined;
      return run;
    },
  };
}
