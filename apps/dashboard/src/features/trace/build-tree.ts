/**
 * buildThreadTree — raw trace rows → the span tree the explorer renders.
 *
 * Hierarchy per run:  run → phase → agent step (LLM call) → tool call.
 * Guardrails/checkpoints/errors hang off the innermost open container.
 * Tool calls pair with their results by name (in order); LLM spans take
 * their duration/tokens from the matching finish event. Spans without an
 * explicit duration get an estimated one from their siblings' chronology
 * (marked `estimated`) so the waterfall bar still reads truthfully.
 */
import type { TraceRun, TraceSpan } from "@/features/trace/api";

export type SpanKind = "run" | "phase" | "llm" | "tool" | "note";
export type SpanStatus = "ok" | "fail" | "running" | "neutral";

export interface SpanNode {
  id: string;
  kind: SpanKind;
  name: string;
  badge?: string;
  status: SpanStatus;
  startMs: number;
  durationMs?: number;
  estimated?: boolean;
  tokensIn?: number;
  tokensOut?: number;
  /** Tokens are an estimate (tool results: chars/4 of what they add to context). */
  tokensEstimated?: boolean;
  detail: {
    input?: unknown;
    output?: unknown;
    metadata: Record<string, unknown>;
  };
  children: SpanNode[];
}

export interface ThreadTree {
  /** Newest run first. */
  roots: SpanNode[];
  /** Per-run wall-clock windows, keyed by run id (for the waterfall bars). */
  runWindows: Map<string, { start: number; end: number }>;
}

const at = (v: string | null | undefined): number =>
  v ? new Date(v).getTime() : Date.now();
const str = (p: Record<string, unknown>, k: string) =>
  typeof p[k] === "string" ? (p[k] as string) : undefined;
const num = (p: Record<string, unknown>, k: string) =>
  typeof p[k] === "number" ? (p[k] as number) : undefined;

const runStatus = (status: string): SpanStatus =>
  status === "succeeded"
    ? "ok"
    : status === "failed"
      ? "fail"
      : status === "running" || status === "queued"
        ? "running"
        : "neutral";

