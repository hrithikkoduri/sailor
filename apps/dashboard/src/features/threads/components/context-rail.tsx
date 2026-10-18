/** The thread detail's right rail: context, active-run actions, runs, pending. */
import { OctagonX, Wrench } from "lucide-react";
import type { PendingEvent, ThreadDetail } from "@/features/threads/api";
import { PendingEvents } from "@/features/threads/components/pending-events";
import { RunsList } from "@/features/threads/components/runs-list";
import { StatusPill } from "@/elements/status-pill";
import { fmtUsd, shortId, timeAgo } from "@/utils/format";
import { cn } from "@/utils/cn";

function RailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("truncate text-right text-slate-300", mono && "font-mono text-[11px]")}>{value}</dd>
    </div>
  );
}

export function ContextRail({
  detail,
  selectedRunId,
  busy,
  onSelectRun,
  onCancel,
  onKeep,
  onInterject,
}: {
  detail: ThreadDetail;
  selectedRunId: string | null;
  busy: string | null;
  onSelectRun: (runId: string) => void;
  onCancel: (runId: string) => void;
  onKeep: (runId: string) => void;
  onInterject: (event: PendingEvent) => void;
}) {
  const { thread, runs, pendingEvents } = detail;
  const activeRun = runs.find((r) => r.status === "running" || r.status === "queued");

  return (
    <aside className="hidden w-[320px] shrink-0 overflow-y-auto border-l border-border/60 xl:block">
      <div className="space-y-6 p-5">
        <section>
          <h3 className="font-mono text-[10.5px] tracking-widest text-muted-foreground uppercase">Context</h3>
          <dl className="mt-3 space-y-2 text-xs">
            <RailRow label="Phase" value={thread.phase ?? "—"} mono />
            <RailRow label="Turns" value={`${thread.turnsUsed} / ${thread.budgetMaxTurns}`} />
            <RailRow label="Spend" value={`${fmtUsd(thread.usdSpent)} of ${fmtUsd(thread.budgetMaxUsd)}`} />
            {thread.checkpointSha && <RailRow label="Checkpoint" value={shortId(thread.checkpointSha, 10)} mono />}
            {thread.installationAccount && <RailRow label="Installed by" value={thread.installationAccount} />}
            <RailRow label="Updated" value={timeAgo(thread.updatedAt)} />
          </dl>
        </section>

        {activeRun && (
          <section className="rounded-xl border border-primary/25 bg-primary/5 p-4">
            <div className="flex items-center gap-2">
              <StatusPill status={activeRun.status} />
              <span className="font-mono text-[11px] text-muted-foreground">{shortId(activeRun.id)}</span>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => onKeep(activeRun.id)}
                disabled={busy !== null}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-slate-300 transition-colors hover:bg-accent disabled:opacity-50"
              >
                <Wrench className="size-3.5" /> Keep sandbox
              </button>
              <button
                onClick={() => onCancel(activeRun.id)}
                disabled={busy !== null}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-amber-400/40 bg-amber-400/10 px-2.5 py-1.5 text-xs text-amber-300 transition-colors hover:bg-amber-400/20 disabled:opacity-50"
              >
                <OctagonX className="size-3.5" /> Cancel
              </button>
            </div>
          </section>
        )}

        <RunsList runs={runs} selectedRunId={selectedRunId} onSelect={onSelectRun} />
        <PendingEvents events={pendingEvents} busyKey={busy} onInterject={onInterject} />
      </div>
    </aside>
  );
}
