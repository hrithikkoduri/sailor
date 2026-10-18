/**
 * The `mini-swe-agent` arm — the baseline harness, in the SAME sandbox as the
 * anchor arm: same image, same repo state, same model, same runner, same
 * patch extraction. That is the whole point: the A/B isolates the agent
 * design, not the environment.
 *
 * mini is embedded via its Python bindings (DefaultAgent + LitellmModel +
 * LocalEnvironment) rather than its CLI, so nothing of its own environment
 * management is in play. It is installed into a private venv inside the
 * container so its dependencies cannot disturb the task's environment.
 */
import { shq } from "@anchor/core";
import type { EvalArm, EvalArmContext } from "../runner.js";
import type { EvalTask } from "../tasks.js";

export interface MiniSweArmOptions {
  /** Provider API key — rides into the sandbox as an env var per exec. */
  apiKey?: string;
  /** litellm model id including provider, e.g. `openrouter/z-ai/glm-5.3`. */
  model: string;
  /** mini's own spend cap (USD). Default 2. */
  costLimitUsd?: number;
}

/** The python driver: run one task in the current directory, print the result.
 * Mirrors mini's own swebench runner: its battle-tested templates come from
 * the packaged swebench.yaml; mode yolo + confirm_exit false = non-interactive. */
const DRIVER = `import sys
from minisweagent.agents import get_agent
from minisweagent.config import builtin_config_dir, get_config_from_spec
from minisweagent.environments.local import LocalEnvironment
from minisweagent.models import get_model
from minisweagent.utils.serialize import recursive_merge

task = open(sys.argv[1], encoding="utf-8").read()
config = recursive_merge(
    get_config_from_spec(str(builtin_config_dir / "benchmarks" / "swebench.yaml")),
    {
        "agent": {"mode": "yolo", "confirm_exit": False},
        "model": {"model_name": sys.argv[2]},
    },
)
agent = get_agent(
    get_model(config=config.get("model", {})),
    LocalEnvironment(),
    config.get("agent", {}),
    default_type="default",
)
agent.run(task)
print("MINI_DONE")
`;

export function miniSweArm(opts: MiniSweArmOptions): EvalArm {
  return {
    name: "mini-swe-agent",
    async run(task: EvalTask, ctx: EvalArmContext) {
      const writeFile = async (path: string, content: string) => {
        const encoded = Buffer.from(content, "utf8").toString("base64");
        const r = await ctx.sandbox.exec(
          `printf %s ${shq(encoded)} | base64 -d > ${shq(path)}`,
          { cwd: "/", timeoutSecs: 60 },
        );
        if (r.exitCode !== 0) {
          throw new Error(`could not write ${path}: ${r.output.trim()}`);
        }
      };
      await writeFile("/tmp/mini-task.md", task.problem);
      await writeFile("/tmp/mini-driver.py", DRIVER);

      const install = await ctx.sandbox.exec(
        "python -m venv /opt/mini-venv && /opt/mini-venv/bin/pip install --quiet mini-swe-agent",
        { cwd: "/", timeoutSecs: 900 },
      );
      if (install.exitCode !== 0) {
        throw new Error(
          `mini-swe-agent install failed: ${install.output.trim().slice(0, 400)}`,
        );
      }

      const run = await ctx.sandbox.exec(
        `/opt/mini-venv/bin/python /tmp/mini-driver.py /tmp/mini-task.md ${shq(opts.model)}`,
        {
          cwd: ctx.sandbox.workspace,
          timeoutSecs: 3600,
          env: {
            MSWEA_GLOBAL_COST_LIMIT: String(opts.costLimitUsd ?? 2),
            ...(opts.apiKey ? { OPENROUTER_API_KEY: opts.apiKey } : {}),
          },
        },
      );
      // A non-zero exit means the harness itself failed to run — the system
      // under test failing to launch is a failure, not an empty patch — so
      // surface its output tail instead of swallowing it.
      if (run.exitCode !== 0) {
        throw new Error(
          `mini run exited ${run.exitCode}: ${run.output.trim().slice(-500)}`,
        );
      }
      return {};
    },
  };
}
