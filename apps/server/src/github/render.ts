/**
 * GitHub events → turn tasks.
 *
 * A turn's task text is what the agent reads when it starts; it must carry
 * the event's meaning AND the expected behavior (decision #28), never raw
 * JSON. Shared by the webhook door, the pre-turn inbox renderer, and the
 * babysitter sweep — one place, one voice.
 */
export function renderGithubTask(kind: string, payload: Record<string, unknown>): string {
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
      const author = s("author") ?? "a reviewer";
      const state = s("state");
      const body = s("body")?.trim() || "(no text — see the diff comments)";
      const path = s("path");
      return (
        `Review feedback from ${author}${state ? ` (${state})` : ""}${path ? ` on ${path}` : ""}:` +
        `\n\n${body.slice(0, 4000)}` +
        `\n\nAddress this feedback as requested. It may change the scope of earlier work. Make a focused correction or reply with a clarification as appropriate; do not assume every comment describes an executable bug.`
      );
    }
    case "issue_comment": {
      const author = s("author") ?? "a user";
      const body = s("body")?.trim() ?? "";
      return (
        `New comment from ${author}:\n\n${body.slice(0, 4000)}` +
        `\n\nRespond on the PR — fix or clarify as appropriate.`
      );
    }
    case "chat_message": {
      const author = s("author") ?? "the operator";
      const body = s("body")?.trim() ?? "";
      return (
        `Message from ${author} (dashboard chat):\n\n${body.slice(0, 4000)}`
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
    default:
      return `[${kind}] ${JSON.stringify(payload).slice(0, 500)}`;
  }
}
