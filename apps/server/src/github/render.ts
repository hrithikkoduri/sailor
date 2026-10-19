/**
 * GitHub events → turn tasks.
 *
 * A turn's task text is what the agent reads when it starts; it must carry
 * the event's meaning AND the expected behavior (decision #28), never raw
 * JSON. Shared by the webhook door, the pre-turn inbox renderer, and the
 * babysitter sweep — one place, one voice.
 */
export function renderGithubTask(
  kind: string,
  payload: Record<string, unknown>,
): string {
  const s = (k: string): string | undefined =>
    typeof payload[k] === "string" ? (payload[k] as string) : undefined;
  const n = (k: string): number | undefined =>
    typeof payload[k] === "number" ? (payload[k] as number) : undefined;

  switch (kind) {
    case "check_run":
    case "status": {
      const names = Array.isArray(payload.checks)
        ? (payload.checks as string[]).join(", ")
        : (s("name") ?? s("context") ?? "checks");
      const url = s("url");
      return (
        `CI failed on your PR branch: ${names}.` +
        (url ? `\n${url}` : "") +
        `\nInvestigate the failure and address it within scope. Publish a ready correction to the same PR using publish_changes; report any blockers honestly.`
      );
    }
    case "pull_request_review":
    case "pull_request_review_comment": {
      if (payload["self"] === true) {
        return (
          `No action needed — your own review activity on the PR was echoed back as a webhook.` +
          `\n\n${(s("body") ?? "").trim().slice(0, 4000)}` +
          `\n\nAcknowledge briefly in the thread only. Do not comment on GitHub — any GitHub reply would echo back again.`
        );
      }
      const author = s("author") ?? "a reviewer";
      const state = s("state");
      const body = s("body")?.trim();
      const path = s("path");
      const line = n("line");
      const side = s("side");
      const prTitle = s("prTitle");
      const diffHunk = s("diffHunk");
      const fileLevel = s("subjectType") === "file";
      // The hunk's tail is the context the reviewer saw around the comment.
      const snippet = diffHunk
        ? diffHunk.split("\n").slice(-12).join("\n").slice(0, 1600)
        : undefined;
      const anchor = path
        ? line !== undefined && !fileLevel
          ? `${path}:${line}`
          : path
        : undefined;
      return [
        `Review feedback from ${author}${state ? ` (${state})` : ""}${prTitle ? ` on \u201c${prTitle}\u201d` : ""}:`,
        ...(anchor
          ? [
              `At ${anchor}${side ? ` (${side} side)` : ""}${fileLevel ? " (file-level)" : ""}:`,
            ]
          : []),
        ...(snippet ? ["```diff\n" + snippet + "\n```"] : []),
        ...(body ? [body.slice(0, 4000)] : []),
        ...(!body && !snippet
          ? [
              "(No comment text was delivered with the event — check the pull request.)",
            ]
          : []),
        `Address this feedback as requested. It may change the scope of earlier work. Make a focused correction or reply with a clarification as appropriate; do not assume every comment describes an executable bug.`,
      ].join("\n\n");
    }
    case "issue_comment": {
      const author = s("author") ?? "a user";
      const body = s("body")?.trim() ?? "";
      if (payload["self"] === true) {
        // The agent's own reply, echoed back by GitHub. Replying on GitHub
        // again would echo again — the ack lives in the thread, which no
        // webhook watches, so the chain terminates here (decision #28).
        return (
          `No action needed — your own comment on the PR was echoed back as a webhook (you posted it with reply_on_github).` +
          `\n\n${body.slice(0, 4000)}` +
          `\n\nAcknowledge briefly in the thread only. Do not reply on GitHub — any GitHub reply would echo back again.`
        );
      }
      return (
        `New comment from ${author}:\n\n${body.slice(0, 4000)}` +
        `\n\nRespond on the PR — fix or clarify as appropriate.`
      );
    }
    case "chat_message": {
      const author = s("author") ?? "the operator";
      const body = s("body")?.trim() ?? "";
      return (
        `Message from ${author} (dashboard chat):\n\n${body.slice(0, 4000)}` +
        `\n\nThis is a direct message in the conversation — reply to it in text.` +
        `\nIf the repository work on this thread is unfinished and this message does not redirect or stop you, continue that work after your reply.`
      );
    }
    case "push": {
      const count = n("commits") ?? 0;
      const ref = s("ref") ?? "the branch";
      return (
        `No action needed — your own push landed (${count} commit${count === 1 ? "" : "s"} on ${ref}). ` +
        `Acknowledge briefly that it landed.`
      );
    }
    case "pr_conflict": {
      const base = s("base") ?? "the base branch";
      return (
        `The PR branch now conflicts with ${base} (no webhook exists for this — the sweep found it). ` +
        `Update the branch (rebase or merge), resolve the conflicts, and push the result.`
      );
    }
    case "issue_labeled": {
      const number = n("number");
      const title = s("title") ?? "(untitled)";
      const url = s("url");
      const body = s("body")?.trim();
      return (
        `Fix GitHub issue${number !== undefined ? ` #${number}` : ""}: ${title}` +
        (url ? `\n${url}` : "") +
        (body ? `\n\n${body.slice(0, 4000)}` : "")
      );
    }
    case "background_result": {
      const jobId = s("jobId") ?? "unknown";
      const command = s("command") ?? "(command not recorded)";
      const output = (s("output") ?? "").trim();
      const note = s("note");
      const status = s("status") ?? "done";
      if (status !== "done") {
        return (
          `A background command could not be confirmed (job ${jobId}) — do not run it again.` +
          (note ? `\n${note}` : "") +
          `\n\n$ ${command}`
        );
      }
      return (
        `A background command finished (job ${jobId}, exit ${n("exitCode") ?? "?"}) — do not run it again.` +
        `\n\n$ ${command}\n\n${output || "(no output)"}`
      );
    }
    default:
      return `[${kind}] ${JSON.stringify(payload).slice(0, 500)}`;
  }
}
