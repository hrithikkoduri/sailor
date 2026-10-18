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

/** The python driver: run one task in the current directory, print the result. */
const DRIVER = `import json, sys
from minisweagent.agents.default import DefaultAgent
from minisweagent.models.litellm_model import LitellmModel
from minisweagent.environments.local import LocalEnvironment

task = open(sys.argv[1], encoding="utf-8").read()
model = sys.argv[2]
agent = DefaultAgent(LitellmModel(model_name=model), LocalEnvironment())
result = agent.run(task)
print("MINI_RESULT " + json.dumps(result, default=str)[:2000])
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
