/**
 * Live tool conformance against the Heyo backend — runs only when HEYO_TOKEN
 * is set (`npm run test:integration` with a .env present).
 *
 * One VM is booted for the whole file: boot is the expensive part (~5s),
 * individual tool calls are ~100ms. What dev proves on LocalSandbox, this
 * file proves on a real Firecracker microVM.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, loadDotEnv } from "../../src/config.js";
import { HeyoSandbox, toolByName } from "@anchor/core";
import type { Tool, ToolContext } from "@anchor/core";

loadDotEnv();
const cfg = loadConfig();

function tool(name: string): Tool {
  const t = toolByName(name);
  if (!t) throw new Error(`no tool named ${name}`);
  return t;
}

const hasToken = Boolean(cfg.heyo.token);

describe.skipIf(!hasToken)("heyo backend — live tool conformance (one shared VM)", () => {
  let sandbox: HeyoSandbox;
  let ctx: ToolContext;

  beforeAll(async () => {
    sandbox = new HeyoSandbox(
      {},
      {
        token: cfg.heyo.token ?? "",
        server: cfg.heyo.server,
        namespace: cfg.heyo.namespace,
        image: cfg.heyo.image,
        sizeClass: cfg.heyo.sizeClass,
        diskSizeGb: cfg.heyo.diskSizeGb,
      },
    );
    await sandbox.start();
    ctx = { sandbox };
  }, 300_000);

  afterAll(async () => {
    await sandbox?.destroy();
  }, 120_000);

  it("bash runs on the VM and reports exit codes", async () => {
    const ok = await tool("bash").run({ command: "echo vm-ok && uname -s" }, ctx);
    expect(ok.ok).toBe(true);
    expect(ok.content).toContain("vm-ok");
    expect(ok.content).toContain("Linux");

    const bad = await tool("bash").run({ command: "exit 4" }, ctx);
    expect(bad.ok).toBe(false);
    expect(bad.meta?.exitCode).toBe(4);
  });

  it("read_file / search / edit_file round-trip inside the VM", async () => {
    const write = await tool("bash").run(
      { command: "printf 'alpha\\nbeta (x)\\ngamma\\n' > note.txt" },
      ctx,
    );
    expect(write.ok).toBe(true);

    const read = await tool("read_file").run({ path: "note.txt" }, ctx);
    expect(read.ok).toBe(true);
    expect(read.content).toContain("beta (x)");

    const found = await tool("search").run({ pattern: "beta (x)" }, ctx);
    expect(found.ok).toBe(true);
    expect(found.content).toContain("note.txt");

    const edit = await tool("edit_file").run(
      { path: "note.txt", old_string: "gamma", new_string: "delta" },
      ctx,
    );
    expect(edit.ok).toBe(true);
    expect(edit.meta?.line).toBe(3);

    const after = await tool("read_file").run({ path: "note.txt" }, ctx);
    expect(after.content).toContain("delta");
    expect(after.content).not.toContain("gamma");
  }, 120_000);

  it("run_tests executes and reports structured status", async () => {
    const r = await tool("run_tests").run({ command: "echo VM-TESTS-OK" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("VM-TESTS-OK");
    expect(r.meta?.exitCode).toBe(0);
  });

  it("checkpoint yields a real commit sha inside the VM", async () => {
    const cp = await sandbox.checkpoint("live tool conformance");
    expect(cp.sha).toMatch(/^[0-9a-f]{40}$/);
    const log = await sandbox.exec("git log -1 --format=%s");
    expect(log.stdout.trim()).toBe("live tool conformance");
  });
});
