/**
 * Shared API contracts.
 *
 * One definition per shape, imported by the server (to validate/construct) and
 * by the dashboard (to type its client). A shape change is a compile error on
 * both sides, instead of a silent runtime mismatch.
 *
 * Keep this file data-only: no imports from apps, no framework types.
 */
import { z } from "zod";

// --- enums -------------------------------------------------------------------

export const threadSource = z.enum(["github", "manual", "workspace", "local"]);
export type ThreadSource = z.infer<typeof threadSource>;
export const runStatus = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "budget_exhausted",
  "interrupted",
  "paused",
]);
export type RunStatus = z.infer<typeof runStatus>;
export const threadState = z.enum([
  "queued",
  "running",
  "pr_open",
  "waiting_ci",
  "addressing_comments",
  "merged",
  "closed",
  "abandoned",
]);
export type ThreadState = z.infer<typeof threadState>;

// --- threads -----------------------------------------------------------------

export const runSummary = z.object({
  id: z.string(),
  status: runStatus.or(z.string()),
  agent: z.string().nullable().optional(),
  disposition: z.string().nullable().optional(),
  phase: z.string().nullable().optional(),
  task: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type RunSummary = z.infer<typeof runSummary>;

export const threadListItem = z.object({
  id: z.string(),
  title: z.string().nullable(),
  source: threadSource.or(z.string()),
  repo: z.string(),
  issueNumber: z.number(),
  prNumber: z.number().nullable().optional(),
  prUrl: z.string().nullable().optional(),
  issueUrl: z.string().nullable().optional(),
  state: threadState.or(z.string()),
  updatedAt: z.string(),
  latestRun: runSummary.nullable().optional(),
  pendingEvents: z.number(),
});
export type ThreadListItem = z.infer<typeof threadListItem>;

export const threadList = z.object({ threads: z.array(threadListItem) });

/** The composer creates a thread from a message and an optional repository. */
export const threadCreate = z.object({
  text: z.string().trim().min(1).max(8000),
  repo: z.string().trim().min(1).max(200).optional(),
});
export type ThreadCreate = z.infer<typeof threadCreate>;

export const threadRename = z.object({
  title: z.string().trim().min(1).max(160),
});

// --- questions ---------------------------------------------------------------

export const questionType = z.enum(["text", "single_select", "multi_select", "repository"]);
export const questionOption = z.object({ value: z.string(), label: z.string() });

export const question = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  type: questionType,
  options: z.array(questionOption).optional(),
  required: z.boolean(),
  recommended: z.string().optional(),
});
export type Question = z.infer<typeof question>;

export const questionRequest = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  questions: z.array(question),
  answers: z.record(z.union([z.string(), z.array(z.string())])).nullable(),
  createdAt: z.string(),
});
export type QuestionRequest = z.infer<typeof questionRequest>;

/** Answers accept a free-text "something else" value for choice questions. */
export const questionAnswers = z.object({
  answers: z.record(z.union([z.string(), z.array(z.string())])),
});

// --- secrets -----------------------------------------------------------------

export const secretName = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]{0,39}$/, "Use a short lowercase name like daytona");
export const secretEnvVar = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/, "Use an environment variable name like DAYTONA_API_KEY");

export const secretCreate = z.object({
  name: secretName,
  envVar: secretEnvVar,
  value: z.string().min(1).max(8192),
});
export type SecretCreate = z.infer<typeof secretCreate>;

export const secretMetadata = z.object({
  id: z.string(),
  name: z.string(),
  envVar: z.string(),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]),
  lastUsedAt: z.union([z.string(), z.date()]).nullable(),
});
export type SecretMetadata = z.infer<typeof secretMetadata>;

// --- traces ------------------------------------------------------------------

export const traceRow = z.object({
  id: z.string(),
  threadId: z.string(),
  title: z.string().nullable(),
  repo: z.string(),
  task: z.string().nullable(),
  status: runStatus.or(z.string()),
  steps: z.number().nullable(),
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
  usd: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type TraceRow = z.infer<typeof traceRow>;
