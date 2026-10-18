# BUILD_PLAN.md — step-by-step build

> Working agreement: we build **one step at a time**. Each step lists *what* we build,
> *why*, *which files*, and *done-when* (how we prove it works). After each step I walk
> you through the code; you review; we adjust; then pick the next step.

**Stack (locked):** TypeScript · Postgres + Redis + BullMQ (full stack, wired from step 2) ·
Hono (webhook intake) · long-lived worker process · Heyo microVM sandboxes (`heyo` backend)
+ local `process` backend for dev · OpenRouter-compatible LLM client · fine-grained PAT for GitHub.

**Execution order (updated per review):** `13 → 17 (dashboard) → 18 (chat) → 14 (best-of-N)
→ 16 (toolchain image) → 15 (eval) → 19 → 20/21 (stretch)`. Step IDs stay stable (design
references use them); this line is the canonical sequence. Reasons: babysitting completes the
issue→PR lifecycle; the dashboard + chat come next so the whole loop can be **watched live**
end-to-end (and PR trace links from step 12 resolve to real pages); the toolchain image
precedes the eval since SWE-bench repos are Python (pytest etc.); the eval keeps its recorded
**pre-eval checklist** (baseline capture / FAIL_TO_PASS / PASS_TO_PASS / JUnit per-test).

---

## Phase 0 — Foundations

### Step 1 — Project scaffold + `harness doctor`
- **What:** finish the skeleton so every later step has a home: `src/config.ts` (env loading),
  `src/log.ts` (structured logging), `src/cli.ts` (command router), vitest setup.
  `harness doctor` reports: Node version, docker?, Postgres reachable?, Redis reachable?,
  HEYO_TOKEN set?, LLM key set?
- **Files:** `package.json`, `tsconfig.json`, `src/config.ts`, `src/log.ts`, `src/cli.ts`
- **Done when:** `npm run typecheck` passes and `harness doctor` prints a green/red status table.

### Step 2 — Full infra stack: Postgres + Redis + BullMQ + schema ✅
- **What:** `docker-compose.yml` (Postgres 16 + Redis 7), schema **in Drizzle** (`src/db/schema.ts` —
  `npm run db:generate` writes reviewable SQL into `/drizzle`; typed rows for free),
  migration runner, BullMQ queue definitions (`runs`, `babysit`).
  **Tables:** `threads`, `runs`, `events` (inbox), `webhook_deliveries` (dedup),
  `trace_events`. Budgets = columns on threads/runs.
- **Files:** `docker-compose.yml`, `drizzle.config.ts`, `src/db/{index.ts,migrate.ts,schema.ts}`,
  `drizzle/0000_*.sql`, `src/queue/index.ts`, `tests/integration/*`
- **Done when:** ✅ `docker compose up -d && npm run migrate && harness doctor` all green;
  a test job enqueues into BullMQ and is picked up by a stub worker.

---

## Phase 1 — Sandbox layer

### Step 3 — Sandbox interface + `local` backend ✅
- **What:** the `Sandbox` interface with the **tool-call contract**
  (self-contained commands, real kill deadline, secrets-as-env). `LocalSandbox` runs
  commands as processes in `.harness/sandboxes/<id>/repo` on the Mac with
  process-group SIGTERM→SIGKILL on timeout. Checkpoints = git commits.
  Injected via `--local`/tests only — never selectable by config.
- **Files:** `src/sandbox/{types.ts,local.ts,index.ts}`, `tests/unit/local-sandbox.test.ts`
- **Done when:** ✅ 9 conformance tests prove: exec captures output + exit codes,
  no state leaks between execs, a hanging command is **killed** at its deadline,
  secrets-as-env, checkpoint returns a sha (+no-op checkpoint), destroy idempotent,
  keep preserves, clone with ref checkout, localPath copies don't mutate the original.

