/** Small display primitives shared by the dashboard views. */

const THREAD_TONES: Record<string, string> = {
  queued: "border-white/15 bg-white/[0.05] text-zinc-300",
  running: "border-indigo-400/50 bg-indigo-500/15 text-indigo-200",
  pr_open: "border-emerald-400/50 bg-emerald-500/15 text-emerald-200",
  waiting_ci: "border-sky-400/50 bg-sky-500/15 text-sky-200",
  fixing: "border-amber-400/50 bg-amber-500/15 text-amber-200",
  addressing_comments: "border-violet-400/50 bg-violet-500/15 text-violet-200",
  merged: "border-purple-400/50 bg-purple-500/15 text-purple-200",
  closed: "border-white/10 bg-white/[0.03] text-zinc-500",
  abandoned: "border-red-400/40 bg-red-500/10 text-red-300",
};

const RUN_TONES: Record<string, string> = {
  queued: "border-white/15 bg-white/[0.05] text-zinc-300",
  running: "border-indigo-400/50 bg-indigo-500/15 text-indigo-200",
  succeeded: "border-emerald-400/50 bg-emerald-500/15 text-emerald-200",
  failed: "border-red-400/40 bg-red-500/10 text-red-300",
  cancelled: "border-amber-400/50 bg-amber-500/15 text-amber-200",
  interrupted: "border-orange-400/50 bg-orange-500/15 text-orange-200",
  budget_exhausted: "border-orange-400/50 bg-orange-500/15 text-orange-200",
  paused: "border-sky-400/50 bg-sky-500/15 text-sky-200",
};

export function Pill({
  label,
  tones,
  pulse,
}: {
  label: string;
  tones: Record<string, string>;
  pulse?: boolean;
}) {
  const tone = tones[label] ?? "border-white/15 bg-white/[0.05] text-zinc-300";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${tone}`}
    >
      {pulse && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {label.replace(/_/g, " ")}
    </span>
  );
}

export const StatePill = ({ state }: { state: string }) => (
  <Pill label={state} tones={THREAD_TONES} pulse={state === "running"} />
);

export const RunStatusPill = ({ status }: { status: string }) => (
  <Pill label={status} tones={RUN_TONES} pulse={status === "running"} />
);

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.max(1, seconds)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function duration(startIso: string | null, endIso: string | null): string {
  if (!startIso) return "—";
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((end - new Date(startIso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export const fmtUsd = (value: string | number) => `$${Number(value).toFixed(4)}`;
