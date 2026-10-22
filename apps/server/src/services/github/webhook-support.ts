/** Shared plumbing for the webhook handlers: lookups, delivery path, reply. */
import type { Db } from "../../db/index.js";
import type { StreamHub } from "../../http/stream.js";
import { and, desc, eq, inArray } from "drizzle-orm";
import { schema } from "../../db/index.js";
import { appendEvent, consumeEvents } from "../threads/inbox.js";
import { renderGithubTask } from "./render.js";
import { canTransition, isTerminal } from "../threads/state.js";
import { wakeThread } from "../threads/wake.js";
import { requestCancel } from "../runs/lease.js";

/** The subset of server dependencies the webhook door needs. */
export interface WebhookDeps {
  db: Db;
  queues: import("../../queue/index.js").Queues;
  webhookSecret: string;
  botLogin?: string;
  skipSignatureVerification?: boolean;
  hub?: StreamHub;
  log?: (line: string) => void;
}

export interface WebhookResult {
  status: number;
  body: unknown;
}

type ThreadRow = typeof schema.threads.$inferSelect;

export const reply = (body: unknown, status = 200): WebhookResult => ({ status, body });

export async function findThreadByPr(
  deps: WebhookDeps,
  repo: string,
  prNumber: number,
): Promise<ThreadRow | undefined> {
  const [thread] = await deps.db
    .select()
    .from(schema.threads)
    .where(
      and(eq(schema.threads.repo, repo), eq(schema.threads.prNumber, prNumber)),
    );
  return thread;
}

export async function findThreadByHeadRef(
  deps: WebhookDeps,
  repo: string,
  headRef: string,
): Promise<ThreadRow | undefined> {
  const [thread] = await deps.db
    .select()
    .from(schema.threads)
    .where(
      and(eq(schema.threads.repo, repo), eq(schema.threads.headRef, headRef)),
    );
  return thread;
}

export async function findThreadByIssue(
  deps: WebhookDeps,
  repo: string,
  issueNumber: number,
): Promise<ThreadRow | undefined> {
  const [thread] = await deps.db
    .select()
    .from(schema.threads)
    .where(
      and(
        eq(schema.threads.repo, repo),
        eq(schema.threads.issueNumber, issueNumber),
      ),
    );
  return thread;
}

export async function activeRun(deps: WebhookDeps, threadId: string) {
  const [run] = await deps.db
    .select({ id: schema.runs.id, status: schema.runs.status })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.threadId, threadId),
        inArray(schema.runs.status, ["queued", "running"]),
      ),
    )
    .orderBy(desc(schema.runs.createdAt))
    .limit(1);
  return run;
}

// --- the shared delivery path (queue vs interject) ---------------------------

interface TurnSpec {
  deliveryId: string;
  kind: string;
  payload: Record<string, unknown>;
  trigger: string;
  /** Human-authored → cancel the busy run (decision #28). */
  cancelActive: boolean;
}

export async function deliverTurn(
  deps: WebhookDeps,
  thread: ThreadRow,
  spec: TurnSpec,
  log: (line: string) => void,
): Promise<{ runId: string | null }> {
  const evt = await appendEvent(deps.db, {
    threadId: thread.id,
    deliveryId: spec.deliveryId,
    kind: spec.kind,
    payload: spec.payload,
  });

  if (spec.cancelActive) {
    const active = await activeRun(deps, thread.id);
    if (active) {
      await requestCancel(deps.db, active.id);
      log(`webhook: interject — cancel requested on run ${active.id}`);
    }
  }

  const run = await wakeThread(deps, thread.id, {
    trigger: spec.trigger,
    task: renderGithubTask(spec.kind, spec.payload),
  });
  if (run) await consumeEvents(deps.db, [evt.id]); // this wake IS the turn
  deps.hub?.notify(thread.id);
  return { runId: run?.id ?? null };
}

export function ignored(reason: string): WebhookResult {
  return reply({ ignored: true, reason }, 202);
}
