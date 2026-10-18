/**
 * The generic eval runner — tasks in, arms run, patches out.
 *
 * Deliberately knows nothing about SWE-bench, Docker, or Sailor: it walks a
 * task list, gives each task a fresh sandbox from the provider, hands the
 * sandbox to an arm, extracts the final diff, and reports. That is the whole
 * contract — the future Anchor lift (`anchor eval`) is this module, once its
 * shape has survived real runs.
 *
 * Failure is data, not an exception: a task that throws yields a result with
 * `status: "failed"` (and a best-effort patch — partial work is still worth
 * recording). The suite always finishes.
 */
import type {
  AgentEvent,
  BudgetLimits,
  CompactionConfig,
  LLMClient,
  LLMUsage,
  Sandbox,
  SandboxProvider,
} from "@anchor/core";
import type { EvalTask } from "./tasks.js";

export interface ArmOutcome {
  usage?: LLMUsage;
  steps?: number;
  reason?: string;
  summary?: string;
}

export interface EvalArmContext {
  sandbox: Sandbox;
  llm: LLMClient;
  budgets?: Partial<BudgetLimits>;
  compaction?: CompactionConfig;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

/** A system under test. It works inside the sandbox; the runner extracts the diff. */
export interface EvalArm {
  name: string;
  run(task: EvalTask, ctx: EvalArmContext): Promise<ArmOutcome | void>;
}

export interface EvalTaskResult {
  taskId: string;
  arm: string;
  status: "completed" | "failed";
  /** The task's final diff — the graded artifact (empty string when nothing changed). */
  patch: string;
  error?: string;
  usage?: LLMUsage;
  steps?: number;
  reason?: string;
  wallMs: number;
}

export interface EvalRunOptions {
  tasks: EvalTask[];
  arm: EvalArm;
  provider: SandboxProvider;
  llm: LLMClient;
  budgets?: Partial<BudgetLimits>;
  compaction?: CompactionConfig;
  signal?: AbortSignal;
  /** Called as each task finishes — where predictions and traces get written. */
  onResult?: (result: EvalTaskResult) => Promise<void> | void;
  /** Every engine event of every task, tagged with its task. */
  onEvent?: (task: EvalTask, event: AgentEvent) => void;
  log?: (line: string) => void;
}

/**
 * The workspace's final diff, staged first so untracked files are included
 * and committed work still counts (`--cached <base>` covers all of it).
 */
async function extractPatch(
  sandbox: Sandbox,
  baseRef: string,
): Promise<string> {
  const diff = await sandbox.exec(
    `git add -A && git diff --cached --binary ${baseRef}`,
    { timeoutSecs: 120 },
  );
  if (diff.exitCode === 0) return diff.stdout;
  // A shallow or unusual clone may lack the base commit in its object store.
  const fallback = await sandbox.exec(
    `git add -A && git diff --cached --binary`,
    { timeoutSecs: 120 },
  );
  return fallback.stdout;
}

export async function runEvalSuite(
  options: EvalRunOptions,
): Promise<EvalTaskResult[]> {
  const results: EvalTaskResult[] = [];
  for (const task of options.tasks) {
    const started = Date.now();
    options.log?.(`→ ${task.id}`);
    const sandbox = options.provider.create(
      task.image
        ? {
            image: task.image,
            ...(task.workspacePath
              ? { workspacePath: task.workspacePath }
              : {}),
            gitIdentity: { name: "anchor-eval", email: "eval@anchor.local" },
          }
        : {
            repoUrl: task.repoUrl,
            ref: task.baseRef,
            gitIdentity: { name: "anchor-eval", email: "eval@anchor.local" },
          },
    );

    let result: EvalTaskResult;
    try {
      await sandbox.start();
      const outcome =
        (await options.arm.run(task, {
          sandbox,
          llm: options.llm,
          ...(options.budgets ? { budgets: options.budgets } : {}),
          ...(options.compaction ? { compaction: options.compaction } : {}),
          ...(options.onEvent
            ? { onEvent: (event: AgentEvent) => options.onEvent?.(task, event) }
            : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        })) ?? {};
      result = {
        taskId: task.id,
        arm: options.arm.name,
        status: "completed",
        patch: await extractPatch(sandbox, task.baseRef),
        ...(outcome.usage ? { usage: outcome.usage } : {}),
        ...(outcome.steps !== undefined ? { steps: outcome.steps } : {}),
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        wallMs: Date.now() - started,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const patch = await extractPatch(sandbox, task.baseRef).catch(() => "");
      result = {
        taskId: task.id,
        arm: options.arm.name,
        status: "failed",
        patch,
        error: message,
        wallMs: Date.now() - started,
      };
    } finally {
      await sandbox.destroy().catch(() => {});
    }

    results.push(result);
    await options.onResult?.(result);
  }
  return results;
}
