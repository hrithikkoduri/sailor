import {
  defineTool,
  type AgentEvent,
  type Sandbox,
  type Tool,
} from "@anchor/core";
import { eq } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import type { Thread } from "../db/schema.js";
import type { GitHubClient } from "../github/client.js";
import { deliverPullRequest, type DeliveredPullRequest } from "../github/pr.js";
import { repoEnabled } from "../github/installations.js";

export interface PublicationPolicy {
  requirePassingTests?: boolean;
}

/** Side effects are real, scoped tools — never consequences of a text reply. */
export function githubTools(deps: {
  db: Db;
  thread: Thread;
  runId: string;
  sandbox: Sandbox;
  publicUrl: string;
  github: () => Promise<GitHubClient | undefined>;
  events: AgentEvent[];
  startRef?: string;
  policy?: PublicationPolicy;
  onPublished: (result: DeliveredPullRequest) => void;
}): Tool[] {
  const access = async () => {
    if (
      deps.thread.installationId == null ||
      !(await repoEnabled(
        deps.db,
        deps.thread.installationId,
        deps.thread.repo,
      ))
    )
      return undefined;
    return deps.github();
  };
  return [
    defineTool(
      {
        name: "publish_changes",
        description:
          "Publish the requested repository changes to this thread's PR (or open one). Use only when the user's request authorizes changes and they are ready for review. This does not run tests for you or certify completion. Explain verification honestly; no test suite is required unless publication policy explicitly requires one.",
        parameters: {
          type: "object",
          properties: {
            summary: {
              type: "string",
              description:
                "What changed, relevant checks performed, and remaining limitations.",
            },
          },
          required: ["summary"],
          additionalProperties: false,
        },
      },
      async (input) => {
        if (typeof input.summary !== "string" || !input.summary.trim())
          return { ok: false, content: "A publication summary is required." };
        const github = await access();
        if (!github)
          return {
            ok: false,
            content:
              "GitHub installation access is unavailable; no changes were published.",
          };
        if (!deps.startRef)
          return {
            ok: false,
            content:
              "Could not establish the starting repository revision. Publication was withheld.",
          };
        if (!(await deps.sandbox.hasChangesFrom(deps.startRef))) {
          return {
            ok: true,
            content:
              "No new repository changes were made in this turn. Nothing was published.",
            meta: { published: false },
          };
        }
        // Fail closed for an inability to inspect/stage the publication tree.
        const tree = await deps.sandbox.exec("git add -A && git write-tree", {
          timeoutSecs: 60,
        });
        const treeHash = tree.stdout.trim();
        if (tree.exitCode !== 0 || !/^[a-f0-9]{40}$/.test(treeHash))
          return {
            ok: false,
            content:
              "Could not inspect the publication tree. Nothing was published.",
          };
        const tests = [...deps.events]
          .reverse()
          .find(
            (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
              event.type === "tool_result" &&
              event.name === "run_tests" &&
              event.meta?.ran === true,
          );
        const fresh = tests?.meta?.treeHash === treeHash;
        const verification =
          fresh && tests?.ok
            ? "passed"
            : fresh && tests && !tests.ok
              ? "failed"
              : "not_verified";
        if (deps.policy?.requirePassingTests && verification !== "passed") {
          return {
            ok: false,
            content:
              "Publication policy requires a passing test run on the current tree. Publication was withheld; you may report this blocker without continuing to retry.",
            meta: { published: false, verification },
          };
        }
        const verificationText =
          verification === "passed"
            ? "Observed test run passed on this exact tree."
            : verification === "failed"
              ? "The observed test run failed on this tree."
              : "No passing test run on this exact tree was recorded. This is not a claim that tests passed.";
        let checkpointRef: string | undefined;
        if (await deps.sandbox.hasChangesFrom("HEAD")) {
          checkpointRef = (
            await deps.sandbox.checkpoint("requested changes ready for review")
          ).sha;
          await deps.db
            .update(schema.threads)
            .set({ checkpointSha: checkpointRef })
            .where(eq(schema.threads.id, deps.thread.id));
        }
        const [thread] = await deps.db
          .select()
          .from(schema.threads)
          .where(eq(schema.threads.id, deps.thread.id));
        if (!thread)
          return {
            ok: false,
            content: "The thread no longer exists. Nothing was published.",
          };
        const published = await deliverPullRequest({
          db: deps.db,
          sandbox: deps.sandbox,
          github,
          thread,
          runId: deps.runId,
          publicUrl: deps.publicUrl,
          summary: input.summary,
          verification: verificationText,
          // New unverified work is explicitly a draft, not a certified fix.
          draft: verification !== "passed",
        });
        if (!published)
          return { ok: false, content: "No pull request was published." };
        deps.onPublished(published);
        return {
          ok: true,
          content: `Published to ${published.prUrl}. ${verificationText}`,
          meta: { published: true, verification, checkpointRef, ...published },
        };
      },
      { verb: "Publishing requested changes for review" },
    ),
    defineTool(
      {
        name: "reply_on_github",
        description:
          "Post a reply to this thread's GitHub PR or issue. Use when a GitHub reply is requested or appropriate to the feedback. A normal chat response is not a posted comment. Do not claim changes or checks that did not happen.",
        parameters: {
          type: "object",
          properties: {
            body: { type: "string", description: "Reply text to post." },
          },
          required: ["body"],
          additionalProperties: false,
        },
      },
      async (input) => {
        if (typeof input.body !== "string" || !input.body.trim())
          return { ok: false, content: "A nonempty reply is required." };
        const github = await access();
        if (!github)
          return {
            ok: false,
            content:
              "GitHub installation access is unavailable. No comment was posted.",
          };
        const [thread] = await deps.db
          .select()
          .from(schema.threads)
          .where(eq(schema.threads.id, deps.thread.id));
        if (!thread)
          return {
            ok: false,
            content: "Thread not found. No comment was posted.",
          };
        const target = thread.prNumber ?? thread.issueNumber;
        await github.commentOnIssue(thread.repo, target, input.body);
        return {
          ok: true,
          content: `Posted a reply on ${thread.repo}#${target}.`,
          meta: { posted: true, target },
        };
      },
      { verb: "Replying to the GitHub discussion" },
    ),
  ];
}