export function buildThreadTree(
  runs: TraceRun[],
  spans: TraceSpan[],
): ThreadTree {
  const byRun = new Map<string, TraceSpan[]>();
  for (const span of spans) {
    const list = byRun.get(span.runId);
    if (list) list.push(span);
    else byRun.set(span.runId, [span]);
  }

  const roots: SpanNode[] = [];
  const runWindows = new Map<string, { start: number; end: number }>();

  for (const run of runs) {
    const events = (byRun.get(run.id) ?? []).sort((a, b) => a.seq - b.seq);
    const runStart = at(run.startedAt ?? run.createdAt);
    const runEnd = run.finishedAt ? at(run.finishedAt) : Date.now();

    const root: SpanNode = {
      id: `run-${run.id}`,
      kind: "run",
      name:
        run.agent === "chat" ? `chat · ${run.trigger}` : `run · ${run.trigger}`,
      badge: run.phase ?? undefined,
      status: runStatus(run.status),
      startMs: runStart,
      durationMs: Math.max(0, runEnd - runStart),
      tokensIn: run.tokensIn,
      tokensOut: run.tokensOut,
      detail: {
        input: { task: run.task, agent: run.agent, trigger: run.trigger },
        metadata: {
          status: run.status,
          disposition: run.disposition,
          steps: run.steps,
          usd: run.usd,
          keepSandbox: run.keepSandbox,
          error: run.error,
        },
      },
      children: [],
    };

    let phase: SpanNode | null = null;
    let lastLlm: SpanNode | null = null;
    const pendingLlm: SpanNode[] = [];
    const pendingTools = new Map<string, SpanNode[]>();

    const container = () => lastLlm ?? phase ?? root;

    for (const e of events) {
      const p = e.payload;
      const start = at(e.ts);
      switch (e.type) {
        case "run_started":
          break;
        case "phase_started": {
          phase = {
            id: `s${e.id}`,
            kind: "phase",
            name: `phase · ${str(p, "phase") ?? "?"}`,
            badge: str(p, "via") ?? undefined,
            status: "neutral",
            startMs: start,
            detail: { metadata: { phase: p.phase, via: p.via } },
            children: [],
          };
          root.children.push(phase);
          lastLlm = null;
          break;
        }
        case "llm_call_started": {
          const node: SpanNode = {
            id: `s${e.id}`,
            kind: "llm",
            name: `agent · step ${num(p, "step") ?? "?"}`,
            badge: str(p, "phase") ?? undefined,
            status: "running",
            startMs: start,
            detail: { metadata: { phase: p.phase, step: p.step } },
            children: [],
          };
          (phase ?? root).children.push(node);
          lastLlm = node;
          pendingLlm.push(node);
          break;
        }
        case "llm_call_finished": {
          const node: SpanNode = pendingLlm.pop() ?? lastLlm ?? phase ?? root;
          const usage = (p.usage ?? {}) as Record<string, unknown>;
          node.durationMs = num(p, "latencyMs");
          node.tokensIn = num(usage, "promptTokens");
          node.tokensOut = num(usage, "completionTokens");
          node.status = "ok";
          const reasoning = str(p, "reasoning");
          node.detail.output = {
            text: str(p, "text") ?? "",
            ...(reasoning ? { reasoning } : {}),
            toolCalls: Array.isArray(p.toolCalls) ? p.toolCalls : [],
          };
          const reasoningTokens = num(usage, "reasoningTokens");
          if (reasoningTokens !== undefined)
            node.detail.metadata.reasoningTokens = reasoningTokens;
          const cachedTokens = num(usage, "cachedTokens");
          if (cachedTokens !== undefined && cachedTokens > 0)
            node.detail.metadata.inputCached = cachedTokens;
          if (node.kind === "llm") lastLlm = node;
          break;
        }
        case "tool_call": {
          const node: SpanNode = {
            id: `s${e.id}`,
            kind: "tool",
            name: str(p, "name") ?? "tool",
            status: "running",
            startMs: start,
            detail: {
              input: p.input,
              metadata: { phase: p.phase, step: p.step },
            },
            children: [],
          };
          container().children.push(node);
          const queue = pendingTools.get(node.name) ?? [];
          queue.push(node);
          pendingTools.set(node.name, queue);
          break;
        }
        case "tool_result": {
          const name = str(p, "name") ?? "tool";
          const queue = pendingTools.get(name) ?? [];
          const node = queue.shift();
          pendingTools.set(name, queue);
          if (node) {
            node.durationMs = num(
              (p.meta ?? {}) as Record<string, unknown>,
              "durationMs",
            );
            node.status = p.ok === true ? "ok" : "fail";
            node.detail.output = { content: str(p, "content") ?? "" };
            // What this result adds to the NEXT call's context, estimated from
            // the recorded char count (tokens belong to model calls; a tool's
            // footprint is the context it contributes). Marked `~` like
            // estimated durations.
            const resultChars =
              num(p, "contentChars") ?? str(p, "content")?.length ?? 0;
            if (resultChars > 0) {
              node.tokensIn = Math.round(resultChars / 4);
              node.tokensEstimated = true;
            }
            node.detail.metadata = {
              ...node.detail.metadata,
              ok: p.ok,
              meta: p.meta,
              ...(resultChars > 0 ? { resultChars } : {}),
            };
          }
          break;
        }
        case "advisory": {
          container().children.push({
            id: `s${e.id}`,
            kind: "note",
            name: `advisory · ${str(p, "kind") ?? ""}`.replace(/_/g, " "),
            status: "neutral",
            startMs: start,
            detail: { output: str(p, "detail"), metadata: { kind: p.kind } },
            children: [],
          });
          break;
        }
        case "guardrail": {
          container().children.push({
            id: `s${e.id}`,
            kind: "note",
            name: `guardrail · ${str(p, "kind") ?? ""}`,
            status: "fail",
            startMs: start,
            detail: { output: str(p, "detail"), metadata: { kind: p.kind } },
            children: [],
          });
          break;
        }
        case "checkpoint": {
          (phase ?? root).children.push({
            id: `s${e.id}`,
            kind: "note",
            name: `checkpoint · ${str(p, "label") ?? ""}`,
            status: "neutral",
            startMs: start,
            detail: { metadata: { ref: p.ref } },
            children: [],
          });
          break;
        }
        case "compacted": {
          (phase ?? root).children.push({
            id: `s${e.id}`,
            kind: "note",
            name: "conversation compacted",
            status: "neutral",
            startMs: start,
            detail: {
              ...(str(p, "folding") ? { input: str(p, "folding") } : {}),
              ...(str(p, "summary") ? { output: str(p, "summary") } : {}),
              metadata: {
                removed: p.removedMessages,
                kept: p.keptMessages,
                summaryChars: p.summaryChars,
              },
            },
            children: [],
          });
          break;
        }
        case "run_finished": {
          root.detail.output = {
            ok: p.ok,
            reason: p.reason,
            disposition: p.disposition,
            summary: str(p, "summary"),
          };
          root.detail.metadata = {
            ...root.detail.metadata,
            ok: p.ok,
            reason: p.reason,
          };
          break;
        }
        case "error": {
          container().children.push({
            id: `s${e.id}`,
            kind: "note",
            name: "error",
            status: "fail",
            startMs: start,
            detail: { output: str(p, "message"), metadata: {} },
            children: [],
          });
          break;
        }
        default:
          break;
      }
    }

    estimateDurations(root, runEnd);
    // Phases label progress; their token line sums the model calls inside —
    // tool estimates are context for the NEXT call (shown on the tool row),
    // so they are deliberately not added again here.
    for (const child of root.children) {
      if (child.kind !== "phase") continue;
      const summed = sumLlmTokens(child);
      if (summed.tokensIn > 0 || summed.tokensOut > 0) {
        child.tokensIn = summed.tokensIn;
        child.tokensOut = summed.tokensOut;
      }
    }
    // An unfinished run never leaves "running" children behind visually.
    if (root.status !== "running") settleRunning(root);

    roots.push(root);
    const first = events[0] ? at(events[0].ts) : runStart;
    const last = events.length > 0 ? at(events[events.length - 1]!.ts) : runEnd;
    runWindows.set(run.id, {
      start: Math.min(runStart, first),
      end: Math.max(runEnd, last),
    });
  }

  roots.reverse(); // newest story first
  return { roots, runWindows };
}