### Step 4 — `heyo` backend (real Firecracker microVMs) ✅
- **What:** same interface over `@heyocomputer/hws`: createDeployment → pull image →
  boot → `exec` (wrapped with guest `timeout` since Heyo's API timeout doesn't kill, and
  with an embedded `cd` since Heyo's `cwd` option isn't dependable) → checkpoint commits →
  destroy (or keep). Git credentials for private repos land in `/etc/git-credentials`,
  outside `/workspace`. `harness sandbox smoke` is the standing proof command.
- **Files:** `src/sandbox/heyo.ts`, `src/sandbox/index.ts` (factory), `src/commands/smoke.ts`
- **Done when:** ✅ smoke test against Heyo Cloud passes (2026-10-17):
  VM boots → repo clones → tests run → checkpoint sha recorded → VM destroyed — **6.2s total**.
  First-run bug found & fixed: server ignores the exec `cwd` option → embedded `cd` in the wrapper.

---

## Phase 2 — Tools + agent brain

### Step 5 — Tools (`bash`, `read_file`, `edit_file`, `search`, `run_tests`, `finish`) ✅
- **What:** every tool = a thin, safe wrapper over `sandbox.exec`. `edit_file` = exact-string
  replace with verification (refuses 0 matches and ambiguous matches; byte-verifies the
  write with `wc -c`). All outputs pass through the **truncator** (head + tail + "N lines
  omitted"; 300 lines / 20k chars). `search` = rg → `git grep` → `grep` ladder,
  fixed-strings by default (regex: true opt-in), capped with an honest "+N" note.
  `run_tests` resolves command: explicit → task spec → repo auto-detection.
- **Files:** `src/tools/{types,truncate,bash,read-file,edit-file,search,run-tests,finish,index}.ts`,
  `tests/unit/tools.test.ts`, `tests/integration/heyo-tools.test.ts`
- **Done when:** ✅ 40 unit tests (edit verification, ambiguity refusal, truncation limits,
  timeout kills, search caps) + **live conformance on a Heyo microVM** (bash/read/search/
  edit/run_tests/checkpoint round-trip) — 9/9 integration tests green, VM cleaned up.

### Step 6 — LLM client (OpenRouter / OpenAI-compatible) ✅
- **What:** one `LLMClient` interface: `complete(messages, tools) → text | toolCalls + usage`.
  Raw `fetch` (no SDK); retry on 429/5xx with exponential backoff + jitter; immediate
  throw on other 4xx; latency + token + cost accounting (`LLM_PRICE_IN/OUT_PER_MTOK`).
- **Files:** `src/llm/{types,openai,index}.ts`, `src/commands/llm-smoke.ts`
- **Done when:** ✅ `harness llm smoke` passes against OpenRouter
  (deepseek/deepseek-v4.1-flash): text round-trip (`finish: stop`) + tool-call round-trip
  with valid JSON arguments. Note discovered live: reasoning models spend completion
  budget on chain-of-thought — tiny max_tokens yields empty text; usage counts it.

### Step 7 — Agent loop (reproduce → fix → verify) ★ vertical slice ✅
- **What:** the **engine** (`packages/agent/src/engine/`: loop, budgets, events, strategy
  contract, protocol context) + the first built-in agent (`agents/coding/`) + repo map.
  Guardrails: step/token/$ budgets, loop detection (identical call 3× → blocked), nudges for
  no-tool-call turns. Phase moves are agent-driven with evidence checks (**decision #35** —
  failing/passing run_tests gate the `advance` calls), never on the model's unchecked claims. `harness run <repo> <issue> [--local]` is the CLI entry.
- **Files:** `packages/agent/src/{engine/*,agents/coding/*}`, `apps/harness/src/commands/run.ts`,
  `fixtures/buggy-lib/`, `packages/agent/tests/unit/engine.test.ts`
- **Done when:** ✅ **live run 2026-10-17 (local backend):** reproduce (suite fails) → fix
  (one minimal edit) → verify (suite green + diff review + spot checks) → finish —
  **8 turns, 22.7k tokens, 13.2s.** Fixed live along the way: npm flag pass-through in
  workspace scripts; `localPath` on the heyo backend now fails fast (silently empty repo
  before); `run_tests` gained `meta.ran` so "couldn't run" ≠ "failed." Heyo-backend re-run
  of the same demo waits on `GITHUB_TOKEN` (private repo) or a public fixture URL.

---

## Phase 3 — Observability + resilience

### Step 8 — Traces (structured JSONL + DB) ✅
- **What:** every step logged: prompts (reconstructable), tool calls + inputs, tool outputs
  (truncated, with content), tokens, latency, cost, phases, guardrails. Written to
  `traces/<run-id>.jsonl` **and** the `trace_events` table — **one sequence number owns
  both sinks**, so file and DB always agree on order. `redact()` at the persistence
  boundary (applb_/sk-/gh*_/Bearer/user:pass@URLs). The event stream was extended to be a
  *complete journal* (llm `text` + `toolCalls`, tool `content`) — the replay material step 9
  consumes. This doubles as the PR's trace link (step 12/17).
- **Files:** `packages/agent/src/trace/{redact,jsonl}.ts`, `apps/harness/src/trace/store.ts`,
  `tests/unit/trace.test.ts`, `tests/integration/trace.test.ts`
- **Done when:** ✅ live run produced a 77-event trace showing the full story
  (reproduce → fix → verify → finish), in the file *and* row-order-tested in the DB.

### Step 9 — Checkpoints, resume, and durable turns ✅
- **Package:** `Sandbox.fork(ref)` (local: full — clean state at the ref, uncommitted changes
  not carried; heyo: retained-disk wake path, fork stub until best-of-N-on-Heyo); engine
  `pauseAfterPhase` (graceful stop at a phase boundary → reason `"paused"` + `checkpointRef`);
  auto-checkpoint at every phase boundary (`checkpoint` events); thread persisted after EVERY
  completed turn with `phase` on `StoredThread` (the resume position) — a crash loses at most
  the in-flight turn. Resume = `runAgent` again with the same thread + sandbox; it starts in
  the saved phase.
- **App:** `runs.heartbeat_at` + `threads.messages/phase` columns (drizzle migration 0001);
  `src/runs/lease.ts` — `heartbeatRun` / `withHeartbeat` / `sweepStaleRuns` (stale run →
  `interrupted` → resume run enqueued; race-safe via conditional status flip).
- **Done when:** ✅ package: pause→resume completes the fix (tested); thread saved every turn
  (counting store); fork-at-checkpoint yields the old state (a test caught the uncommitted-
  changes bug → forced checkout). App: sweep interrupts stale runs and enqueues resumes; fresh
  runs untouched (integration tests). Live: ⛳ checkpoints in real runs.
  **The end-to-end kill-the-worker demo moves to step 10 — it needs the worker to kill.**
  Stretch (kept): step-level journal memoization (replay recorded LLM calls instead of
  re-paying for them).

---

## Phase 4 — Full stack in motion (threads, GitHub, babysitting)

### Step 10 — Worker process + run jobs ✅
- **App:** `PostgresThreadStore` (durable ThreadStore on `threads.messages/summary/phase`,
  pulled forward from step 11); `executeRun` — a reusable injectable executor (heartbeats,
  AbortController registry via `cancelRun`, dual-sink traces, status/usage/checkpoint
  recording); `harness worker` — runs consumer (concurrency 1) + the sweep as a BullMQ 6
  **Job Scheduler** + graceful drain on SIGTERM; `harness runs enqueue` — the manual door
  into the pipeline; migration 0002 (`runs.task`).
- **Lease coherence (learned live):** `--stale-after-ms` must be ≥ 1.5× the heartbeat
  interval, validated at startup — the demo's 3s threshold vs 30s cadence made the sweep
  eat its own live run. Now both are flags (`--heartbeat-every-ms`, `--stale-after-ms`).
- **Done when:** ✅ live: enqueue → worker executed it (8 steps, succeeded, traces + usage
  + checkpoint recorded) → **`kill -9` mid-run** → a second worker recovered: the heartbeat
  sweep's resume run AND BullMQ's stalled-job redelivery both completed successfully; no
  state lost; SIGTERM drains cleanly. Integration tests: store roundtrip, executor
  end-to-end, full recovery pipeline (stale → sweep → queue → resume at saved phase).

### Step 11 — Threads: inbox, one-turn-at-a-time, state machine ✅
- **App:** inbox (`appendEvent` — webhook deliveries or internal events; `pendingEvents`
  oldest-first; `consumeEvents` = coalescing by batch); `wakeThread` with the lock enforced
  by the **DATABASE** (partial unique index: one active run per thread — concurrent wakes
  create exactly one run); lifecycle state machine (`threads/state.ts`, validated
  transitions; PR states get wired by steps 12–13); the sweep tolerates the unique conflict
  (skips when an active run owns the turn). Migration 0005: `events.delivery_id` nullable
  (internal events have no GUID) + the unique index.
- **Files:** `src/threads/{inbox.ts,state.ts,wake.ts,thread-store.ts}`, `src/db/errors.ts`, tests
- **Done when:** ✅ state machine tests pass (happy path, illegal jumps, terminal states);
  concurrent wakes create exactly one run (Promise.all integration test); run N+1 rehydrates
  run N's conversation (covered by the store roundtrip + worker-resume tests).

### Step 12 — GitHub integration + webhooks (`harness serve`)
- **What:** PAT client (fetch issue, create branch, push commits, open PR with trace link —
  **never touches main**). Hono webhook service: signature verify, dedup
  (`X-GitHub-Delivery` + business keys), `issues: labeled` → create thread → enqueue run.
  **Triage-lite (decision #28):** classify by **identity + semantics** (`sender.login` vs our bot,
  event kind) — external reviews (ANY author: human or review bot) and human messages take the
  **interjection path** when the thread is busy (cancel; the event becomes the next turn); machine
  events AND self events (our pushes/comments — **not suppressed**) queue and wake the agent when
  idle; the router renders *expected behavior* per event (self push → "no action — acknowledge";
  bot events → "fix / clarify / note as appropriate") and the agent judges. Ack-only turns write
  to the thread, never GitHub → echo chains terminate; budgets backstop.
- **Files:** `src/github/{client,signature,triage,repo,pr}.ts`, `src/server/{app,serve}.ts`,
  `src/threads/{wake,state,inbox}.ts`, `tests/{unit,integration}/github-*, webhook, pr-delivery`
- **Done when:** ✅ built + mock-e2e tested (2026-10-17): signed webhook → thread + consumed event +
  queued run (6 integration cases: happy path, busy-thread parking, delivery dedup, bad signature,
  ping, terminal thread); PR delivery proven against a real bare origin + fake API (branch pushed,
  base untouched — `rev-list` counts, trace link in the PR body, thread → `pr_open`).
  **Live demo pending `GITHUB_TOKEN` + `GITHUB_WEBHOOK_SECRET` in `.env`:** label an issue `agent:fix`
  → a PR appears automatically.

### Step 13 — PR babysitting (timers + events)
- **What:** handle `check_run`/`status` → **queue** (machine events, #28); our own **pushes** → queue + "no action — acknowledge" render; `pull_request_review`
  + review comments — ANY author: human or review bot → **interject** (cancel the busy run; the feedback becomes
  the next turn — the **subsumption rule** decides whether the interrupted work resumes);
  BullMQ **repeatable job** (cron every 10 min) sweeps open agent PRs for failed checks,
  unanswered comments, merge conflicts. Budgets cap it (max turns/$ per thread).
  **Pre-wired:** run dispositions — `finish(disposition:"watch", watch, resumeAt)` lands as
  `runs.disposition` + `threads.watch`, and the declared resume phase survives on the thread;
  the sweep and targeted nudges consume it here.
- **Files:** `src/worker/{babysit,sweep}.ts`, `src/github/{checks,render,client,pr}.ts`,
  `src/server/app.ts`, `src/runs/execute.ts`, `src/threads/inbox.ts`
- **Done when:** ✅ built + mock-e2e tested (2026-10-17): check_run failure → babysit turn (webhook + sweep);
  review-while-busy → durable cancel + parked event (interject); own push → ack turn; PR closed → terminal
  (+ active run cancelled); merge conflict → sweep-found turn; budgets cap; active run defers; duplicate
  findings stay singular. Follow-up runs clone the PR branch and `deliverPullRequest` updates the existing
  PR in place; `blocked` → comment + `agent:needs-input`; the renderer is the one #28 voice (webhook, drain,
  sweep). **Live demo pending `GITHUB_TOKEN`:** push a red commit → agent detects + fixes → checks green.

---

## Phase 5 — Best-of-N, evals, hardening

### Step 14 — Best-of-N
- **What:** after the shared reproduce checkpoint, fork N sandboxes in parallel, race the
  fix, pick winner = tests pass + smallest diff. Losers destroyed.
- **Files:** `src/agent/bestofn.ts`
- **Done when:** `harness run … --best-of 3` reports attempts + winner rationale.

### Step 15 — Eval suite
- **What:** task JSON schema; SWE-bench Lite subset loader (30–50 tasks) + seeded bugs in
  fixtures we own; `harness eval` runs everything → solve rate, $/task, p50/p95 time,
  **failure-mode breakdown** (repro-failed / wrong-fix / timeout / budget / loop / tool-error).
- **Pre-eval requirements (from review — blocking):**
  - Baseline capture in `reproduce`: the first full-suite run records per-test results, so
    pre-existing failures/flakes on `main` never block the phase machine.
  - Success = SWE-bench model: **FAIL_TO_PASS** (task-provided targets from the task JSON, or
    "≥1 baseline-failing test now passes" when absent) **AND PASS_TO_PASS** (no baseline-passing
    test regresses). Exit codes only as the fallback when no per-test data exists.
  - `run_tests` gains structured results: `junit_path` → `meta.tests` (regex-parsed JUnit XML,
    zero-dep); task JSON carries `failToPass`/`passToPass`.
  - Optional de-flake: rerun baseline failures once before recording.
- **Files:** `src/eval/*`, `eval/tasks/*.json`, `packages/agent` (run_tests + coding strategy gates)
- **Done when:** one command produces the full report + per-task traces.

### Step 16 — Toolchain VM image
- **What:** custom Heyo image (git, node, python, ripgrep, test runners — maybe docker)
  built via `heyvm mvm build`, published to the artifact store. Runs boot warm, no apt-get.
- **Files:** `image/Dockerfile.firecracker`, build script
- **Done when:** Heyo smoke boots from our image with zero install steps.

### Step 17 — Dashboard: API + threads/runs view + trace viewer
**17a — Accounts + GitHub App + onboarding (from review — before the UI):**
- **What:** `users` + `sessions` tables (sign in with GitHub via the SAME App's user OAuth;
  first login = signup; DB stores only session-token hashes — no passwords). `installations`
  table; `threads.user_id` + `threads.installation_id`. Onboarding: install the App
  (`state`-bound; `installation` webhook sender as fallback) → pick a repo → dashboard.
  **GitHub auth swaps PAT → App (decision #42):** JWT (RS256) → per-installation tokens
  (~1h, cached), app-level webhooks (one secret; `installation.id` in every payload), bot
  login derived `{slug}[bot]`, sandbox git credentials = installation token per run,
  `GitHubAppService.clientFor(installationId)` (test-injectable — fakes unchanged). Local
  dev: a free dev App pointed at localhost (+ `DEV_AUTH_BYPASS` for UI-only iteration,
  loud and dev-only). `GITHUB_TOKEN` / `GITHUB_BOT_LOGIN` retire.
- **Files:** `src/auth/{routes,session}.ts`, `src/github/app.ts` (+ client rework), schema
  migration (users/sessions/installations + threads FKs), `src/server/*`, onboarding UI
- **Done when:** fresh login → install → repo picked → dashboard; label an issue (repo with
  the seeded bug) → PR appears via the App's tokens; all existing tests stay green (fakes).

**17b — the dashboard proper:**
- **What:** `server/api.ts` (REST over threads, runs, trace_events); static dashboard page:
  threads list (state, budget, PR link) → runs per thread → full trace view (prompts, tool
  calls, outputs, tokens, cost). The PR trace link (step 12) points here.
  **Live SSE:** `GET /api/threads/:id/stream` + Redis pub/sub bridge (worker publishes
  nudges; server fans out) — state changes update single nodes, per decision #14.
  Small actions: cancel run, keep sandbox for debugging, **Interject** on any pending event
  (explicit override — decision #28).
- **Files:** `src/server/api.ts`, `src/server/stream.ts`, `src/server/dashboard/*`
- **Done when:** after a run, the dashboard shows the thread → run → trace live; the trace
  URL from a PR opens the right run.

### Step 18 — Chat interface (SSE streaming)
- **What:** chat with the agent thread from the dashboard. A chat message is just another
  inbox event (`chat_message`) — same one-turn-at-a-time pipeline as GitHub comments; **while
  the bot is busy a send interjects** (#28 — human-authored): cancel the active run, the message
  becomes the next turn. The earlier Enter=queue / double-Enter=interject sketch reconciles here
  — a "queue instead" affordance can be reviewed with this UI.
  New `messages` table (author: user|agent, status: streaming|complete) via `drizzle-kit
  generate`; a reply row is created when the turn starts and updated on each ~100ms batch
  flush with **cumulative text**; `complete` at turn end. SSE token batches per decision #14.
  Rendering rules: append-only transcript, only the streaming node mutates, snapshot-replace
  semantics (idempotent, gap-proof), refetch-on-reconnect.
- **Files:** `src/db/schema.ts` (+messages), `src/threads/messages.ts`, `src/threads/wakeThread.ts`,
  `src/server/api.ts` additions, `src/server/dashboard/` chat UI
- **Done when:** type a message → the reply streams in; **refresh mid-stream** shows the
  partial text and the stream continues; transcript never fully re-renders (only the
  streaming node mutates).

### Step 19 — Polish + write-up
- **What:** README with architecture diagram, eval results, and failure-mode write-up.
  (Turn compaction shipped early in the engine — decision #18.)
- **Done when:** README is presentable as a portfolio piece.

## Phase 6 — Extraction & ecosystem (stretch, after eval results)

### Step 20 — Extract the framework: own repo, published package, consumer #1
- **What:** move `packages/agent` to its own repository (own README, docs, CI, license);
  make it publishable (`exports` map, `files`, version 0.1.0, scope decided at publish
  time); publish to npm/GitHub Packages; in the harness, replace the workspace dependency
  with the published version. A minimal `examples/` runs the framework without any of our
  infra (no GitHub, no Postgres — just a local dir + an LLM key).
- **Done when:** a fresh clone of the harness `npm install`s the published package and all
  tests pass without the workspace; the framework repo's CI is green; the example runs
  standalone.

### Step 21 — Second sandbox backend (E2B) — proves the pluggable claim
- **What:** implement `E2BSandbox` (~150 lines, same four methods: start/exec/checkpoint/
  destroy) and run a slice of the eval suite on it; publish side-by-side numbers
  (Heyo vs E2B) in the README. Intro: `SANDBOX_BACKEND=heyo|e2b` config surface
  (`local` remains CLI-injected, dev-only — decision #1).
- **Done when:** `SANDBOX_BACKEND=e2b harness eval --subset` produces numbers next to the
  Heyo run, and the interface's drop-in claim is proven by a real third-party backend.

---

## Review flow per step
1. I implement the step + tests
2. I walk you through the code (what each file does, in plain language)
3. You review, ask questions, request changes
4. We run the step's "done-when" together
5. Pick the next step
