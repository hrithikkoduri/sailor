/**
 * `harness run <repo> <issue>` — one agent run, end to end.
 *
 * This is the product's thin glue over the framework package:
 *   build the sandbox (--local for dev, heyo microVM by default)
 *   → write the repo map
 *   → runAgent(codingStrategy) with live event printing
 *   → report the result
 *
 * The PR/webhook layers (steps 12–13) reuse exactly this path — they enqueue
 * runs instead of typing them.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { JsonlTrace } from "@harness/agent";
import { TraceRecorder } from "../trace/store.js";
import {
  allTools,
  codingStrategy,
  createLLMClient,
  createSandbox,
  runAgent,
  type AgentEvent,
  type Sandbox,
} from "@harness/agent";

const USAGE = `Usage: harness run <repo> <issue> [options]

  <repo>            git URL, or a local path (copied into the sandbox)
  <issue>           the task text — quote it

  --local           run on this machine (dev); default is a Heyo microVM
  --ref <branch>    checkout a branch/tag/sha after cloning (URL repos only)
  --test-cmd <cmd>  explicit test command for run_tests (default: auto-detect)
  --max-steps <n>   turn budget (default 40)
  --max-usd <n>     dollar budget (default 5)
  --keep            keep the sandbox for debugging
  --verbose         stream the model's text deltas
`;

interface RunArgs {
  repo: string;
  issue: string;
  local: boolean;
  ref?: string;
  testCmd?: string;
  maxSteps?: number;
  maxUsd?: number;
  keep: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): RunArgs | null {
  const positionals: string[] = [];
  const args: RunArgs = { repo: "", issue: "", local: false, keep: false, verbose: false };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--local") args.local = true;
    else if (a === "--keep") args.keep = true;
    else if (a === "--verbose") args.verbose = true;
    else if (a === "--ref") args.ref = argv[++i];
    else if (a === "--test-cmd") args.testCmd = argv[++i];
    else if (a === "--max-steps") args.maxSteps = Number(argv[++i]);
    else if (a === "--max-usd") args.maxUsd = Number(argv[++i]);
    else if (a === "--help" || a === "-h") return null;
    else if (a?.startsWith("--")) {
      process.stderr.write(`unknown option: ${a}\n\n${USAGE}`);
      return null;
    } else if (a !== undefined) positionals.push(a);
  }

  args.repo = positionals[0] ?? "";
  args.issue = positionals.slice(1).join(" ").trim();
  if (args.repo === "" || args.issue === "") return null;
  return args;
}

const isUrl = (repo: string) => /^(https?:\/\/|git@|ssh:\/\/)/.test(repo);

function summarizeInput(input: Record<string, unknown>): string {
  if (typeof input.command === "string") return input.command.replace(/\s+/g, " ").slice(0, 100);
  if (typeof input.path === "string") return input.path;
  if (typeof input.pattern === "string") return `"${input.pattern}"`;
  if (typeof input.summary === "string") return input.summary.slice(0, 100);
  return JSON.stringify(input).slice(0, 100);
}

function makePrinter(verbose: boolean): (e: AgentEvent) => void {
  const t0 = Date.now();
  const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`;
  let midLine = false;
  const line = (text: string) => {
    if (midLine) {
      process.stdout.write("\n");
      midLine = false;
    }
    process.stdout.write(`${stamp()} ${text}\n`);
  };

  return (e) => {
    switch (e.type) {
      case "run_started":
        line(`run started — ${e.phases.join(" → ")}`);
        break;
      case "phase_started":
        line(`━━ PHASE: ${e.phase.toUpperCase()}`);
        break;
      case "llm_call_started":
        process.stdout.write(`${stamp()} thinking (turn ${e.step})… `);
        midLine = true;
        break;
      case "llm_text_delta":
        if (verbose) process.stdout.write(e.text);
        break;
      case "llm_call_finished":
        line(`turn ${e.step}: ${e.toolCallsCount} tool call(s), ${e.usage.totalTokens} tokens, ${e.latencyMs}ms`);
        break;
      case "tool_call":
        line(`→ ${e.name}: ${summarizeInput(e.input)}`);
        break;
      case "tool_result":
        line(`  ${e.ok ? "✓" : "✗"} ${e.name}`);
        break;
      case "guardrail":
        line(`⚠ guardrail (${e.kind}): ${e.detail}`);
        break;
      case "compacted":
        line(`⟳ compacted ${e.removedMessages} old messages → ${e.summaryChars}-char summary`);
        break;
      case "checkpoint":
        line(`⛳ checkpoint ${e.ref.slice(0, 8)} — ${e.label}`);
        break;
      case "run_finished": {
        const cost = e.usage.costUsd !== undefined ? `, $${e.usage.costUsd.toFixed(4)}` : "";
        line(`${e.ok ? "DONE ✓" : "STOPPED ✗"} — ${e.reason}, ${e.steps} turns, ${e.usage.totalTokens} tokens${cost}`);
        if (e.summary) line(`summary: ${e.summary}`);
        break;
      }
      case "error":
        line(`error: ${e.message}`);
        break;
    }
  };
}

export async function runCommand(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args) {
    process.stderr.write(USAGE);
    return 1;
  }
  if (args.ref && !isUrl(args.repo)) {
    process.stderr.write(`note: --ref is ignored for local paths\n`);
  }

  const cfg = loadConfig();

  // npm runs workspace scripts with cwd=apps/harness; INIT_CWD is where the
  // user actually typed the command — resolve relative repo paths from there.
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const localPath = isUrl(args.repo) ? undefined : path.resolve(baseDir, args.repo);
  if (localPath && !existsSync(localPath)) {
    process.stderr.write(`repo path not found: ${localPath} (resolved from ${baseDir})\n`);
    return 1;
  }

  const sandbox: Sandbox = createSandbox(
    isUrl(args.repo)
      ? { repoUrl: args.repo, ref: args.ref, keep: args.keep }
      : { localPath, keep: args.keep },
    args.local
      ? { local: true }
      : {
          heyo: {
            token: cfg.heyo.token ?? "",
            server: cfg.heyo.server,
            namespace: cfg.heyo.namespace,
            image: cfg.heyo.image,
            sizeClass: cfg.heyo.sizeClass,
            diskSizeGb: cfg.heyo.diskSizeGb,
            githubToken: cfg.github.token,
          },
        },
  );

  process.stdout.write(
    `\nharness run — backend: ${sandbox.backend}, sandbox: ${sandbox.id}\nrepo: ${args.repo}\nissue: ${args.issue}\n\n`,
  );

  const printer = makePrinter(args.verbose);
  const llm = createLLMClient(cfg.llm);

  // Trace: NDJSON file per run (DB rows join in step 10, when a thread owns the run).
  const runId = randomUUID();
  const jsonl = new JsonlTrace(path.join(baseDir, "traces", `${runId}.jsonl`));
  const recorder = new TraceRecorder({ jsonl });
  let sinkTail: Promise<void> = Promise.resolve();
  const sink = (e: AgentEvent) => {
    printer(e);
    sinkTail = sinkTail.then(() => recorder.record(e));
  };

  try {
    await sandbox.start();

    const result = await runAgent(
      // No explicit context: codingStrategy.prepareContext() writes the repo map.
      { task: args.issue, testCommand: args.testCmd },
      {
        llm,
        sandbox,
        tools: allTools,
        strategy: codingStrategy,
        budgets: { maxSteps: args.maxSteps ?? 40, maxUsd: args.maxUsd ?? 5 },
        onEvent: sink,
      },
    );

    await sinkTail; // flush the trace before exiting
    await sandbox.destroy();
    process.stdout.write(`\ntrace: ${path.relative(baseDir, jsonl.filePath)} (${recorder.events} events)\n`);
    if (args.keep) process.stdout.write(`sandbox kept: ${sandbox.id}\n`);
    return result.ok ? 0 : 1;
  } catch (err) {
    await sinkTail.catch(() => undefined);
    process.stderr.write(`\nrun failed: ${err instanceof Error ? err.message : String(err)}\n`);
    await sandbox.destroy().catch(() => undefined);
    return 1;
  }
}
