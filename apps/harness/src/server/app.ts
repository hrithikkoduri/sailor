/**
 * The webhook door — GitHub events in, threads and turns out.
 *
 * Order of defenses, on purpose:
 *   1. HMAC-verify the RAW body (nothing is parsed before this check)
 *   2. delivery-GUID ledger — GitHub delivers at-least-once; the ledger makes
 *      retries exactly-once
 *   3. handler routing (step 13 complete): issues:labeled opens threads;
 *      check_run/status → queue (machine, decision #28); reviews and human
 *      comments → interject (cancel the busy run; the feedback becomes the
 *      next turn); our own pushes → queue + acknowledge; pull_request closed
 *      → terminal thread state.
 *
 * The server only writes Postgres + the queue — the worker executes runs.
 */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { and, desc, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import type { Queues } from "../queue/index.js";
import { verifyWebhookSignature } from "../github/signature.js";
import { AGENT_FIX_LABEL, classifyGithubEvent } from "../github/triage.js";
import { headRefFor } from "../github/repo.js";
import { renderGithubTask } from "../github/render.js";
import type { GitHubAppService } from "../github/app.js";
import { repoEnabled, upsertInstallation } from "../github/installations.js";
import { appendEvent, consumeEvents } from "../threads/inbox.js";
import { canTransition, isTerminal } from "../threads/state.js";
import { wakeThread } from "../threads/wake.js";
import { requestCancel } from "../runs/lease.js";
import { createAuthRoutes, type AuthConfig, type UserFromRequest } from "../auth/routes.js";
import { createOnboardingRoutes } from "../auth/onboarding.js";
import { sessionUser, SESSION_COOKIE } from "../auth/session.js";
import { ensureDevUser } from "../auth/users.js";

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
  /** GitHub App service (decisions #42/#44) — onboarding + repo sync. */
  githubApp?: GitHubAppService;
  /** Sessions + dev affordances (decision #41). */
  authConfig?: AuthConfig;
  /** Dashboard base URL — browser-facing redirects land here. */
  publicUrl?: string;
  /** The App's user-OAuth credentials (Sign in with GitHub). */
  oauth?: { slug?: string; clientId?: string; clientSecret?: string; fetchFn?: typeof fetch };
}

type ThreadRow = typeof schema.threads.$inferSelect;

interface Sender {
  login?: string;
  type?: string;
}

interface LabeledEvent {
  action?: string;
  label?: { name?: string };
  issue?: { number?: number; title?: string; body?: string | null; html_url?: string };
  repository?: { full_name?: string; default_branch?: string };
  sender?: Sender;
  installation?: { id?: number };
}

interface CheckRunEvent {
  action?: string;
  check_run?: {
    name?: string;
    conclusion?: string | null;
    html_url?: string;
    head_sha?: string;
    check_suite?: { head_branch?: string };
    pull_requests?: Array<{ number?: number }>;
  };
  repository?: { full_name?: string };
  sender?: Sender;
}

interface StatusEvent {
  state?: string;
  context?: string;
  target_url?: string;
  commit?: { sha?: string };
  branches?: Array<{ name?: string }>;
  repository?: { full_name?: string };
  sender?: Sender;
}

interface ReviewEvent {
  action?: string;
  review?: { state?: string; body?: string | null; html_url?: string; user?: Sender };
  comment?: { body?: string | null; html_url?: string; user?: Sender; path?: string };
  pull_request?: { number?: number };
  repository?: { full_name?: string };
  sender?: Sender;
}

interface IssueCommentEvent {
  action?: string;
  comment?: { body?: string | null; html_url?: string; user?: Sender };
  issue?: { number?: number; pull_request?: { url?: string } };
  repository?: { full_name?: string };
  sender?: Sender;
}

interface PushEvent {
  ref?: string;
  after?: string;
  deleted?: boolean;
  commits?: unknown[];
  repository?: { full_name?: string };
  sender?: Sender;
}

interface PullRequestEvent {
  action?: string;
  pull_request?: {
    number?: number;
    merged?: boolean;
    html_url?: string;
    head?: { ref?: string };
  };
  repository?: { full_name?: string };
  sender?: Sender;
}

/** The instruction a labeled issue turns into. */
export function renderIssueTask(issue: { number?: number; title?: string; body?: string | null; html_url?: string }): string {
  const parts = [`Fix GitHub issue #${issue.number}: ${issue.title ?? "(untitled)"}`];
  if (issue.html_url) parts.push(`\n${issue.html_url}`);
  const body = issue.body?.trim();
  if (body) parts.push(`\n${body.slice(0, 4000)}`);
  return parts.join("\n");
}

