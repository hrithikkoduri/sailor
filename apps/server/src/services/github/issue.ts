/** A labeled issue opens a thread and queues the first turn. */
import { and, eq } from "drizzle-orm";
import { headRefFor } from "./repo.js";
import { AGENT_FIX_LABEL } from "./triage.js";
import { consumeEvents } from "../threads/inbox.js";
import { isTerminal } from "../threads/state.js";
import { schema } from "../../db/index.js";
import { appendEvent } from "../threads/inbox.js";
import { wakeThread } from "../threads/wake.js";
import type { WebhookDeps } from "./webhook-support.js";
import { reply, type WebhookResult } from "./webhook-support.js";
import type { LabeledEvent } from "./events.js";

export function renderIssueTask(issue: {
  number?: number;
  title?: string;
  body?: string | null;
  html_url?: string;
}): string {
  const parts = [
    `Fix GitHub issue #${issue.number}: ${issue.title ?? "(untitled)"}`,
  ];
  if (issue.html_url) parts.push(`\n${issue.html_url}`);
  const body = issue.body?.trim();
  if (body) parts.push(`\n${body.slice(0, 4000)}`);
  return parts.join("\n");
}
export async function handleIssueLabeled(
  deps: WebhookDeps,
  event: LabeledEvent,
  deliveryId: string,
  log: (line: string) => void,
): Promise<WebhookResult> {
  const repo = event.repository?.full_name;
  const issue = event.issue;
  if (!repo || typeof issue?.number !== "number") {
    return reply(
      { error: "payload missing repository.full_name or issue.number" }, 400);
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
      .where(
        and(
          eq(schema.threads.repo, repo),
          eq(schema.threads.issueNumber, issue.number!),
        ),
      );
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
  if (!thread)
    throw new Error(`thread for ${repo}#${issue.number} vanished mid-insert`);

  if (isTerminal(thread.state)) {
    log(
      `webhook: ${repo}#${issue.number} labeled but thread is ${thread.state} — ignored`,
    );
    return reply(
      { ignored: true, reason: `thread is ${thread.state}` }, 200);
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

  const run = await wakeThread(deps, thread.id, {
    trigger: "label",
    task: renderIssueTask(issue),
  });
  if (run) await consumeEvents(deps.db, [evt.id]); // this wake IS the turn that handles the event
  deps.hub?.notify(thread.id);

  log(
    `webhook: ${repo}#${issue.number} labeled ${AGENT_FIX_LABEL} → thread ${thread.id} ${
      run ? `→ run ${run.id} queued` : "→ queued behind the active run"
    }`,
  );
  return reply(
    { threadId: thread.id, runId: run?.id ?? null }, 202);
}
