/**
 * The `sailor` arm — the product's agent, minus the product.
 *
 * Sailor's prompt and coding tools, no GitHub tools, no thread store, no
 * publication: the same configuration Sailor runs on real threads, on plain
 * Anchor. This is the entire product coupling of the benchmark — everything
 * else in `apps/evals` talks to `@anchor/core` only.
 */
import { runAgent } from "@anchor/core";
import { createSailorAgent } from "../../../server/src/agents/sailor.js";
import type { EvalArm, EvalArmContext } from "../runner.js";
import type { EvalTask } from "../tasks.js";

export function sailorArm(): EvalArm {
  return {
    name: "sailor",
    async run(task: EvalTask, ctx: EvalArmContext) {
      const context = JSON.stringify(
        {
          repository: task.repoUrl,
          workspace: ctx.sandbox.workspace,
          baseCommit: task.baseRef,
          note: "A benchmark task: make the requested change in this repository. There is no remote and no publication — the workspace diff is the deliverable.",
        },
        null,
        2,
      );
      const outcome = await runAgent(
        { task: task.problem },
        {
          llm: ctx.llm,
          sandbox: ctx.sandbox,
          agent: createSailorAgent(context, []),
          ...(ctx.budgets ? { budgets: ctx.budgets } : {}),
          ...(ctx.compaction ? { compaction: ctx.compaction } : {}),
          ...(ctx.onEvent ? { onEvent: ctx.onEvent } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        },
      );
      return {
        usage: outcome.usage,
        steps: outcome.steps,
        reason: outcome.reason,
        summary: outcome.summary,
      };
    },
  };
}