export function createServerApp(deps: ServerDeps): Hono {
  const app = new Hono();
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const authConfig: AuthConfig = deps.authConfig ?? { sessionTtlDays: 30, secureCookies: false, devBypass: false };
  const publicUrl = deps.publicUrl ?? "http://localhost:5173";

  // The session resolver: cookie → session → user (or the dev-bypass user).
  const getUser: UserFromRequest = async (c) => {
    const user = await sessionUser(deps.db, getCookie(c, SESSION_COOKIE));
    if (user) return user;
    if (authConfig.devBypass) return ensureDevUser(deps.db);
    return undefined;
  };

  app.route("/", createAuthRoutes({ db: deps.db, config: authConfig, publicUrl, getUser, oauth: deps.oauth, log }));
  app.route("/", createOnboardingRoutes({ db: deps.db, githubApp: deps.githubApp, publicUrl, getUser, log }));

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

    // --- installation lifecycle: manages the gate itself ---------------------
    if (eventName === "installation" || eventName === "installation_repositories") {
      return handleInstallationEvent(deps, eventName, payload, log);
    }

    // --- THE REPO GATE (decision #44) ----------------------------------------
    // Only repos selected during onboarding may trigger agent runs. Everything
    // else is recorded in the delivery ledger and ignored — cheap by design.
    const installationId = (payload as { installation?: { id?: number } }).installation?.id;
    const repoFullName = (payload as { repository?: { full_name?: string } }).repository?.full_name;
    if (typeof installationId !== "number" || !repoFullName) {
      log(`webhook: ${eventName} without installation/repository — ignored (App-only mode)`);
      return c.json({ ignored: true, reason: "missing installation" }, 202);
    }
    if (!(await repoEnabled(deps.db, installationId, repoFullName))) {
      log(`webhook: ${eventName} for ${repoFullName} — repo not enabled in onboarding, ignored`);
      return c.json({ ignored: true, reason: "repo not enabled" }, 202);
    }

    // --- the door (step 12): labeled agent:fix → thread → run --------------
    if (eventName === "issues" && (payload as LabeledEvent).action === "labeled") {
      const event = payload as LabeledEvent;
      if (event.label?.name === AGENT_FIX_LABEL) {
        return handleIssueLabeled(deps, event, deliveryId, log);
      }
    }

    // --- step 13: the PR lifecycle ------------------------------------------
    if (eventName === "check_run") return handleCheckRun(deps, payload as CheckRunEvent, deliveryId, log);
    if (eventName === "status") return handleStatus(deps, payload as StatusEvent, deliveryId, log);
    if (eventName === "pull_request_review" || eventName === "pull_request_review_comment")
      return handleReview(deps, eventName, payload as ReviewEvent, deliveryId, log);
    if (eventName === "issue_comment") return handleComment(deps, payload as IssueCommentEvent, deliveryId, log);
    if (eventName === "push") return handlePush(deps, payload as PushEvent, deliveryId, log);
    if (eventName === "pull_request") return handlePullRequest(deps, payload as PullRequestEvent, deliveryId, log);

    // Everything else: recorded + triaged (decision #28), no handler yet.
    const decision = classifyGithubEvent(eventName, payload, { botLogin: deps.botLogin });
    log(`webhook: ${eventName} → ${decision.action} (${decision.reason}) — no handler`);
    return c.json({ ignored: true, triage: decision }, 202);
  });

  return app;
}

// --- thread lookup helpers ---------------------------------------------------

async function findThreadByPr(deps: ServerDeps, repo: string, prNumber: number): Promise<ThreadRow | undefined> {
  const [thread] = await deps.db
    .select()
    .from(schema.threads)
    .where(and(eq(schema.threads.repo, repo), eq(schema.threads.prNumber, prNumber)));
  return thread;
}

async function findThreadByHeadRef(deps: ServerDeps, repo: string, headRef: string): Promise<ThreadRow | undefined> {
  const [thread] = await deps.db
    .select()
    .from(schema.threads)
    .where(and(eq(schema.threads.repo, repo), eq(schema.threads.headRef, headRef)));
  return thread;
}

