/**
 * Sandbox continuity (A + B) — the interrupted-run guarantee:
 *
 *   A: a run on a GitHub thread RETAINS its sandbox, and the next run ADOPTS
 *      it — same workspace, edits intact, no re-clone.
 *   B: turn-boundary checkpoints are force-pushed to a side branch the push
 *      webhook ignores, so a destroyed VM never loses the work.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { LocalSandbox, type Sandbox, type SandboxSpec } from "@anchor/core";
import { createDb, createPool, schema, type Db } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { executeRun, releaseThreadSandbox } from "../../src/runs/execute.js";
import { loadConfig } from "../../src/config.js";
import { scriptedLLM, type Scripted } from "../helpers/scripted-llm.js";

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

const PUSH_BRANCH = "sailor/issue-11-checkpoint";

describe("sandbox continuity (retain/adopt + checkpoint push)", () => {
  let root: string;
  let pool: Pool;
  let db: Db;
  let threadId: string;
  const made: Sandbox[] = [];

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "anchor-cont-"));
    // Seed repo with a bare origin — the checkpoint push target.
    const seed = path.join(root, "seed");
    await mkdir(seed, { recursive: true });
    git(root, "init", "-q", "--bare", path.join(root, "origin.git"));
    git(seed, "init", "-q", "-b", "main");
    git(seed, "config", "user.name", "fixture");
    git(seed, "config", "user.email", "fixture@localhost");
    await writeFile(path.join(seed, "README.md"), "v1\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", "v1");
    git(seed, "remote", "add", "origin", path.join(root, "origin.git"));

    pool = createPool(loadConfig().postgres.url);
    db = createDb(pool);
    await runMigrations(db);
    const [thread] = await db
      .insert(schema.threads)
      .values({ repo: "acme/continuity", issueNumber: 11, source: "github" })
      .returning();
    threadId = thread!.id;
  });

  afterAll(async () => {
    const [row] = await db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.id, threadId));
    if (row) await releaseThreadSandbox(db, row).catch(() => undefined);
    await db.delete(schema.threads).where(eq(schema.threads.id, threadId));
    await pool.end();
    await rm(root, { recursive: true, force: true });
  });

  /** The test factory overrides the clone source with the seeded local repo. */
  const factory = (spec: SandboxSpec): Sandbox => {
    const sandbox = new LocalSandbox(
      {
        ...spec,
        ...(spec.adopt ? {} : { localPath: path.join(root, "seed") }),
        repoUrl: undefined,
      },
      { rootDir: path.join(root, "sandboxes"), quiet: true },
    );
    made.push(sandbox);
    return sandbox;
  };

  const addRun = async (task: string) => {
    const [run] = await db
      .insert(schema.runs)
      .values({ threadId, trigger: "manual", task })
      .returning();
    return run!.id;
  };

  it("run 1 retains the sandbox and pushes the checkpoint branch", async () => {
    const runId = await addRun("leave a note");
    const script: Scripted[] = [
      {
        tools: [
          {
            name: "bash",
            arguments: JSON.stringify({
              command: "echo 'run one was here' > note.txt",
            }),
          },
        ],
      },
      { text: "Noted." },
    ];
    const outcome = await executeRun({
      db,
      runId,
      local: true,
      llm: scriptedLLM(script),
      sandboxFactory: factory,
    });
    expect(outcome.status).toBe("succeeded");

    const [thread] = await db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.id, threadId));
    expect(thread!.sandboxId).toBe(made[0]!.id);
    expect(thread!.sandboxBackend).toBe("local");
    expect(thread!.checkpointRef).toBe(PUSH_BRANCH);

    // B: the checkpoint landed on the origin as a real branch.
    const refs = spawnSync(
      "git",
      [
        `--git-dir=${path.join(root, "origin.git")}`,
        "rev-parse",
        `refs/heads/${PUSH_BRANCH}`,
      ],
      { encoding: "utf8" },
    );
    expect(refs.status).toBe(0);
    expect(refs.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("run 2 adopts the SAME workspace — the edit is still there", async () => {
    const runId = await addRun("continue");
    const outcome = await executeRun({
      db,
      runId,
      local: true,
      llm: scriptedLLM([{ text: "Continuing." }]),
      sandboxFactory: factory,
    });
    expect(outcome.status).toBe("succeeded");

    const adopted = made.at(-1)!;
    expect(adopted.id).toBe(made[0]!.id); // adopted, not re-cloned
    // The workspace directory is retained; read it from the host path (the
    // instance itself is marked destroyed at run end, but the disk stays).
    const note = await readFile(path.join(adopted.workspace, "note.txt"), "utf8");
    expect(note).toContain("run one was here");

    const [thread] = await db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.id, threadId));
    expect(thread!.sandboxId).toBe(adopted.id);
  });
});
