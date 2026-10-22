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
import { shq } from "anchor-ai-sdk";
import { LocalSandbox } from "anchor-ai-sdk/sandbox/local";
import { createPool, createDb, schema, type Db } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";
import { executeRun } from "../../src/services/runs/execute.js";
import type { GitHubClient } from "../../src/services/github/client.js";
import type { GitHubAppService } from "../../src/services/github/app.js";
import { seedRepo } from "../helpers/github-fixtures.js";
import { scriptedLLM } from "../helpers/scripted-llm.js";

const shell = promisify(execFile);
describe("publication is separate from turn completion", () => {
  let pool: ReturnType<typeof createPool>, db: Db;
  let root: string, bare: string, sandbox: LocalSandbox;
  let threadId: string, runId: string, installationRowId: string, repo: string, userId: string;
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
    const [user] = await db.insert(schema.users).values({ login: `publication-${randomUUID()}` }).returning();
    userId = user!.id;
    await db.update(schema.installations).set({ userId }).where(eq(schema.installations.id, installationRowId));
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
      getIssue: vi.fn(async () => ({
        title: "Improve README",
        number: 91,
        body: null,
        html_url: "https://example.test/issue/91",
        state: "open",
      })),
    } as unknown as GitHubClient;
    app = {
      tokenFor: async () => "fake-installation-token",
      invalidateTokens: () => undefined,
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
    vi.restoreAllMocks();
    if (sandbox) await sandbox.destroy().catch(() => undefined);
    if (threadId)
      await db.delete(schema.threads).where(eq(schema.threads.id, threadId));
    if (installationRowId)
      await db
        .delete(schema.installations)
        .where(eq(schema.installations.id, installationRowId));
    if (userId) await db.delete(schema.users).where(eq(schema.users.id, userId));
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

  async function manualThread(source: "manual" | "workspace" = "manual") {
    await db.update(schema.threads).set({ source, userId, title: "Add Daytona support", issueNumber: -91,
      ...(source === "workspace" ? { repo: `workspace:${threadId}`, installationId: null } : {}),
    }).where(eq(schema.threads.id, threadId));
    await db.update(schema.runs).set({ keepSandbox: true, task: "Make the requested changes and open a PR." })
      .where(eq(schema.runs.id, runId));
    // Only the local bare fixture receives pushes; no network or model calls.
    expect((await sandbox.exec("git push origin HEAD:refs/heads/main")).exitCode).toBe(0);
    const exec = sandbox.exec.bind(sandbox);
    vi.spyOn(sandbox, "exec").mockImplementation((command, options) =>
      command === "git remote get-url origin"
        ? Promise.resolve({ exitCode: 0, stdout: `https://github.com/${repo}.git\n`, stderr: "", output: `https://github.com/${repo}.git\n`, timedOut: false, durationMs: 0 })
        : exec(command, options));
  }

  it("publishes an on-demand thread without an issue and keeps scratch off the delivered branch", async () => {
    await manualThread();
    const llm = scriptedLLM([
      { tools: [{ name: "edit_file", arguments: '{"path":"README.md","old_string":"# Before","new_string":"# On-demand changes"}' }] },
      { tools: [{ name: "bash", arguments: '{"command":"mkdir -p .anchor && echo private > .anchor/notes.md"}' }] },
      { tools: [{ name: "publish_changes", arguments: '{"summary":"Add requested repository changes"}' }] },
      { text: "Published for review." },
    ]);
    const result = await executeRun({ db, runId, sandboxFactory: () => sandbox, githubApp: app, llm });
    expect(result.status).toBe("succeeded");
    expect(createPr).toHaveBeenCalledTimes(1);
    expect(createPr.mock.calls[0]![0]).toMatchObject({ title: "Add Daytona support", head: `sailor/thread-${threadId}`, base: "main" });
    expect(createPr.mock.calls[0]![0].body).not.toContain("Fixes #");
    expect(github.getIssue).not.toHaveBeenCalled();
    expect(JSON.stringify(llm.seen[0]!.tools)).toContain("ask_questions");
    const tree = (await shell("git", ["--git-dir", bare, "ls-tree", "-r", "--name-only", `refs/heads/sailor/thread-${threadId}`])).stdout;
    expect(tree).not.toContain(".anchor");
    expect((await shell("git", ["--git-dir", bare, "show", "main:README.md"])).stdout).toBe("# Before\n");
    const [saved] = await db.select().from(schema.threads).where(eq(schema.threads.id, threadId));
    expect(saved).toMatchObject({ prNumber: 99, state: "pr_open" });
  }, 30_000);

  it("can publish checkpointed work from an earlier turn without requiring new edits", async () => {
    await manualThread();
    await sandbox.exec("echo '# Previous turn changes' > README.md");
    await sandbox.checkpoint("previous turn finished without publication");
    await executeRun({ db, runId, sandboxFactory: () => sandbox, githubApp: app, llm: scriptedLLM([
      { tools: [{ name: "publish_changes", arguments: '{"summary":"Publish the earlier requested changes"}' }] },
      { text: "Published existing work." },
    ]) });
    expect(createPr).toHaveBeenCalledTimes(1);
    expect((await shell("git", ["--git-dir", bare, "show", `sailor/thread-${threadId}:README.md`])).stdout).toContain("Previous turn changes");
  }, 30_000);

  it("attachment unlocks publication during the same workspace run", async () => {
    await manualThread("workspace");
    await executeRun({ db, runId, sandboxFactory: () => sandbox, githubApp: app, llm: scriptedLLM([
      { tools: [{ name: "attach_repository", arguments: JSON.stringify({ repository: repo }) }] },
      { tools: [{ name: "edit_file", arguments: '{"path":"README.md","old_string":"# Before","new_string":"# Attached repo work"}' }] },
      { tools: [{ name: "publish_changes", arguments: '{"summary":"Publish after attaching the repository"}' }] },
      { text: "Published." },
    ]) });
    expect(createPr).toHaveBeenCalledTimes(1);
    expect(github.getIssue).not.toHaveBeenCalled();
  }, 30_000);

  it.each(["disabled", "other-owner"])("manual publication rejects %s access", async (restriction) => {
    await manualThread();
    await sandbox.exec("echo '# Unpublished work' > README.md");
    if (restriction === "disabled") await db.update(schema.repositories).set({ enabled: false }).where(eq(schema.repositories.fullName, repo));
    else await db.update(schema.installations).set({ userId: null }).where(eq(schema.installations.id, installationRowId));
    await executeRun({ db, runId, sandboxFactory: () => sandbox, githubApp: app, llm: scriptedLLM([
      { tools: [{ name: "publish_changes", arguments: '{"summary":"Do not publish without access"}' }] },
      { text: "Access is unavailable." },
    ]) });
    expect(createPr).not.toHaveBeenCalled();
    expect(comment).not.toHaveBeenCalled();
    expect((await shell("git", ["--git-dir", bare, "for-each-ref", "--format=%(refname)", "refs/heads/sailor/thread-*"])).stdout.trim()).toBe("");
  }, 30_000);

  it("manual threads do not post replies to a placeholder issue", async () => {
    await manualThread();
    await executeRun({ db, runId, sandboxFactory: () => sandbox, githubApp: app, llm: scriptedLLM([
      { tools: [{ name: "reply_on_github", arguments: '{"body":"There is no issue to reply to."}' }] },
      { text: "No GitHub discussion exists yet." },
    ]) });
    expect(comment).not.toHaveBeenCalled();
    expect(createPr).not.toHaveBeenCalled();
  }, 30_000);

  it("on-demand repository threads can ask a structured question and pause before later tools", async () => {
    await manualThread();
    const llm = scriptedLLM([{ tools: [
      { name: "ask_questions", arguments: JSON.stringify({ title: "Resolve the SDK dependency", questions: [
        { id: "scope", label: "Implement the adapter or only preparatory wiring?", type: "text", required: true },
      ] }) },
      { name: "publish_changes", arguments: '{"summary":"Must not publish before the answer"}' },
    ] }]);
    const result = await executeRun({ db, runId, sandboxFactory: () => sandbox, githubApp: app, llm });
    expect(result.status).toBe("paused");
    const forms = await db.select().from(schema.questionRequests).where(eq(schema.questionRequests.threadId, threadId));
    expect(forms).toHaveLength(1);
    expect(forms[0]).toMatchObject({ status: "pending", title: "Resolve the SDK dependency" });
    expect(createPr).not.toHaveBeenCalled();
    expect(llm.seen).toHaveLength(1);
  }, 30_000);
});
