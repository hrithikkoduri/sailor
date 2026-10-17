/**
 * Database schema — Drizzle (TypeScript-first).
 *
 * This file IS the schema. `npm run db:generate` diffs it against the last
 * generated snapshot and writes a plain-SQL migration into /drizzle. The SQL
 * stays in the repo, so migrations are still reviewable — but nobody hand-writes
 * DDL, and every query gets typed rows from these definitions.
 *
 * The five tables the whole system runs on:
 *   threads            one conversation per GitHub issue (lives across turns)
 *   runs               one agent-loop invocation (a "turn") on a thread
 *   events             the thread's inbox: normalized GitHub events awaiting processing
 *   webhook_deliveries dedup ledger — GitHub delivers at-least-once, we store
 *                      each delivery GUID exactly once
 *   trace_events       every step of every run (structured; mirrored to JSONL)
 *
 * Budgets live as columns on threads/runs rather than a separate table: a
 * budget is meaningless detached from the thing it caps.
 */
import { bigint, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// uuid primary key with a random default — every table uses one
const uuidPk = () => uuid("id").primaryKey().defaultRandom();

export const threads = pgTable(
  "threads",
  {
    id: uuidPk(),
    repo: text("repo").notNull(), // "owner/name"
    issueNumber: integer("issue_number").notNull(),
    // lifecycle: queued | running | pr_open | waiting_ci | fixing |
    //            addressing_comments | merged | closed | abandoned
    state: text("state").notNull().default("queued"),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    headRef: text("head_ref"), // the PR branch ("harness/issue-123")
    baseRef: text("base_ref").notNull().default("main"), // we never push to baseRef
    /** Where the thread came from: "github" (webhook) or "local" (CLI/dev). */
    source: text("source").notNull().default("local"),
    checkpointSha: text("checkpoint_sha"), // resume/fork point (git commit in the VM)
    summary: text("summary"), // running summary of the work (context compaction)
    /** Verbatim recent conversation — the ThreadStore's storage (decision #17). */
    messages: jsonb("messages").notNull().default(sql`'[]'::jsonb`),
    /** Standing watch intent from a finish(disposition: "watch") — the babysitter reads it (step 13). */
    watch: jsonb("watch"),
    /** The phase the thread is currently in — resume starts here. */
    phase: text("phase"),
    budgetMaxTurns: integer("budget_max_turns").notNull().default(20),
    budgetMaxUsd: numeric("budget_max_usd", { precision: 10, scale: 4 }).notNull().default("10.0"),
    turnsUsed: integer("turns_used").notNull().default(0),
    usdSpent: numeric("usd_spent", { precision: 10, scale: 4 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("threads_repo_issue_unique").on(t.repo, t.issueNumber)], // business dedup: one thread per issue
);

export const runs = pgTable(
  "runs",
  {
    id: uuidPk(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    // queued | running | succeeded | failed | cancelled | budget_exhausted | interrupted | paused
    status: text("status").notNull().default("queued"),
    trigger: text("trigger").notNull(), // label | manual | babysit_ci | babysit_comment | review | resume
    /** The instruction this run works on (from the issue, or a follow-up comment). */
    task: text("task"),
    /** Where the run starts (e.g. "fix" for a resumed interjection). Null = thread position / first phase. */
    startPhase: text("start_phase"),
    phase: text("phase"), // reproduce | fix | verify (where it currently is)
    /** How the run concluded when it declared one via finish(): done | watch | blocked. */
    disposition: text("disposition"),
    error: text("error"),
    steps: integer("steps").notNull().default(0),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    usd: numeric("usd", { precision: 10, scale: 4 }).notNull().default("0"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    /** Lease: the worker stamps this while alive; a stale stamp means it died (sweep recovers). */
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    /** Durable cancel request — settable from ANY process; the worker's watcher aborts. */
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("runs_thread_idx").on(t.threadId, t.createdAt),
    index("runs_active_idx")
      .on(t.status)
      .where(sql`status in ('queued','running')`),
    // One-turn-at-a-time, enforced by the database: at most ONE active run per
    // thread. wakeThread() relies on this — a second insert fails and is
    // treated as "the event waits in the inbox".
    uniqueIndex("runs_one_active_per_thread")
      .on(t.threadId)
      .where(sql`status in ('queued','running')`),
  ],
);

export const webhookDeliveries = pgTable("webhook_deliveries", {
  deliveryId: text("delivery_id").primaryKey(), // X-GitHub-Delivery (unique per delivery)
  eventKind: text("event_kind").notNull(), // X-GitHub-Event
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

export const events = pgTable(
  "events",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    threadId: uuid("thread_id").references(() => threads.id, { onDelete: "set null" }),
    // Webhook deliveries carry a GUID; internal events (chat, sweeper) don't.
    deliveryId: text("delivery_id").references(() => webhookDeliveries.deliveryId, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // issue_labeled | issue_comment | pr_review | check_run | ...
    payload: jsonb("payload").notNull(),
    // pending | consumed | skipped — coalescing picks up all pending at once
    status: text("status").notNull().default("pending"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [index("events_inbox_idx").on(t.threadId, t.status, t.receivedAt)],
);

export const traceEvents = pgTable(
  "trace_events",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(), // order within the run
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    type: text("type").notNull(), // llm_call | tool_call | tool_result | phase | budget | error | ...
    payload: jsonb("payload").notNull(),
  },
  (t) => [unique("trace_events_run_seq_unique").on(t.runId, t.seq), index("trace_events_run_idx").on(t.runId, t.seq)],
);

// --- row types (inferred from the table definitions above) -------------------
export type Thread = typeof threads.$inferSelect;
export type NewThread = typeof threads.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type TraceEvent = typeof traceEvents.$inferSelect;
export type NewTraceEvent = typeof traceEvents.$inferInsert;
