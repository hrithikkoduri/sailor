/** One run's story: meta chips, its task, and the full trace timeline. */
import type { RunDetail } from "@/features/trace/api";
import { TraceView } from "@/features/trace/trace-view";
import { duration, fmtTokens, fmtUsd, shortId } from "@/utils/format";

export function RunPanel({ runDetail }: { runDetail: RunDetail }) {
  const { run, trace } = runDetail;
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
        <span className="text-slate-300">run {shortId(run.id)}</span>
        {run.agent === "chat" && <span className="rounded bg-muted px-1.5 py-px">chat</span>}
        <span>{run.steps} steps</span>
        <span>
          ↑ {fmtTokens(run.tokensIn)} ↓ {fmtTokens(run.tokensOut)}
        </span>
        <span>{fmtUsd(run.usd)}</span>
        <span>{duration(run.startedAt, run.finishedAt)}</span>
        {run.keepSandbox && (
          <span className="rounded-full border border-sky-400/40 bg-sky-400/10 px-2 py-0.5 text-sky-300">sandbox kept</span>
        )}
        {run.cancelRequestedAt && run.status === "running" && (
          <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-amber-300">
            cancelling…
          </span>
        )}
      </div>
      {run.task && (
        <div className="mt-3 rounded-xl border border-border/70 bg-card/40 p-4 text-[13px] whitespace-pre-wrap text-slate-300">
          {run.task}
        </div>
      )}
      <div className="mt-4">
        <TraceView trace={trace} />
      </div>
    </>
  );
}
