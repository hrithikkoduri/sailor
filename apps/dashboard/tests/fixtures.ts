import type { Page } from "@playwright/test";

// UI-only fixtures: never connect to GitHub, Redis, or a real agent worker.
const startedAt = new Date(Date.now() - 180_000).toISOString();
const finishedAt = new Date(Date.now() - 120_000).toISOString();
export const user = {
  id: "user-1",
  name: "Alex Morgan",
  login: "alex",
  email: "alex@example.com",
  avatarUrl: null,
};
export const thread = {
  id: "thread-1",
  repo: "acme/worker-service",
  issueNumber: 42,
  state: "pr_open",
  source: "github",
  prNumber: 48,
  prUrl: "https://github.com/acme/worker-service/pull/48",
  headRef: "harness/issue-42",
  baseRef: "main",
  phase: "verify",
  summary: null,
  turnsUsed: 2,
  budgetMaxTurns: 20,
  usdSpent: "0.0342",
  budgetMaxUsd: "10",
  checkpointSha: "abc1234567890",
  watch: null,
  createdAt: startedAt,
  updatedAt: finishedAt,
};
const run = {
  id: "run-1",
  status: "succeeded",
  trigger: "label",
  agent: "coding",
  phase: "verify",
  disposition: "done",
  error: null,
  task: "Fix GitHub issue #42: Handle empty batches gracefully",
  startedAt,
  finishedAt,
  createdAt: startedAt,
};
export const detail = {
  thread: {
    ...thread,
    installationAccount: "acme",
    issueUrl: "https://github.com/acme/worker-service/issues/42",
  },
  runs: [
    {
      ...run,
      agentText:
        "I fixed the empty-batch error and opened **PR #48**.\n\nThe worker now returns early when there are no jobs to process, instead of attempting to read the first item.\n\n- Added a guard in `processBatch()`\n- Covered empty input and a single-job batch\n- All **24 tests pass**\n\nThe change is ready for your review.",
    },
  ],
  events: [
    {
      id: "1",
      kind: "issue_labeled",
      payload: { title: "Handle empty batches gracefully", number: 42 },
      status: "consumed",
      receivedAt: startedAt,
      consumedAt: startedAt,
    },
    {
      id: "2",
      kind: "chat_message",
      payload: {
        author: "Alex",
        body: "Can you walk me through what changed?",
      },
      status: "consumed",
      receivedAt: new Date(Date.now() - 60_000).toISOString(),
      consumedAt: finishedAt,
    },
  ],
  pendingEvents: [],
};
export const gate = {
  user,
  githubAppConfigured: true,
  installations: [
    {
      installationId: 1,
      accountLogin: "acme",
      suspended: false,
      repos: [
        {
          fullName: "acme/worker-service",
          defaultBranch: "main",
          enabled: true,
        },
        {
          fullName: "acme/design-system",
          defaultBranch: "main",
          enabled: false,
        },
        {
          fullName: "acme/api-gateway",
          defaultBranch: "develop",
          enabled: false,
        },
      ],
    },
  ],
};
const event = (id: number, type: string, payload: Record<string, unknown>) => ({
  id: String(id),
  runId: run.id,
  seq: id,
  type,
  payload: { type, ...payload },
  ts: new Date(new Date(startedAt).getTime() + id * 1200).toISOString(),
});
export const trace = {
  thread,
  totals: {
    runs: 1,
    codingRuns: 1,
    chatRuns: 0,
    tokensIn: 14280,
    tokensOut: 1832,
    usd: "0.0342",
    startedAt,
    finishedAt,
  },
  runs: [
    {
      ...run,
      steps: 4,
      tokensIn: 14280,
      tokensOut: 1832,
      usd: "0.0342",
      keepSandbox: false,
    },
  ],
  spans: [
    event(0, "run_started", { task: run.task }),
    event(1, "phase_started", { phase: "reproduce" }),
    event(2, "llm_call_started", { phase: "reproduce", step: 1 }),
    event(3, "llm_call_finished", {
      phase: "reproduce",
      step: 1,
      text: "The empty array is read before we validate its length. I’ll add a regression test first.",
      toolCalls: [],
      latencyMs: 1240,
      usage: { promptTokens: 3280, completionTokens: 220 },
    }),
    event(4, "tool_call", {
      phase: "reproduce",
      step: 1,
      name: "run_tests",
      input: { command: "npm test" },
    }),
    event(5, "tool_result", {
      name: "run_tests",
      ok: true,
      content: "24 tests passed",
      meta: { durationMs: 480 },
    }),
    event(6, "phase_started", { phase: "verify" }),
    event(7, "llm_call_started", { phase: "verify", step: 2 }),
    event(8, "llm_call_finished", {
      phase: "verify",
      step: 2,
      text: "The fix is verified. All 24 tests pass.",
      latencyMs: 820,
      usage: { promptTokens: 1120, completionTokens: 96 },
    }),
    event(9, "run_finished", {
      ok: true,
      reason: "finished",
      summary: "Added an empty-batch guard and regression tests.",
    }),
  ],
};

export async function mockWorkspace(
  page: Page,
  options: { active?: boolean; failSend?: boolean } = {},
) {
  let requests = 0;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/auth/me", (route) => route.fulfill({ json: { user } }));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/stream"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: "event: hello\ndata: {}\n\n",
      });
    if (url.pathname.endsWith("/messages")) {
      if (options.failSend && requests++ === 0)
        return route.fulfill({
          status: 503,
          json: { error: "Could not send. Please retry." },
        });
      return route.fulfill({
        json: { ok: true, eventId: "3", interjected: false, runId: "run-1" },
      });
    }
    if (url.pathname.endsWith("/interject"))
      return route.fulfill({ json: { ok: true, action: "interjected" } });
    if (url.pathname === "/api/onboarding/repos")
      return route.fulfill({ json: { ok: true, enabled: 0 } });
    if (url.pathname === "/api/onboarding")
      return route.fulfill({ json: gate });
    if (url.pathname === "/api/threads")
      return route.fulfill({
        json: { threads: [{ ...thread, pendingEvents: 0, latestRun: run }] },
      });
    if (url.pathname.endsWith("/trace")) return route.fulfill({ json: trace });
    return route.fulfill({
      json: options.active
        ? {
            ...detail,
            runs: [{ ...detail.runs[0], status: "running", agentText: null }],
          }
        : detail,
    });
  });
  return errors;
}

/** Manual EventSource lets tests hold each stream stage before sending the next. */
export async function manualStream(page: Page) {
  await page.addInitScript(() => {
    class Stream extends EventTarget {
      constructor() {
        super();
        (window as unknown as { __stream: Stream }).__stream = this;
      }
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: Stream });
  });
}

export async function emitLive(page: Page, frame: Record<string, unknown>) {
  await page.evaluate((payload) => {
    const stream = (window as unknown as { __stream: EventTarget }).__stream;
    stream.dispatchEvent(
      new MessageEvent("live", {
        data: JSON.stringify({
          threadId: "thread-1",
          runId: "run-1",
          ...payload,
        }),
      }),
    );
  }, frame);
}
