/**
 * The `anchor` arm — the framework's own coding agent, composed from
 * `@anchor/core` primitives and nothing else.
 *
 * This is the system under test: codingAgent's strategy and tools (the same
 * plan → act → verify loop Sailor runs on threads), with the benchmark
 * context — repository, workspace, base commit, deliverable — added HERE, in
 * the app. No product code is imported; `apps/evals` stays a pure second
 * consumer of the package.
 */
import { codingAgent, runAgent, type Agent } from "@anchor/core";
import type { EvalArm, EvalArmContext } from "../runner.js";
import type { EvalTask } from "../tasks.js";

export function anchorArm(): EvalArm {
  return {
    name: "anchor",
    async run(task: EvalTask, ctx: EvalArmContext) {
      const context = JSON.stringify(
        {
          repository: task.repoUrl,
          workspace: ctx.sandbox.workspace,
          baseCommit: task.baseRef,
          note: [
            "A benchmark task: make the requested change in this repository; the workspace diff is the deliverable (no remote, no publication).",
            "The environment is ALREADY provisioned: the project's dependencies live in a ready Python environment — try /opt/miniconda3/envs/testbed/bin/python first (bare python/pip may not see them). Do NOT reinstall the project.",
            "The project's own tests are the source of truth. Find and run the tests that cover the reported behavior before and after your change — and run the relevant test FILES, not only your own repro: breaking neighboring behavior counts against you.",
            "When the report shows an exact expected output or format, reproduce it verbatim in your repro and compare against it.",
            "Re-read the report before finishing and cover EVERY requirement it names — including 'this was already added for X and should also apply to Y' style twins. Do not finish while any relevant test fails.",
          ].join(" "),
        },
        null,
        2,
      );
      const basePrompt = codingAgent.strategy.systemPrompt;
      const agent: Agent = {
        ...codingAgent,
        name: "anchor",
        strategy: {
          ...codingAgent.strategy,
          systemPrompt: (args) => {
            if (!basePrompt) {
              throw new Error("codingAgent strategy lost its systemPrompt");
            }
            return basePrompt({
              task: args.task,
              context: [context, args.context].filter(Boolean).join("\n\n"),
              ...(args.summary ? { summary: args.summary } : {}),
            });
          },
        },
      };
      const outcome = await runAgent(
        { task: task.problem },
        {
          llm: ctx.llm,
          sandbox: ctx.sandbox,
          agent,
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
