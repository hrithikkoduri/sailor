#!/usr/bin/env node
/**
 * harness — label a GitHub issue, get a fix PR with tests and a full trace,
 * run inside an isolated Firecracker microVM.
 *
 * This is the command router. Each command lives in its own module; this file
 * only parses argv and dispatches. Commands not built yet print the step in
 * BUILD_PLAN.md where they land — the CLI doubles as the project roadmap.
 */
import { loadConfig, loadDotEnv } from "./config.js";
import { runDoctor, renderDoctor, doctorPassed } from "./doctor.js";

interface PlannedCommand {
  summary: string;
  step: string;
}

const PLANNED: Record<string, PlannedCommand> = {
  eval: { summary: "run the eval suite and report metrics", step: "15" },
};

function usage(): string {
  const rows = [
    ["doctor", "check the environment", ""],
    ["migrate", "apply database migrations (safe to re-run)", ""],
    ["run", "run the coding agent on a repo + issue (direct, no DB)", ""],
    ["runs enqueue", "create a thread/run and queue it for the worker", ""],
    ["worker", "long-lived worker: runs queue + stale-run sweep", ""],
    ["serve", "GitHub webhook intake: labeled issues → threads + runs", ""],
    ["sandbox smoke", "boot a microVM → clone → test → checkpoint → destroy", ""],
    ["llm smoke", "live round-trip of the LLM client (text + stream + tools)", ""],
    ...Object.entries(PLANNED).map(([cmd, info]) => [cmd, info.summary, `planned — step ${info.step}`]),
    ["help", "show this message", ""],
  ];
  const width = Math.max(...rows.map((r) => (r[0] ?? "").length));
  const lines = [
    "Usage: harness <command>",
    "",
    "Commands:",
    ...rows.map(([cmd, desc, note]) => `  ${(cmd ?? "").padEnd(width)}  ${desc ?? ""}${note ? `  (${note})` : ""}`),
    "",
    "See BUILD_PLAN.md for the full build plan.",
  ];
  return lines.join("\n");
}

async function main(): Promise<number> {
  loadDotEnv(); // fill from .env; real environment variables win
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "doctor": {
      const cfg = loadConfig();
      const results = await runDoctor(cfg);
      if (args.includes("--json")) {
        process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
      } else {
        process.stdout.write(`${renderDoctor(results)}\n`);
      }
      return doctorPassed(results) ? 0 : 1;
    }

    case "migrate": {
      const { createPool, createDb } = await import("./db/index.js");
      const { runMigrations } = await import("./db/migrate.js");
      const pool = createPool(loadConfig().postgres.url);
      try {
        await runMigrations(createDb(pool));
        process.stdout.write("migrations applied (database up to date)\n");
      } finally {
        await pool.end();
      }
      return 0;
    }

    case "sandbox": {
      const sub = args[0];
      if (sub === "smoke") {
        const { smokeCommand } = await import("./commands/smoke.js");
        return smokeCommand(args.slice(1));
      }
      process.stderr.write(`unknown sandbox subcommand: ${sub ?? "(none)"} — try: harness sandbox smoke\n`);
      return 1;
    }

    case "llm": {
      const sub = args[0];
      if (sub === "smoke") {
        const { llmSmokeCommand } = await import("./commands/llm-smoke.js");
        return llmSmokeCommand();
      }
      process.stderr.write(`unknown llm subcommand: ${sub ?? "(none)"} — try: harness llm smoke\n`);
      return 1;
    }

    case "run": {
      const { runCommand } = await import("./commands/run.js");
      return runCommand(args);
    }

    case "worker": {
      const { workerCommand } = await import("./worker/index.js");
      return workerCommand(args);
    }

    case "serve": {
      const { serveCommand } = await import("./server/serve.js");
      return serveCommand(args);
    }

    case "runs": {
      const { runsCommand } = await import("./commands/runs.js");
      return runsCommand(args);
    }

    case "help":
    case undefined:
      process.stdout.write(`${usage()}\n`);
      return command === undefined ? 1 : 0;

    default: {
      process.stderr.write(`Unknown command: ${command}\n\n${usage()}\n`);
      return 1;
    }
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