async function findThreadByIssue(deps: ServerDeps, repo: string, issueNumber: number): Promise<ThreadRow | undefined> {
  const [thread] = await deps.db
    .select()
    .from(schema.threads)
    .where(and(eq(schema.threads.repo, repo), eq(schema.threads.issueNumber, issueNumber)));
  return thread;
}

async function activeRun(deps: ServerDeps, threadId: string) {
  const [run] = await deps.db
    .select({ id: schema.runs.id, status: schema.runs.status })
    .from(schema.runs)
    .where(and(eq(schema.runs.threadId, threadId), inArray(schema.runs.status, ["queued", "running"])))
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

async function deliverTurn(
  deps: ServerDeps,
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
  return { runId: run?.id ?? null };
}

function ignored(reason: string): Response {
  return Response.json({ ignored: true, reason }, { status: 202 });
}

// --- step 13 handlers ---------------------------------------------------------

const FAILING_CONCLUSIONS = ["failure", "timed_out", "cancelled", "action_required", "startup_failure"];

async function handleCheckRun(
  deps: ServerDeps,
  event: CheckRunEvent,
  deliveryId: string,
  log: (line: string) => void,
): Promise<Response> {
  if (event.action !== "completed") return ignored(`action ${event.action ?? "?"}`);
  const conclusion = event.check_run?.conclusion;
  if (!conclusion || !FAILING_CONCLUSIONS.includes(conclusion)) return ignored(`conclusion ${conclusion ?? "none"}`);

  const repo = event.repository?.full_name;
  if (!repo) return Response.json({ error: "missing repository.full_name" }, { status: 400 });
  const prNumber = event.check_run?.pull_requests?.[0]?.number;
  const headRef = event.check_run?.check_suite?.head_branch;
  const thread = prNumber
    ? await findThreadByPr(deps, repo, prNumber)
    : headRef
      ? await findThreadByHeadRef(deps, repo, headRef)
      : undefined;
  if (!thread) return ignored("no thread for this check");
  if (isTerminal(thread.state)) return ignored(`thread is ${thread.state}`);

  const payload = {
    checks: [event.check_run?.name ?? "check"],
    url: event.check_run?.html_url,
    sha: event.check_run?.head_sha,
  };
  const { runId } = await deliverTurn(
    deps,
    thread,
    { deliveryId, kind: "check_run", payload, trigger: "babysit_ci", cancelActive: false },
    log,
  );
  log(`webhook: check_run ${conclusion} → thread ${thread.id} ${runId ? `→ run ${runId}` : "→ parked"}`);
  return Response.json({ threadId: thread.id, runId }, { status: 202 });
}

async function handleStatus(
  deps: ServerDeps,
  event: StatusEvent,
  deliveryId: string,
  log: (line: string) => void,
): Promise<Response> {
  if (event.state !== "failure" && event.state !== "error") return ignored(`state ${event.state ?? "?"}`);
  const repo = event.repository?.full_name;
  const headRef = event.branches?.[0]?.name;
  if (!repo || !headRef) return ignored("no branch on this status");
  const thread = await findThreadByHeadRef(deps, repo, headRef);
  if (!thread) return ignored("no thread for this status");
  if (isTerminal(thread.state)) return ignored(`thread is ${thread.state}`);

  const payload = { checks: [event.context ?? "status"], url: event.target_url, sha: event.commit?.sha };
  const { runId } = await deliverTurn(
    deps,
    thread,
    { deliveryId, kind: "status", payload, trigger: "babysit_ci", cancelActive: false },
    log,
  );
  log(`webhook: status ${event.state} → thread ${thread.id} ${runId ? `→ run ${runId}` : "→ parked"}`);
  return Response.json({ threadId: thread.id, runId }, { status: 202 });
}

async function handleReview(
  deps: ServerDeps,
  eventName: string,
  event: ReviewEvent,
  deliveryId: string,
  log: (line: string) => void,
): Promise<Response> {
  if (eventName === "pull_request_review" && event.action !== "submitted") return ignored(`action ${event.action ?? "?"}`);
  if (eventName === "pull_request_review_comment" && event.action !== "created") return ignored(`action ${event.action ?? "?"}`);

  const repo = event.repository?.full_name;
  const prNumber = event.pull_request?.number;
  if (!repo || typeof prNumber !== "number") return Response.json({ error: "missing repository or pull_request.number" }, { status: 400 });
  const thread = await findThreadByPr(deps, repo, prNumber);
  if (!thread) return ignored("no thread for this PR");
  if (isTerminal(thread.state)) return ignored(`thread is ${thread.state}`);

  const author = event.review?.user?.login ?? event.comment?.user?.login;
  const self = deps.botLogin !== undefined && author === deps.botLogin;
  const payload = {
    state: event.review?.state,
    body: event.review?.body ?? event.comment?.body ?? "",
    author,
    url: event.review?.html_url ?? event.comment?.html_url,
    path: event.comment?.path,
    prNumber,
  };
  const { runId } = await deliverTurn(
    deps,
    thread,
    {
      deliveryId,
      kind: eventName === "pull_request_review" ? "pull_request_review" : "pull_request_review_comment",
      payload,
      trigger: "review",
      cancelActive: !self, // reviews interject — ANY author (decision #28)
    },
    log,
  );
  log(`webhook: ${eventName} by ${author ?? "?"} → thread ${thread.id} ${runId ? `→ run ${runId}` : "→ parked (interject)"}`);
  return Response.json({ threadId: thread.id, runId }, { status: 202 });
}

async function handleComment(
  deps: ServerDeps,
  event: IssueCommentEvent,
  deliveryId: string,
  log: (line: string) => void,
): Promise<Response> {
  if (event.action !== "created") return ignored(`action ${event.action ?? "?"}`);
  const repo = event.repository?.full_name;
  const issueNumber = event.issue?.number;
  if (!repo || typeof issueNumber !== "number") return Response.json({ error: "missing repository or issue.number" }, { status: 400 });

  const isPr = event.issue?.pull_request !== undefined;
  const thread = isPr ? await findThreadByPr(deps, repo, issueNumber) : await findThreadByIssue(deps, repo, issueNumber);
  if (!thread) return ignored("no thread for this comment");
  if (isTerminal(thread.state)) return ignored(`thread is ${thread.state}`);

  const author = event.comment?.user?.login;
  const self = deps.botLogin !== undefined && author === deps.botLogin;
  const human = event.comment?.user?.type === "User";
  const payload = { body: event.comment?.body ?? "", author, url: event.comment?.html_url, prNumber: issueNumber };
  const { runId } = await deliverTurn(
    deps,
    thread,
    { deliveryId, kind: "issue_comment", payload, trigger: "babysit_comment", cancelActive: !self && human },
    log,
  );
  log(`webhook: issue_comment by ${author ?? "?"} (${human ? "human" : "bot"}) → thread ${thread.id} ${runId ? `→ run ${runId}` : "→ parked"}`);
  return Response.json({ threadId: thread.id, runId }, { status: 202 });
}

async function handlePush(
  deps: ServerDeps,
  event: PushEvent,
  deliveryId: string,
  log: (line: string) => void,
): Promise<Response> {
  const repo = event.repository?.full_name;
  if (!repo || !event.ref?.startsWith("refs/heads/") || event.deleted === true) return ignored("not a branch push");
  if (deps.botLogin === undefined || event.sender?.login !== deps.botLogin) {
    return ignored("not our push");
  }
  const headRef = event.ref.slice("refs/heads/".length);
  const thread = await findThreadByHeadRef(deps, repo, headRef);
  if (!thread) return ignored("no thread for this branch");
  if (isTerminal(thread.state)) return ignored(`thread is ${thread.state}`);

  const payload = { ref: headRef, commits: Array.isArray(event.commits) ? event.commits.length : 0, headSha: event.after };
  const { runId } = await deliverTurn(
    deps,
    thread,
    { deliveryId, kind: "push", payload, trigger: "inbox", cancelActive: false },
    log,
  );
  log(`webhook: our push (${payload.commits} commit(s)) on ${headRef} → thread ${thread.id} ${runId ? `→ run ${runId}` : "→ parked"}`);
  return Response.json({ threadId: thread.id, runId }, { status: 202 });
}

async function handlePullRequest(
  deps: ServerDeps,
  event: PullRequestEvent,
  _deliveryId: string,
  log: (line: string) => void,
): Promise<Response> {
  const repo = event.repository?.full_name;
  const pr = event.pull_request;
  if (!repo || typeof pr?.number !== "number") return Response.json({ error: "missing repository or pull_request.number" }, { status: 400 });
  if (event.action !== "closed") return ignored(`action ${event.action ?? "?"}`);

  const thread = await findThreadByPr(deps, repo, pr.number);
  if (!thread) return ignored("no thread for this PR");
  if (isTerminal(thread.state)) return ignored(`thread is ${thread.state}`);

  const to = pr.merged ? "merged" : "closed";
  const target = canTransition(thread.state, to) ? to : canTransition(thread.state, "closed") ? "closed" : undefined;
  if (!target) return ignored(`no ${to} transition from ${thread.state}`);

  const active = await activeRun(deps, thread.id);
  if (active) await requestCancel(deps.db, active.id); // the work is moot now
  await deps.db
    .update(schema.threads)
    .set({ state: target, updatedAt: new Date() })
    .where(eq(schema.threads.id, thread.id));
  log(`webhook: PR #${pr.number} ${target} → thread ${thread.id}`);
  return Response.json({ threadId: thread.id, state: target }, { status: 200 });
}

// --- step 12 handler (kept as-is) ---------------------------------------------

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

  // The credential + ownership context (decision #42/#41): the installation
  // the issue came through, and the user it was linked to (when known).
  const installationId = event.installation?.id;
  const installation =
    typeof installationId === "number"
      ? (
          await deps.db
            .select()
            .from(schema.installations)
            .where(eq(schema.installations.installationId, installationId))
        )[0]
      : undefined;

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
        installationId: installationId ?? null,
        userId: installation?.userId ?? null,
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
      number: issue.number,
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

// --- installation lifecycle (the gate's own plumbing) -------------------------

interface InstallationEvent {
  action?: string;
  installation?: { id?: number; account?: { login?: string; type?: string } };
  repositories?: Array<{ full_name?: string; default_branch?: string }>;
  repositories_removed?: Array<{ full_name?: string }>;
  sender?: Sender;
}

async function handleInstallationEvent(
  deps: ServerDeps,
  eventName: string,
  payload: Record<string, unknown>,
  log: (line: string) => void,
): Promise<Response> {
  const event = payload as InstallationEvent;
  const id = event.installation?.id;
  if (typeof id !== "number") return ignored("no installation id");

  if (eventName === "installation_repositories") {
    const [row] = await deps.db
      .select()
      .from(schema.installations)
      .where(eq(schema.installations.installationId, id));
    if (!row) return ignored("unknown installation");
    for (const repo of event.repositories ?? []) {
      if (!repo.full_name) continue;
      await deps.db
        .insert(schema.repositories)
        .values({ installationRef: row.id, fullName: repo.full_name, defaultBranch: repo.default_branch ?? null })
        .onConflictDoNothing();
    }
    for (const repo of event.repositories_removed ?? []) {
      if (!repo.full_name) continue;
      await deps.db
        .delete(schema.repositories)
        .where(
          and(
            eq(schema.repositories.installationRef, row.id),
            eq(schema.repositories.fullName, repo.full_name),
          ),
        );
    }
    log(
      `webhook: installation_repositories for ${id} (+${event.repositories?.length ?? 0} / -${event.repositories_removed?.length ?? 0})`,
    );
    return Response.json({ ok: true }, { status: 200 });
  }

  switch (event.action) {
    case "created": {
      // Fallback binder (decision #43): the sender is the installer — link the
      // installation when we already know that user (the state param is primary).
      const senderLogin = event.sender?.login;
      let userId: string | undefined;
      if (senderLogin) {
        const [user] = await deps.db.select().from(schema.users).where(eq(schema.users.login, senderLogin));
        userId = user?.id;
      }
      await upsertInstallation(deps.db, {
        installationId: id,
        accountLogin: event.installation?.account?.login ?? "unknown",
        accountType: event.installation?.account?.type ?? "User",
        ...(userId !== undefined ? { userId } : {}),
      });
      log(
        `webhook: installation ${id} created (${event.installation?.account?.login ?? "?"})${userId ? " — linked by sender" : ""}`,
      );
      return Response.json({ ok: true }, { status: 200 });
    }
    case "deleted": {
      await deps.db.delete(schema.installations).where(eq(schema.installations.installationId, id));
      log(`webhook: installation ${id} deleted`);
      return Response.json({ ok: true }, { status: 200 });
    }
    case "suspend":
    case "unsuspend": {
      await deps.db
        .update(schema.installations)
        .set({ suspended: event.action === "suspend", updatedAt: new Date() })
        .where(eq(schema.installations.installationId, id));
      log(`webhook: installation ${id} ${event.action}`);
      return Response.json({ ok: true }, { status: 200 });
    }
    default:
      return ignored(`installation action ${event.action ?? "?"}`);
  }
}
