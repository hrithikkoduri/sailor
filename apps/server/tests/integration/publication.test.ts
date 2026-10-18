/** Explicit publication boundary. Real DB + local bare git remote; GitHub and
 * the model are fakes, so these tests never touch a live repo or launch a VM. */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { shq } from "@anchor/core";
import { LocalSandbox } from "@anchor/core/sandbox/local";
import { createPool, createDb, schema, type Db } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";
import { executeRun } from "../../src/runs/execute.js";
import type { GitHubClient } from "../../src/github/client.js";
import type { GitHubAppService } from "../../src/github/app.js";
import { seedRepo } from "../helpers/github-fixtures.js";
import { scriptedLLM } from "../helpers/scripted-llm.js";

const shell = promisify(execFile);
describe("publication is separate from turn completion", () => {
  let pool: ReturnType<typeof createPool>, db: Db;
  let root: string, bare: string, sandbox: LocalSandbox;
  let threadId: string, runId: string, installationRowId: string, repo: string;
  let github: GitHubClient, app: GitHubAppService;
  const createPr = vi.fn(
    async (_input: Parameters<GitHubClient["createPullRequest"]>[0]) => ({
      number: 99,
      html_url: "https://example.test/pr/99",
    }),
  );
  const comment = vi.fn(async () => undefined);

  beforeAll(async () => {
    pool = createPool(loadConfig().postgres.url);
    db = createDb(pool);
    await runMigrations(db);
  }, 60_000);
  beforeEach(async () => {
    createPr.mockClear();
    comment.mockClear();
    root = await mkdtemp(path.join(os.tmpdir(), "sailor-publication-"));
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(path.join(source, "README.md"), "# Before\n");
    bare = path.join(root, "origin.git");
    await shell("git", ["init", "--bare", "-q", bare]);
    sandbox = new LocalSandbox(
      { localPath: source },
      { rootDir: path.join(root, "sandboxes"), quiet: true },
    );
    await sandbox.start();
    await sandbox.checkpoint("fixture before requested change");
    await sandbox.exec(`git remote add origin ${shq(bare)}`);
    repo = `test/publication-${randomUUID()}`;
    const seeded = await seedRepo(db, repo);
    installationRowId = seeded.installationRowId;
    const [thread] = await db
      .insert(schema.threads)
      .values({
        repo,
        source: "github",
        issueNumber: 91,
        installationId: seeded.installationId,
      })
      .returning();
    threadId = thread!.id;
    const [run] = await db
      .insert(schema.runs)
      .values({
        threadId,
        trigger: "inbox",
        agent: "chat",
        task: "Review the README only; make no changes unless asked.",
      })
      .returning();
    runId = run!.id;
    github = {
      createPullRequest: createPr,
      commentOnIssue: comment,
      getIssue: async () => ({
        title: "Improve README",
        number: 91,
        body: null,
        html_url: "https://example.test/issue/91",
        state: "open",
      }),
    } as unknown as GitHubClient;
    app = {
      tokenFor: async () => "fake-installation-token",
      clientFor: async () => github,
      appSlug: async () => undefined,
      botIdentity: async () => undefined,
      getInstallation: async () => ({
        id: seeded.installationId,
        account: { login: "test", type: "Organization" },
      }),
    };
  }, 60_000);
  afterEach(async () => {
    if (sandbox) await sandbox.destroy().catch(() => undefined);
    if (threadId)
      await db.delete(schema.threads).where(eq(schema.threads.id, threadId));
    if (installationRowId)
      await db
        .delete(schema.installations)
        .where(eq(schema.installations.id, installationRowId));
    if (root)
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
  }, 30_000);
  afterAll(async () => {
    await pool.end();
  }, 30_000);

  it("a normal review answer neither publishes nor posts a comment", async () => {
    const outcome = await executeRun({
      db,
      runId,
      sandboxFactory: () => sandbox,
      githubApp: app,
      llm: scriptedLLM([
        {
          text: "The README is concise. I made no changes and posted no comments.",
        },
      ]),
    });
    expect(outcome.status).toBe("succeeded");
    expect(createPr).not.toHaveBeenCalled();
    expect(comment).not.toHaveBeenCalled();
    const [thread] = await db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.id, threadId));
    expect(thread!.prNumber).toBeNull();
  }, 30_000);

  it("publishes requested documentation without inventing tests, labeling unverified new work as a draft", async () => {
    await db
      .update(schema.runs)
      .set({ task: "Improve the README and publish it for review." })
      .where(eq(schema.runs.id, runId));
    const outcome = await executeRun({
      db,
      runId,
      sandboxFactory: () => sandbox,
      githubApp: app,
      llm: scriptedLLM([
        {
          tools: [
            {
              name: "edit_file",
              arguments: JSON.stringify({
                path: "README.md",
                old_string: "# Before",
                new_string: "# Clear project documentation",
              }),
            },
          ],
        },
        {
          tools: [
            {
              name: "publish_changes",
              arguments: JSON.stringify({
                summary:
                  "Improved README. No test suite exists; no new test scaffolding was added.",
              }),
            },
          ],
        },
        {
          text: "Published the README as an unverified draft for review; I did not claim tests passed.",
        },
      ]),
    });
    expect(outcome.status).toBe("succeeded");
    expect(createPr).toHaveBeenCalledTimes(1);
    expect(createPr.mock.calls[0]![0]).toMatchObject({
      repo,
      draft: true,
      head: "sailor/issue-91",
    });
    expect(createPr.mock.calls[0]![0].body).toContain("No passing test run");
    expect(
      (
        await shell("git", [
          "--git-dir",
          bare,
          "show",
          "refs/heads/sailor/issue-91:README.md",
        ])
      ).stdout,
    ).toContain("Clear project documentation");
    expect(comment).not.toHaveBeenCalled();
  }, 30_000);

  it("publication policy can withhold a push without preventing the agent from answering", async () => {
    const outcome = await executeRun({
      db,
      runId,
      sandboxFactory: () => sandbox,
      githubApp: app,
      publicationPolicy: { requirePassingTests: true },
      llm: scriptedLLM([
        {
          tools: [
            {
              name: "edit_file",
              arguments:
                '{"path":"README.md","old_string":"# Before","new_string":"# Requested documentation"}',
            },
          ],
        },
        {
          tools: [
            {
              name: "publish_changes",
              arguments: '{"summary":"Requested publication"}',
            },
          ],
        },
        {
          text: "Publication was withheld because the configured policy requires test evidence. I did not add a fake test runner.",
        },
      ]),
    });
    expect(outcome.status).toBe("succeeded");
    expect(createPr).not.toHaveBeenCalled();
    const rows = await db
      .select()
      .from(schema.traceEvents)
      .where(eq(schema.traceEvents.runId, runId));
    expect(
      rows.some(
        (row) =>
          row.type === "tool_result" &&
          (row.payload as { ok?: boolean }).ok === false,
      ),
    ).toBe(true);
  }, 30_000);

  it("a GitHub comment requires an explicit scoped reply tool", async () => {
    await executeRun({
      db,
      runId,
      sandboxFactory: () => sandbox,
      githubApp: app,
      llm: scriptedLLM([
        {
          tools: [
            {
              name: "reply_on_github",
              arguments:
                '{"body":"Agreed; the README does not need new test scaffolding."}',
            },
          ],
        },
        { text: "Posted the requested clarification." },
      ]),
    });
    expect(comment).toHaveBeenCalledTimes(1);
    expect(comment.mock.calls[0]).toEqual([
      repo,
      91,
      "Agreed; the README does not need new test scaffolding.",
    ]);
    expect(createPr).not.toHaveBeenCalled();
  }, 30_000);

  it("rechecks repository selection before any publication side effect", async () => {
    await db
      .update(schema.repositories)
      .set({ enabled: false })
      .where(eq(schema.repositories.fullName, repo));
    await executeRun({
      db,
      runId,
      sandboxFactory: () => sandbox,
      githubApp: app,
      llm: scriptedLLM([
        {
          tools: [
            {
              name: "publish_changes",
              arguments: '{"summary":"Requested publication"}',
            },
          ],
        },
        { text: "Repository access is disabled. Nothing was published." },
      ]),
    });
    expect(createPr).not.toHaveBeenCalled();
    expect(comment).not.toHaveBeenCalled();
  }, 30_000);
});
