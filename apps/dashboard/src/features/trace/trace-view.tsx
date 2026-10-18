/**
 * TraceView — the run's story, rendered from `trace_events`.
 *
 * Every AgentEvent the engine emitted, in sequence: phases, LLM turns, tool
 * calls and their outputs, guardrails, checkpoints, and the finish.
 */
import { useState, type ReactNode } from "react";
import type { TraceRow } from "@/features/trace/api";
import { fmtTokens } from "@/utils/format";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

function Collapse({ preview, children }: { preview?: string; children: ReactNode }) {
  return (
    <details className="group">
      <summary className="cursor-pointer list-none text-xs text-muted-foreground transition hover:text-slate-300">
        {preview ? <span className="mr-2">{preview}</span> : null}
        <span className="underline decoration-dotted">show</span>
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

function Json({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, 2) ?? "null";
  return (
    <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-[#0b1322] p-3 font-mono text-xs leading-relaxed text-slate-300">
      {text}
    </pre>
  );
}

function Text({ text }: { text: string }) {
  const long = text.length > 400;
  const [open, setOpen] = useState(!long);
  const shown = open ? text : `${text.slice(0, 400)}…`;
  return (
    <div className="text-sm leading-relaxed whitespace-pre-wrap text-slate-200">
      {shown}
      {long && (
        <button onClick={() => setOpen((v) => !v)} className="ml-2 text-xs text-muted-foreground underline decoration-dotted hover:text-slate-300">
          {open ? "less" : "more"}
        </button>
      )}
    </div>
  );
}

const viaLabel: Record<string, string> = {
  advance: "checked",
  advance_unverified: "trusted",
  advance_forced: "forced",
};

function Row({ row }: { row: TraceRow }) {
  const p = row.payload as Record<string, unknown>;
  switch (row.type) {
    case "run_started": {
      const phases = Array.isArray(p.phases) ? (p.phases as unknown[]).map(String) : [];
      return (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
          <div className="text-xs font-semibold tracking-wide text-primary uppercase">Run started</div>
          <div className="mt-1.5 text-sm whitespace-pre-wrap text-slate-200">{str(p.task) ?? ""}</div>
          {phases.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {phases.map((phase) => (
                <span key={phase} className="rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {phase}
                </span>
              ))}
            </div>
          )}
        </div>
      );
    }

    case "phase_started": {
      const via = str(p.via);
      return (
        <div className="mt-5 flex items-center gap-3">
          <span className="text-[11px] font-semibold tracking-widest text-slate-300 uppercase">{str(p.phase)}</span>
          {via && (
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] ${
                via === "advance_forced"
                  ? "border-amber-400/40 bg-amber-500/10 text-amber-200"
                  : "border-border bg-muted/40 text-muted-foreground"
              }`}
            >
              {viaLabel[via] ?? via}
            </span>
          )}
          <div className="h-px flex-1 bg-muted" />
        </div>
      );
    }

    case "llm_call_started":
      return (
        <div className="py-0.5 text-xs text-muted-foreground">
          thinking · step {num(p.step) ?? "?"} <span className="animate-pulse">▍</span>
        </div>
      );

    case "llm_text_delta":
      return null; // token deltas are chat material, not trace material

    case "llm_call_finished": {
      const usage = (p.usage ?? {}) as Record<string, unknown>;
      const toolCalls = Array.isArray(p.toolCalls) ? (p.toolCalls as Array<Record<string, unknown>>) : [];
      const text = str(p.text) ?? "";
      return (
        <div className="rounded-xl border border-border bg-card/40 p-4">
          {text.trim().length > 0 && <Text text={text} />}
          {toolCalls.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {toolCalls.map((call, i) => (
                <div key={i} className="rounded-lg border border-border bg-black/30 px-3 py-2">
                  <span className="font-mono text-xs text-primary">{str(call.name) ?? "tool"}</span>
                  <div className="mt-1">
                    <Json value={call.arguments ?? call.input ?? {}} />
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
            <span>↑ {fmtTokens(num(usage.promptTokens) ?? 0)} in</span>
            <span>↓ {fmtTokens(num(usage.completionTokens) ?? 0)} out</span>
            {num(p.latencyMs) !== undefined && <span>{(num(p.latencyMs)! / 1000).toFixed(1)}s</span>}
          </div>
        </div>
      );
    }

    case "tool_call":
      return (
        <div className="rounded-xl border border-border bg-card/40 p-4">
          <div className="font-mono text-xs text-primary">{str(p.name) ?? "tool"}</div>
          <div className="mt-2">
            <Json value={p.input ?? {}} />
          </div>
        </div>
      );

    case "tool_result": {
      const ok = p.ok === true;
      const content = str(p.content) ?? "";
      return (
        <div
          className={`rounded-xl border p-4 ${
            ok ? "border-emerald-400/20 bg-emerald-500/[0.05]" : "border-red-400/25 bg-red-500/[0.06]"
          }`}
        >
          <div className="flex items-center gap-2 text-xs">
            <span className={ok ? "text-emerald-300" : "text-red-300"}>{ok ? "✓" : "✗"}</span>
            <span className="font-mono text-slate-300">{str(p.name) ?? "tool"}</span>
            <span className="text-muted-foreground/70">{content.length} chars</span>
          </div>
          <div className="mt-1.5">
            {content.length > 320 ? (
              <Collapse preview={content.slice(0, 160).replace(/\n/g, " ⏎ ")}>
                <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-[#0b1322] p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-slate-300">
                  {content}
                </pre>
              </Collapse>
            ) : (
              <pre className="overflow-auto rounded-lg border border-border bg-[#0b1322] p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-slate-300">
                {content}
              </pre>
            )}
          </div>
        </div>
      );
    }

    case "guardrail":
      return (
        <div className="rounded-xl border border-amber-400/30 bg-amber-500/[0.08] p-4 text-sm text-amber-200">
          <span className="font-mono text-xs">{str(p.kind) ?? "guardrail"}</span>
          <div className="mt-1 text-amber-100/90">{str(p.detail) ?? ""}</div>
        </div>
      );

    case "checkpoint":
      return (
        <div className="py-0.5 text-xs text-muted-foreground">
          ◆ checkpoint · {str(p.label) ?? ""} · <span className="font-mono">{(str(p.ref) ?? "").slice(0, 10)}</span>
        </div>
      );

    case "compacted":
      return (
        <div className="py-0.5 text-xs text-violet-300/80">
          conversation compacted — removed {num(p.removedMessages) ?? "?"}, kept {num(p.keptMessages) ?? "?"}
        </div>
      );

    case "run_finished": {
      const ok = p.ok === true;
      const usage = (p.usage ?? {}) as Record<string, unknown>;
      const disposition = str(p.disposition);
      return (
        <div
          className={`mt-4 rounded-xl border p-4 ${
            ok ? "border-emerald-400/30 bg-emerald-500/[0.07]" : "border-red-400/30 bg-red-500/[0.07]"
          }`}
        >
          <div className={`text-xs font-semibold tracking-wide uppercase ${ok ? "text-emerald-200" : "text-red-200"}`}>
            {ok ? "Finished" : "Stopped"} · {str(p.reason) ?? ""}
            {disposition ? ` · ${disposition}` : ""}
          </div>
          {str(p.summary) && <div className="mt-2 text-sm whitespace-pre-wrap text-slate-200">{str(p.summary)}</div>}
          <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
            <span>{num(p.steps) ?? "?"} steps</span>
            <span>↑ {fmtTokens(num(usage.promptTokens) ?? 0)}</span>
            <span>↓ {fmtTokens(num(usage.completionTokens) ?? 0)}</span>
            {num(usage.costUsd) !== undefined && <span>${num(usage.costUsd)!.toFixed(4)}</span>}
          </div>
        </div>
      );
    }

    case "error":
      return (
        <div className="rounded-xl border border-red-400/30 bg-red-500/[0.08] p-4 text-sm text-red-200">
          {str(p.message) ?? "error"}
        </div>
      );

    default:
      return (
        <div className="rounded-xl border border-border bg-white/[0.02] p-3">
          <span className="font-mono text-xs text-muted-foreground">{row.type}</span>
          <div className="mt-1.5">
            <Collapse>
              <Json value={row.payload} />
            </Collapse>
          </div>
        </div>
      );
  }
}

export function TraceView({ trace }: { trace: TraceRow[] }) {
  if (trace.length === 0) {
    return <p className="text-sm text-muted-foreground">No trace events recorded yet.</p>;
  }
  return (
    <div className="space-y-2">
      {trace.map((row) => (
        <Row key={row.id} row={row} />
      ))}
    </div>
  );
}
