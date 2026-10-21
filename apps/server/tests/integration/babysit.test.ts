/**
 * The babysitter sweep (step 13) — with a fake GitHub client, real DB/queues.
 * Proves the safety-net conditions: failed checks, merge conflicts, terminal
 * PRs, missed comments, budgets, and one-turn deference.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { Pool } from "pg";
import { createDb, createPool, schema, type Db } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import {
  createQueueConnection,
  createQueues,
  type Queues,
} from "../../src/queue/index.js";
import { runBabysitSweep } from "../../src/worker/babysit.js";
import { appendEvent } from "../../src/threads/inbox.js";
import type { GitHubAppService } from "../../src/github/app.js";
import type {
  GitHubClient,
  GithubCheckRun,
  GithubComment,
  GithubPullRequestState,
} from "../../src/github/client.js";
import { loadConfig } from "../../src/config.js";

describe("runBabysitSweep", () => {
  let pool: Pool;
  let db: Db;
  let queues: Queues;
  const threadIds: string[] = [];

  beforeAll(async () => {
    pool = createPool(loadConfig().postgres.url);
    db = createDb(pool);
    await runMigrations(db);
    queues = createQueues(createQueueConnection(loadConfig().redis.url));
  });

  afterAll(async () => {
    if (threadIds.length > 0)
      await db
        .delete(schema.threads)
        .where(inArray(schema.threads.id, threadIds));
    await queues.close();
    await pool.end();
  });

  let issueSeq = 50;

  const newThread = async (
    tag: string,
    issue: number,
    opts: { turnsUsed?: number } = {},
  ) => {
    const repo = `test/babysit-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const [thread] = await db
      .insert(schema.threads)
      .values({
        repo,
        issueNumber: issue,
        source: "github",
        headRef: `sailor/issue-${issue}`,
        prNumber: issue,
        state: "pr_open",
        installationId: 700000 + ++issueSeq,
        ...(opts.turnsUsed !== undefined ? { turnsUsed: opts.turnsUsed } : {}),
      })
      .returning();
    threadIds.push(thread!.id);
    return thread!;
  };

  const fakeGithub = (opts: {
    pr?: Partial<GithubPullRequestState>;
    checks?: GithubCheckRun[];
    comments?: GithubComment[];
  }): GitHubClient => ({
    getPullRequest: async () => ({
      number: 100,
      state: "open",
      merged: false,
      mergeable: true,
      mergeable_state: "clean",
      html_url: "https://github.com/test/pr/100",
      head: { ref: "sailor/issue-100", sha: "sha-100" },
      ...opts.pr,
    }),
    getCheckRuns: async () => opts.checks ?? [],
    listIssueComments: async () => opts.comments ?? [],
    getIssue: async () => {
      throw new Error("not used");
    },
    createPullRequest: async () => {
      throw new Error("not used");
    },
    commentOnIssue: async () => undefined,
    addLabels: async () => undefined,
    listInstallationRepositories: async () => [],
    whoami: async () => ({ id: 1, login: "sailor-bot", type: "Bot" }),
  });

  /** Tokens mint per installation (decision #42) — fake the service. */
  const fakeApp = (github: GitHubClient): GitHubAppService => ({
    clientFor: async () => github,
    tokenFor: async () => "fake-token",
    invalidateTokens: () => undefined,
    appSlug: async () => undefined,
    botIdentity: async () => undefined,
    getInstallation: async () => {
      throw new Error("not used");
    },
  });

  const sweep = (github: GitHubClient, threadId: string) =>
    runBabysitSweep(
      { db, queues, githubApp: fakeApp(github), botLogin: "sailor-bot" },
      { threadId },
    );

  it("failed checks → a babysit turn is queued with the CI task", async () => {
    const thread = await newThread("ci", 50);
    const results = await sweep(
      fakeGithub({
        checks: [{ name: "unit", status: "completed", conclusion: "failure" }],
      }),
      thread.id,
    );

    expect(results).toEqual([{ threadId: thread.id, action: "ci_failed" }]);
    const runs = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.threadId, thread.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger).toBe("babysit_ci");
    expect(runs[0]!.task).toContain("unit");
  });

  it("merge conflict → a fix turn (the condition with no webhook)", async () => {
    const thread = await newThread("conflict", 51);
    const results = await sweep(
      fakeGithub({ pr: { mergeable: false, mergeable_state: "dirty" } }),
      thread.id,
    );

    expect(results).toEqual([{ threadId: thread.id, action: "conflict" }]);
    const runs = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.threadId, thread.id));
    expect(runs[0]!.task).toContain("conflicts with main");
  });

  it("a merged PR → the thread goes terminal, no turn", async () => {
    const thread = await newThread("merged", 52);
    const results = await sweep(
      fakeGithub({ pr: { state: "closed", merged: true } }),
      thread.id,
    );

    expect(results).toEqual([{ threadId: thread.id, action: "merged" }]);
    const [after] = await db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.id, thread.id));
    expect(after!.state).toBe("merged");
    expect(
      await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.threadId, thread.id)),
    ).toHaveLength(0);
  });

  it("budgets stop the babysitter", async () => {
    const thread = await newThread("budget", 53, { turnsUsed: 20 }); // default budgetMaxTurns = 20
    const results = await sweep(
      fakeGithub({
        checks: [{ name: "unit", status: "completed", conclusion: "failure" }],
      }),
      thread.id,
    );

    expect(results).toEqual([{ threadId: thread.id, action: "budget" }]);
    expect(
      await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.threadId, thread.id)),
    ).toHaveLength(0);
  });

  it("an active run defers the sweep (one turn at a time)", async () => {
    const thread = await newThread("busy", 54);
    await db
      .insert(schema.runs)
      .values({ threadId: thread.id, trigger: "manual", status: "queued" });

    const results = await sweep(
      fakeGithub({
        checks: [{ name: "unit", status: "completed", conclusion: "failure" }],
      }),
      thread.id,
    );

    expect(results).toEqual([{ threadId: thread.id, action: "busy" }]);
    expect(
      await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.threadId, thread.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(schema.events)
        .where(eq(schema.events.threadId, thread.id)),
    ).toHaveLength(0);
  });

  it("unanswered human comments → an interject turn", async () => {
    const thread = await newThread("comments", 55);
    const results = await sweep(
      fakeGithub({
        comments: [
          {
            body: "please fix the typo in the migration",
            created_at: new Date(Date.now() - 60_000).toISOString(),
            user: { login: "octocat", type: "User" },
          },
        ],
      }),
      thread.id,
    );

    expect(results).toEqual([{ threadId: thread.id, action: "comments" }]);
    const runs = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.threadId, thread.id));
    expect(runs[0]!.trigger).toBe("babysit_comment");
    expect(runs[0]!.task).toContain("please fix the typo");
  });

  it("a duplicate finding while one is pending → quiet, no double enqueue", async () => {
    const thread = await newThread("dup", 56);
    await appendEvent(db, {
      threadId: thread.id,
      kind: "check_run",
      payload: { checks: ["unit"] },
    });

    const results = await sweep(
      fakeGithub({
        checks: [{ name: "unit", status: "completed", conclusion: "failure" }],
      }),
      thread.id,
    );

    expect(results).toEqual([{ threadId: thread.id, action: "quiet" }]);
    expect(
      await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.threadId, thread.id)),
    ).toHaveLength(0);
  });
});
