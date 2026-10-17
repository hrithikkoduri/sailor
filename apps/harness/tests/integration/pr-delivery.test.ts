/**
 * PR delivery — a real push through a LocalSandbox to a bare origin, plus a
 * fake GitHub API. Proves: the branch lands, the base is untouched, the PR
 * carries the trace link, the thread flips to pr_open, and the gate holds.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { LocalSandbox } from "@harness/agent";
import { createDb, createPool, schema, type Db } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { deliverPullRequest, traceUrl } from "../../src/github/pr.js";
import type { GitHubClient } from "../../src/github/client.js";
import { loadConfig } from "../../src/config.js";

const FIXTURE = fileURLToPath(new URL("../../../../fixtures/buggy-lib", import.meta.url));

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

describe("deliverPullRequest", () => {
  let pool: Pool;
  let db: Db;
  let tmp: string;
  let bare: string;
  let work: string;
  let threadId: string;

  beforeAll(async () => {
    pool = createPool(loadConfig().postgres.url);
    db = createDb(pool);
    await runMigrations(db);

    tmp = await mkdtemp(path.join(os.tmpdir(), "harness-pr-"));
    bare = path.join(tmp, "origin.git");
    work = path.join(tmp, "work");

    // A bare origin with one commit on main — the stand-in for GitHub.
    git(tmp, "init", "--bare", "-q", "-b", "main", bare);
    await mkdir(work, { recursive: true });
    for (const entry of await readdir(FIXTURE)) {
      await cp(path.join(FIXTURE, entry), path.join(work, entry), { recursive: true });
    }
    await rm(path.join(work, ".git"), { recursive: true, force: true });
    git(work, "init", "-q", "-b", "main");
    git(work, "config", "user.name", "harness");
    git(work, "config", "user.email", "harness@localhost");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "seed");
    git(work, "remote", "add", "origin", bare);
    git(work, "push", "-q", "-u", "origin", "main");

    const [thread] = await db
      .insert(schema.threads)
      .values({
        repo: "acme/demo",
        issueNumber: 42,
        source: "github",
        baseRef: "main",
        headRef: "harness/issue-42",
        state: "running",
      })
      .returning();
    threadId = thread!.id;
  });

  afterAll(async () => {
    if (threadId) await db.delete(schema.threads).where(eq(schema.threads.id, threadId));
    await pool.end();
    await rm(tmp, { recursive: true, force: true });
  });

  const fakeGithub = () => {
    const created: Parameters<GitHubClient["createPullRequest"]>[0][] = [];
    const github: GitHubClient = {
      getIssue: async () => ({
        number: 42,
        title: "add() drops negative numbers",
        body: null,
        html_url: "https://github.com/acme/demo/issues/42",
        state: "open",
      }),
      createPullRequest: async (input) => {
        created.push(input);
        return { number: 99, html_url: "https://github.com/acme/demo/pull/99" };
      },
      whoami: async () => ({ login: "harness-bot", type: "Bot" }),
    };
    return { github, created };
  };

  it("pushes the branch, opens the PR with a trace link, flips the thread to pr_open", async () => {
    const sandbox = new LocalSandbox({ localPath: work }, { quiet: true });
    await sandbox.start();

    // the agent's work: one commit on top of main
    const commit = await sandbox.exec(
      'echo "// fixed negatives" >> src/sum.js && git add -A && git commit -q -m "fix: negatives"',
    );
    expect(commit.exitCode).toBe(0);

    const { github, created } = fakeGithub();
    const [thread] = await db.select().from(schema.threads).where(eq(schema.threads.id, threadId));
    const runId = "11111111-1111-1111-1111-111111111111";
    const delivered = await deliverPullRequest({
      db,
      sandbox,
      github,
      thread: thread!,
      runId,
      publicUrl: "http://localhost:5173",
      summary: "fixed negatives",
    });

    expect(delivered).toMatchObject({ prNumber: 99, headRef: "harness/issue-42" });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ repo: "acme/demo", head: "harness/issue-42", base: "main" });
    expect(created[0]!.title).toBe("Fix #42: add() drops negative numbers");
    expect(created[0]!.body).toContain("Fixes #42");
    expect(created[0]!.body).toContain("fixed negatives");
    expect(created[0]!.body).toContain(traceUrl("http://localhost:5173", threadId, runId));

    // the branch landed on origin; main is untouched
    const refs = git(bare, "for-each-ref", "--format=%(refname)").trim().split("\n");
    expect(refs).toContain("refs/heads/harness/issue-42");
    expect(refs).toContain("refs/heads/main");
    expect(git(bare, "rev-list", "--count", "refs/heads/main").trim()).toBe("1");
    expect(git(bare, "rev-list", "--count", "refs/heads/harness/issue-42").trim()).toBe("2");

    const [fresh] = await db.select().from(schema.threads).where(eq(schema.threads.id, threadId));
    expect(fresh!.prNumber).toBe(99);
    expect(fresh!.prUrl).toBe("https://github.com/acme/demo/pull/99");
    expect(fresh!.state).toBe("pr_open");

    // idempotent gate: a thread that already has a PR is left alone
    expect(
      await deliverPullRequest({ db, sandbox, github, thread: fresh!, runId, publicUrl: "http://localhost:5173" }),
    ).toBeNull();
    expect(created).toHaveLength(1);

    await sandbox.destroy();
  });

  it("refuses to push the base branch (never touches main)", async () => {
    const [thread2] = await db
      .insert(schema.threads)
      .values({
        repo: "acme/demo",
        issueNumber: 43,
        source: "github",
        baseRef: "main",
        headRef: "main",
        state: "running",
      })
      .returning();
    const sandbox = new LocalSandbox({ localPath: work }, { quiet: true });
    const { github } = fakeGithub();
    await expect(
      deliverPullRequest({ db, sandbox, github, thread: thread2!, runId: "x", publicUrl: "http://localhost:5173" }),
    ).rejects.toThrow(/refusing to push/);
    await db.delete(schema.threads).where(eq(schema.threads.id, thread2!.id));
  });
});