function estimateDurations(node: SpanNode, parentEnd: number): void {
  const kids = [...node.children].sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i]!;
    if (child.durationMs === undefined) {
      const end = kids[i + 1] ? kids[i + 1]!.startMs : parentEnd;
      child.durationMs = Math.max(0, end - child.startMs);
      child.estimated = true;
    }
    estimateDurations(child, child.startMs + (child.durationMs ?? 0));
  }
  if (node.durationMs === undefined) {
    node.durationMs = Math.max(0, parentEnd - node.startMs);
    node.estimated = true;
  }
}

function settleRunning(node: SpanNode): void {
  for (const child of node.children) {
    if (child.status === "running") child.status = "neutral";
    settleRunning(child);
  }
}

/** Model-call token totals under a node (tool estimates excluded — they are
 * already part of the following call's input). */
function sumLlmTokens(node: SpanNode): { tokensIn: number; tokensOut: number } {
  let tokensIn = node.kind === "llm" ? (node.tokensIn ?? 0) : 0;
  let tokensOut = node.kind === "llm" ? (node.tokensOut ?? 0) : 0;
  for (const child of node.children) {
    const sub = sumLlmTokens(child);
    tokensIn += sub.tokensIn;
    tokensOut += sub.tokensOut;
  }
  return { tokensIn, tokensOut };
}
