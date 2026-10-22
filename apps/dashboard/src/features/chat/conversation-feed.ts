import type {
  QuestionRequest,
  ThreadDetail,
  ThreadEventRow,
  ThreadRun,
} from "@/features/threads/api";
import { presentationFor } from "@/features/chat/presentation";
import { payloadNum, payloadStr } from "@/utils/events";

export type FeedItem =
  | { kind: "question"; id: string; at: string; request: QuestionRequest }
  | {
      kind: "human";
      id: string;
      at: string;
      author: string;
      body: string;
      label: string;
    }
  | { kind: "agent"; id: string; at: string; run: ThreadRun }
  | {
      kind: "note";
      id: string;
      at: string;
      text: string;
      count?: number;
      /** Expandable body (review/comment text). */
      details?: string;
      /** Expandable diff excerpt (review comments). */
      snippet?: string;
      /** Strictly hidden outside debug mode (⌘⇧D). */
      hidden?: boolean;
    };

const str = payloadStr;

function eventToFeedItem(e: ThreadEventRow): FeedItem | null {
  const p = e.payload;
  const at = e.receivedAt;
  // A queued chat message is not part of the conversation yet — it shows as
  // the overlapping bubble stack and lands (animated) once a turn picks it up.
  if (e.kind === "chat_message" && e.status === "pending") return null;
  const presentation = presentationFor(e.kind);
  const hidden = presentation.hidden === true;

  // Only messages written in OUR chat are user bubbles by default; every
  // external event arrives as a system receipt (presentation.ts chooses).
  if (presentation.role === "user" || e.kind === "question_answers" || e.kind === "repository_attachment") {
    return {
      kind: "human",
      id: `e${e.id}`,
      at,
      author: str(p, "author") ?? "you",
      body: str(p, "body") ?? "",
      label: e.kind === "question_answers" ? "answers" : e.kind === "chat_message" ? "dashboard" : "comment",
    };
  }

  switch (e.kind) {
    // Internal bookkeeping: shown in the composer, not as a transcript note.
    case "repository_checkout":
      return null;
    case "pull_request_review":
    case "pull_request_review_comment": {
      const author = str(p, "author") ?? "reviewer";
      const state = str(p, "state");
      const path = str(p, "path");
      const line = payloadNum(p, "line");
      const anchor = path
        ? line !== undefined
          ? `${path}:${line}`
          : path
        : undefined;
      return {
        kind: "note",
        id: `e${e.id}`,
        at,
        hidden,
        text:
          `GitHub review${state ? ` · ${state.replace(/_/g, " ")}` : ""}` +
          ` · ${author}${anchor ? ` · ${anchor}` : ""}`,
        details: str(p, "body")?.trim() || undefined,
        snippet: str(p, "diffHunk")?.split("\n").slice(-10).join("\n"),
      };
    }
    case "issue_comment":
      return {
        kind: "note",
        id: `e${e.id}`,
        at,
        hidden,
        text: `GitHub comment · ${str(p, "author") ?? "someone"}`,
        details: str(p, "body")?.trim() || undefined,
      };
    case "issue_labeled":
      return {
        kind: "note",
        id: `e${e.id}`,
        at,
        hidden,
        text: `labeled agent:fix${str(p, "title") ? ` · ${str(p, "title")}` : ""}`,
      };
    case "check_run":
    case "status": {
      const checks = Array.isArray(p.checks)
        ? (p.checks as string[]).join(", ")
        : "a check";
      return {
        kind: "note",
        id: `e${e.id}`,
        at,
        hidden,
        text: `CI: ${checks} failed`,
      };
    }
    case "push": {
      const commits = payloadNum(p, "commits");
      return {
        kind: "note",
        id: `e${e.id}`,
        at,
        hidden,
        text: `agent pushed${commits ? ` ${commits} commit${commits === 1 ? "" : "s"}` : ""} to ${str(p, "ref") ?? "the branch"}`,
      };
    }
    case "pr_conflict":
      return {
        kind: "note",
        id: `e${e.id}`,
        at,
        hidden,
        text: `PR branch conflicts with ${str(p, "base") ?? "base"}`,
      };
    case "budget_exhausted":
      return {
        kind: "note",
        id: `e${e.id}`,
        at,
        hidden,
        text: str(p, "note") ?? "run ended out of budget",
      };
    default:
      return {
        kind: "note",
        id: `e${e.id}`,
        at,
        hidden,
        text: e.kind.replace(/_/g, " "),
      };
  }
}

export function buildFeed(detail: ThreadDetail, debug: boolean): FeedItem[] {
  const feed: FeedItem[] = [];
  for (const request of detail.questions ?? []) feed.push({ kind: "question", id: request.id, at: request.createdAt, request });
  for (const e of detail.events) {
    const item = eventToFeedItem(e);
    // "hidden" kinds exist only in debug mode — strictly invisible otherwise.
    if (item && (!(item.kind === "note" && item.hidden) || debug))
      feed.push(item);
  }
  for (const run of detail.runs) {
    if (
      run.agentText ||
      run.conversation?.parts.length ||
      ["running", "queued"].includes(run.status)
    ) {
      feed.push({
        kind: "agent",
        id: `r${run.id}`,
        at: run.startedAt ?? run.createdAt,
        run,
      });
    } else if (run.status === "failed" && run.error) {
      feed.push({
        kind: "note",
        id: `r${run.id}`,
        at: run.finishedAt ?? run.createdAt,
        text: `a run failed · ${run.error.slice(0, 90)}`,
      });
    }
  }
  feed.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  // Merge consecutive pushes (the runaway-loop cleanup left noisy trails).
  const merged: FeedItem[] = [];
  for (const item of feed) {
    const last = merged[merged.length - 1];
    if (
      item.kind === "note" &&
      last?.kind === "note" &&
      item.text.startsWith("agent pushed") &&
      last.text.startsWith("agent pushed")
    ) {
      last.count = (last.count ?? 1) + 1;
      continue;
    }
    merged.push(item);
  }
  return merged;
}
