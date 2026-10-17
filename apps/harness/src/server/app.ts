/**
 * The webhook door — GitHub events in, threads and turns out.
 *
 * Order of defenses, on purpose:
 *   1. HMAC-verify the RAW body (nothing is parsed before this check)
 *   2. delivery-GUID ledger — GitHub delivers at-least-once; the ledger makes
 *      retries exactly-once
 *   3. handler routing; anything else is recorded and triaged (decision #28)
 *      but gets its handler in step 13
 *
 * The server only writes Postgres + the queue — the worker executes runs.
 */
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import type { Queues } from "../queue/index.js";
import { verifyWebhookSignature } from "../github/signature.js";
import { AGENT_FIX_LABEL, classifyGithubEvent } from "../github/triage.js";
import { headRefFor } from "../github/repo.js";
import { appendEvent, consumeEvents } from "../threads/inbox.js";
import { isTerminal } from "../threads/state.js";
import { wakeThread } from "../threads/wake.js";

export interface ServerDeps {
  db: Db;
  queues: Queues;
  /** Required unless skipSignatureVerification (dev only). */
  webhookSecret: string;
  /** The bot's login — lets triage tag self-authored events. */
  botLogin?: string;
  /** Test/dev only (`harness serve --no-verify`): accept unsigned bodies. */
  skipSignatureVerification?: boolean;
  log?: (line: string) => void;
}

interface IssueFields {
  number?: number;
  title?: string;
  body?: string | null;
  html_url?: string;
}

interface LabeledEvent {
  action?: string;
  label?: { name?: string };
  issue?: IssueFields;
  repository?: { full_name?: string; default_branch?: string };
  sender?: { login?: string; type?: string };
}

/** The instruction a labeled issue turns into. */
export function renderIssueTask(issue: IssueFields): string {
  const parts = [`Fix GitHub issue #${issue.number}: ${issue.title ?? "(untitled)"}`];
  if (issue.html_url) parts.push(`\n${issue.html_url}`);
  const body = issue.body?.trim();
  if (body) parts.push(`\n${body.slice(0, 4000)}`);
  return parts.join("\n");
}

export function createServerApp(deps: ServerDeps): Hono {
  const app = new Hono();
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));

  app.get("/healthz", (c) => c.json({ ok: true, service: "harness" }));

  app.post("/webhooks/github", async (c) => {
    const rawBody = await c.req.text();
    const eventName = c.req.header("x-github-event") ?? "";
    const deliveryId = c.req.header("x-github-delivery") ?? "";

    if (
      !deps.skipSignatureVerification &&
      !verifyWebhookSignature(deps.webhookSecret, rawBody, c.req.header("x-hub-signature-256"))
    ) {
      log(`webhook: REJECTED bad signature (event=${eventName || "?"})`);
      return c.json({ error: "invalid signature" }, 401);
    }
    if (!deliveryId) return c.json({ error: "missing X-GitHub-Delivery header" }, 400);

    const inserted = await deps.db
      .insert(schema.webhookDeliveries)
      .values({ deliveryId, eventKind: eventName })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) {
      log(`webhook: duplicate delivery ${deliveryId} (${eventName}) — acknowledged`);
      return c.json({ duplicate: true }, 200);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return c.json({ error: "body is not JSON" }, 400);
    }

    if (eventName === "ping") {
      log(`webhook: ping ok (${deliveryId})`);
      return c.json({ pong: true }, 200);
    }

    // --- the door (step 12): labeled agent:fix → thread → run --------------
    if (eventName === "issues" && (payload as LabeledEvent).action === "labeled") {
      const event = payload as LabeledEvent;
      if (event.label?.name === AGENT_FIX_LABEL) {
        return handleIssueLabeled(deps, event, deliveryId, log);
      }
    }

    // Everything else: recorded + triaged (decision #28); handlers land in 13.
    const decision = classifyGithubEvent(eventName, payload, { botLogin: deps.botLogin });
    log(`webhook: ${eventName} → ${decision.action} (${decision.reason}) — handler lands in step 13`);
    return c.json({ ignored: true, triage: decision }, 202);
  });

  return app;
}

async function handleIssueLabeled(
  deps: ServerDeps,
  event: LabeledEvent,
  deliveryId: string,
  log: (line: string) => void,
): Promise<Response> {
  const repo = event.repository?.full_name;
  const issue = event.issue;
  if (!repo || typeof issue?.number !== "number") {
    return Response.json({ error: "payload missing repository.full_name or issue.number" }, { status: 400 });
  }
  const defaultBranch = event.repository?.default_branch ?? "main";

  // Find-or-create. The (repo, issue_number) unique index makes this
  // race-safe: two simultaneous labels → both insert, one wins, both select.
  const find = () =>
    deps.db
      .select()
      .from(schema.threads)
      .where(and(eq(schema.threads.repo, repo), eq(schema.threads.issueNumber, issue.number!)));
  let thread = (await find())[0];
  if (!thread) {
    await deps.db
      .insert(schema.threads)
      .values({
        repo,
        issueNumber: issue.number,
        source: "github",
        baseRef: defaultBranch,
        headRef: headRefFor(issue.number),
      })
      .onConflictDoNothing();
    thread = (await find())[0];
  }
  if (!thread) throw new Error(`thread for ${repo}#${issue.number} vanished mid-insert`);

  if (isTerminal(thread.state)) {
    log(`webhook: ${repo}#${issue.number} labeled but thread is ${thread.state} — ignored`);
    return Response.json({ ignored: true, reason: `thread is ${thread.state}` }, { status: 200 });
  }

  const evt = await appendEvent(deps.db, {
    threadId: thread.id,
    deliveryId,
    kind: "issue_labeled",
    payload: {
      title: issue.title,
      body: issue.body?.slice(0, 4000) ?? null,
      url: issue.html_url,
      label: AGENT_FIX_LABEL,
      sender: event.sender,
    },
  });

  const run = await wakeThread(deps, thread.id, { trigger: "label", task: renderIssueTask(issue) });
  if (run) await consumeEvents(deps.db, [evt.id]); // this wake IS the turn that handles the event

  log(
    `webhook: ${repo}#${issue.number} labeled ${AGENT_FIX_LABEL} → thread ${thread.id} ${
      run ? `→ run ${run.id} queued` : "→ queued behind the active run"
    }`,
  );
  return Response.json({ threadId: thread.id, runId: run?.id ?? null }, { status: 202 });
}
