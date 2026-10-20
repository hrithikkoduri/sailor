/**
 * `sailor sandbox smoke` — the Day-1 proof, now a permanent command:
 * boot a sandbox (the configured remote provider by default) → clone a repo →
 * run a command → checkpoint → destroy (unless --keep).
 *
 * Every step is timed and printed; exit code 0 means the whole loop works.
 */
import { loadConfig } from "../config.js";
import { type Sandbox } from "anchor-ai-sdk";
import { local } from "anchor-ai-sdk/sandbox/local";
import { configuredSandboxProvider } from "../sandbox-provider.js";

interface SmokeArgs {
  repo: string;
  testCmd: string;
  ref: string | undefined;
  local: boolean;
  keep: boolean;
  /** Prove the VM image's toolchain instead of the default test command. */
  toolchain: boolean;
}

const USAGE = `Usage: sailor sandbox smoke [options]

  --repo <url>        repo to clone (default: octocat/Hello-World)
  --ref <branch>      branch/tag/sha to check out after cloning
  --test-cmd <cmd>    command that proves the checkout works
                      (default: git log --oneline -1 && ls && echo SMOKE-TESTS-OK)
  --local             run on this machine instead of the configured provider
  --keep              keep the sandbox for debugging instead of destroying it
  --toolchain         prove the VM image's toolchain (git/python/node/rg)
                      instead of the default test command
`;

function parseArgs(argv: string[]): SmokeArgs | null {
  const args: SmokeArgs = {
    repo: "https://github.com/octocat/Hello-World.git",
    testCmd: "git log --oneline -1 && ls && echo SMOKE-TESTS-OK",
    ref: undefined,
    local: false,
    keep: false,
    toolchain: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--local") args.local = true;
    else if (a === "--keep") args.keep = true;
    else if (a === "--toolchain") args.toolchain = true;
    else if (a === "--repo") args.repo = argv[++i] ?? "";
    else if (a === "--ref") args.ref = argv[++i];
    else if (a === "--test-cmd") args.testCmd = argv[++i] ?? "";
    else if (a === "--help" || a === "-h") return null;
    else {
      process.stderr.write(`unknown option: ${a}\n\n${USAGE}`);
      return null;
    }
  }
  if (args.toolchain)
    args.testCmd =
      "git --version && python3 --version && python3 -m pytest --version " +
      "&& node --version && npm --version && rg --version | head -1 " +
      "&& echo TOOLCHAIN-OK";
  if (!args.repo || !args.testCmd) return null;
  return args;
}

const tail = (text: string, lines = 12) =>
  text.trim().split("\n").slice(-lines).join("\n");

export async function smokeCommand(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args) {
    process.stderr.write(USAGE);
    return 1;
  }

  const cfg = loadConfig();
  const provider = args.local ? local() : configuredSandboxProvider(cfg);
  const sandbox: Sandbox = provider.create({
    repoUrl: args.repo,
    ref: args.ref,
    keep: args.keep,
  });

  const timings: Array<{ name: string; ms: number }> = [];
  const step = async (
    name: string,
    fn: () => Promise<string | void>,
  ): Promise<string | void> => {
    process.stdout.write(`→ ${name}\n`);
    const t0 = Date.now();
    const result = await fn();
    const ms = Date.now() - t0;
    timings.push({ name, ms });
    process.stdout.write(`  ✓ ${(ms / 1000).toFixed(1)}s\n`);
    return result;
  };

  process.stdout.write(
    `\nsailor sandbox smoke — backend: ${sandbox.backend}, repo: ${args.repo}${args.ref ? ` @ ${args.ref}` : ""}\n\n`,
  );

  const t0 = Date.now();
  try {
    await step("start sandbox (create → boot → toolchain → clone)", async () => {
      await sandbox.start();
      process.stdout.write(`      sandbox: ${sandbox.id}\n`);
    });

    await step("sanity: uname", async () => {
      const r = await sandbox.exec("uname -a", { timeoutSecs: 60 });
      if (r.exitCode !== 0)
        throw new Error(`uname failed (${r.exitCode}): ${r.output}`);
      process.stdout.write(`      ${r.stdout.trim()}\n`);
    });

    await step(`tests: ${args.testCmd}`, async () => {
      const r = await sandbox.exec(args.testCmd, { timeoutSecs: 300 });
      if (r.timedOut) throw new Error(`test command timed out after 300s`);
      if (r.exitCode !== 0) {
        throw new Error(
          `test command exited ${r.exitCode}:\n${tail(r.output)}`,
        );
      }
      process.stdout.write(
        `${tail(r.output)
          .split("\n")
          .map((l) => `      ${l}`)
          .join("\n")}\n`,
      );
    });

    const sha = await step("checkpoint (git commit)", async () => {
      const cp = await sandbox.checkpoint("smoke");
      process.stdout.write(`      checkpoint sha: ${cp.sha.slice(0, 12)}\n`);
      return cp.sha;
    });

    await step(args.keep ? "keep sandbox" : "destroy sandbox", () =>
      sandbox.destroy(),
    );

    const total = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(
      `\nSMOKE PASSED in ${total}s (checkpoint ${String(sha).slice(0, 12)})\n`,
    );
    if (args.keep) {
      process.stdout.write(
        `sandbox kept: ${sandbox.id} — release it with the provider's console or \`sailor\` cleanup\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stdout.write(
      `\nSMOKE FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s\n`,
    );
    process.stderr.write(
      `  ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.stderr.write(
      `  timings: ${timings.map((t) => `${t.name}=${(t.ms / 1000).toFixed(1)}s`).join(", ")}\n`,
    );
    if (!args.keep) {
      // Clean up the VM even on failure — failed smoke runs should not bill quietly.
      await sandbox.destroy().catch(() => undefined);
    }
    return 1;
  }
}
