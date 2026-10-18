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

### Step 1 — Project scaffold + `sailor doctor`
- **What:** finish the skeleton so every later step has a home: `src/config.ts` (env loading),
  `src/log.ts` (structured logging), `src/cli.ts` (command router), vitest setup.
  `sailor doctor` reports: Node version, docker?, Postgres reachable?, Redis reachable?,
  HEYO_TOKEN set?, LLM key set?
- **Files:** `package.json`, `tsconfig.json`, `src/config.ts`, `src/log.ts`, `src/cli.ts`
- **Done when:** `npm run typecheck` passes and `sailor doctor` prints a green/red status table.

### Step 2 — Full infra stack: Postgres + Redis + BullMQ + schema ✅
- **What:** `docker-compose.yml` (Postgres 16 + Redis 7), schema **in Drizzle** (`src/db/schema.ts` —
  `npm run db:generate` writes reviewable SQL into `/drizzle`; typed rows for free),
  migration runner, BullMQ queue definitions (`runs`, `babysit`).
  **Tables:** `threads`, `runs`, `events` (inbox), `webhook_deliveries` (dedup),
  `trace_events`. Budgets = columns on threads/runs.
- **Files:** `docker-compose.yml`, `drizzle.config.ts`, `src/db/{index.ts,migrate.ts,schema.ts}`,
  `drizzle/0000_*.sql`, `src/queue/index.ts`, `tests/integration/*`
- **Done when:** ✅ `docker compose up -d && npm run migrate && sailor doctor` all green;
  a test job enqueues into BullMQ and is picked up by a stub worker.

---

## Phase 1 — Sandbox layer

### Step 3 — Sandbox interface + `local` backend ✅
- **What:** the `Sandbox` interface with the **tool-call contract**
  (self-contained commands, real kill deadline, secrets-as-env). `LocalSandbox` runs
  commands as processes in `.anchor/sandboxes/<id>/repo` on the Mac with
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
  outside `/workspace`. `sailor sandbox smoke` is the standing proof command.
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
- **Done when:** ✅ `sailor llm smoke` passes against OpenRouter
  (deepseek/deepseek-v4.1-flash): text round-trip (`finish: stop`) + tool-call round-trip
  with valid JSON arguments. Note discovered live: reasoning models spend completion
  budget on chain-of-thought — tiny max_tokens yields empty text; usage counts it.

### Step 7 — Agent loop (reproduce → fix → verify) ★ vertical slice ✅
- **What:** the **engine** (`packages/core/src/engine/`: loop, budgets, events, strategy
  contract, protocol context) + the first built-in agent (`agents/coding/`) + repo map.
  Guardrails: step/token/$ budgets, loop detection (identical call 3× → blocked), nudges for
  no-tool-call turns. Phase moves are agent-driven with evidence checks (**decision #35** —
  failing/passing run_tests gate the `advance` calls), never on the model's unchecked claims. `sailor run <repo> <issue> [--local]` is the CLI entry.
- **Files:** `packages/core/src/{engine/*,agents/coding/*}`, `apps/server/src/commands/run.ts`,
  `fixtures/buggy-lib/`, `packages/core/tests/unit/engine.test.ts`
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
- **Files:** `packages/core/src/trace/{redact,jsonl}.ts`, `apps/server/src/trace/store.ts`,
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
  recording); `sailor worker` — runs consumer (concurrency 1) + the sweep as a BullMQ 6
  **Job Scheduler** + graceful drain on SIGTERM; `sailor runs enqueue` — the manual door
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

### Step 12 — GitHub integration + webhooks (`sailor serve`)
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
- **Done when:** `sailor run … --best-of 3` reports attempts + winner rationale.

### Step 15 — Eval suite
- **What:** task JSON schema; SWE-bench Lite subset loader (30–50 tasks) + seeded bugs in
  fixtures we own; `sailor eval` runs everything → solve rate, $/task, p50/p95 time,
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
- **Files:** `src/eval/*`, `eval/tasks/*.json`, `packages/core` (run_tests + coding strategy gates)
- **Done when:** one command produces the full report + per-task traces.

### Step 16 — Toolchain VM image
- **What:** a custom Heyo image — Ubuntu 24.04 with git, Python 3.12 (+pip/venv/pytest, the
  PEP 668 marker dropped so `pip install -r requirements.txt` just works), Node 22
  (+npm/corepack), ripgrep/fd, jq, and a native build toolchain — so a session boots warm
  with zero install steps.
- **Files:** `image/Dockerfile`; `image/build.sh` (docker build → `heyctl artifact push
  harness/sailor-toolchain:latest`). `sailor sandbox smoke --toolchain` proves the booted VM.
- **Done when:** Heyo smoke boots from our image with zero install steps. ✅ Verified via the
  git kind (`SMOKE PASSED in 180s`, toolchain probe `TOOLCHAIN-OK`).
- **Publish note (2026-10-18):** the ext4 rootfs builds locally (docker export → mke2fs,
  1013 MiB, verified with debugfs) but the namespace artifact store's upload path is broken
  platform-side: a 1 GiB blob dies with `Broken pipe` mid-stream, and even a 64 MiB probe gets
  `HTTP 502 — app-lb could not reach its artifact store` (same family as `setRepo` public
  answering 502 "the artifact store refused this app-lb's credential"). Until Heyo fixes the
  store, the git kind is the production path; the ext4 push retry is a one-command follow-up.
- **Secret durability:** `heyo-build-git` currently holds an App installation token (~1h).
  Before real testing, replace it with a durable fine-grained PAT (repo read) via
  `heyctl create secret heyo-build-git -n harness --from-stdin git-token`, or make the repo
  public; the artifact path (once the store heals) removes the secret entirely.

### Step 17 — Dashboard: API + threads/runs view + trace viewer
**17a — Accounts + GitHub App + onboarding ✅**
- **What:** `users` + `sessions` + `installations` + `repositories` tables; **both sign-in
  methods** — email+password (**argon2id** via `@node-rs/argon2`) and GitHub user-to-server
  OAuth (first login = signup; a GitHub verified email links onto an existing account; DB
  stores only session-token hashes). Onboarding: install the App (`state`-bound; `installation`
  webhook sender as fallback) → **select repos (THE GATE, decision #44)** → dashboard.
  `repositories.enabled` gates **every** webhook except the installation lifecycle: events for
  unselected repos are recorded in the delivery ledger and ignored. **GitHub auth swaps PAT →
  App (decision #42):** JWT (RS256) → per-installation tokens (~1h, cached), app-level webhooks
  (one secret; `installation.id` in every payload), bot login derived `{slug}[bot]`, sandbox git
  credentials = installation token per run, `GitHubAppService.clientFor(installationId)`
  (test-injectable). `installation` / `installation_repositories` webhooks keep rows in sync.
  Local dev: a free dev App pointed at localhost (+ `DEV_AUTH_BYPASS` for UI-only iteration).
  `GITHUB_TOKEN` / `GITHUB_BOT_LOGIN` retired (doctor now reports the App).
- **Files:** `src/auth/{routes,onboarding,password,session,users,github-oauth}.ts`,
  `src/github/{app,installations}.ts`, migration `0008`, `src/server/{app,serve}.ts`,
  `src/runs/execute.ts` + `src/worker/*` (App tokens), `apps/dashboard/*` (Vite + React +
  Tailwind v4 login + onboarding UI; dev proxy → :8787).
- **Done when:** ✅ back end end-to-end: signup/login/logout/me, GitHub callback (faked OAuth
  with account linking), dev bypass, install → `/setup` → repos synced **disabled** → selection
  saved, and the gate proven end-to-end (enabled repo → thread+run; disabled → ignored, no
  rows). **190 tests green** (94 package + 40 app unit + 56 integration); dashboard typechecks
  + builds; the live GitHub walkthrough waits on the dev App (DESIGN #43).

**17b — the dashboard proper ✅**
- **What:** `server/api.ts` (REST over threads, runs, trace_events) + `server/stream.ts`
  (Redis pub/sub bridge → SSE). The SPA gets three views: **threads list** (state, latest run,
  pending count, PR link) → **thread detail** (runs, pending events, actions) → **run + trace**
  (every AgentEvent rendered: phases, LLM turns, tool calls/results, guardrails, checkpoints,
  finish). Live: SSE nudges (`{threadId}` on every trace write, status change, webhook) trigger
  debounced refetches — the DB stays the truth, the stream only says "changed" (#14). Actions:
  **cancel** (durable flag for running; direct flip for queued + an executor guard so a
  cancelled-before-start run never executes), **keep sandbox** (new `runs.keep_sandbox` column,
  re-read right before destroy), **Interject** on any pending event (#28's explicit override:
  busy → cancel active; idle → drain now). The PR trace link (`/threads/:id?run=:runId`) opens
  the right run. `npm run dev` = the complete stack in one command (compose + migrate + serve +
  worker + dashboard).
- **Files:** `src/server/{api,stream}.ts`, migration `0009` (`runs.keep_sandbox`),
  `src/runs/execute.ts` (notify + keep + cancelled guard), `src/worker/*` (publisher),
  `apps/dashboard/src/{pages,components}/*`, `scripts/dev.mjs`
- **Done when:** ✅ after a run, the dashboard shows thread → runs → trace; the trace URL from a
  PR opens the right run; cancel/keep/interject proven against real Postgres+Redis (8 API
  integration tests incl. a real SSE connection through a live HTTP server); all suites green
  (**94 package + 40 app unit + 64 integration**).

### Step 18 — Chat interface (SSE streaming) ✅
- **What:** the thread page IS the chat: a **conversation feed** (humans from the events table
  — GitHub comments/reviews/chat messages; the agent by its final assistant text per run,
  pulled from the trace; system notes for labels/CI/pushes — protocol noise never rendered),
  a **composer**, and **token streaming**. A dashboard message is an inbox event
  (`chat_message`) through the same one-turn pipeline; while a run is busy the server queues
  it (Enter); pressing Enter again on the now-empty box (or the Interject chip) promotes it:
  `POST /api/events/:id/interject` cancels the active run and the message becomes the next
  turn (#28) — the double-Enter sketch, reconciled without new machinery. **No `messages`
  table** (deviation, on purpose): the record already exists as events + traces, and the
  streaming row is a live projection, not stored state. **Live channel** (`sailor:live`):
  the executor publishes compact projections — cumulative assistant text at ~10/s (decision
  #14 semantics), phase moves, tool call/result, finish — serve relays them as `event: live`
  on the same SSE stream; the client renders a streaming bubble with a caret and reconciles
  on the next nudge-refetch.
- **Files:** `src/server/api.ts` (POST messages + events/agentText in GET), `src/server/stream.ts`
  (LIVE_CHANNEL + send + createLivePublisher), `src/runs/execute.ts` (projectLive), worker/serve
  wiring, `apps/dashboard` (conversation.tsx, composer.tsx, markdown.tsx)
- **Done when:** ✅ type a message → it lands in the thread and a turn starts; while the agent
  works its text streams in token-batch with live phase/tool activity; Enter again interjects;
  integration tests cover idle/queued/busy/terminal message flows + the enriched GET shape
  (**65 integration tests**). A "refresh mid-stream" story comes free: state re-derives from
  the DB, the live bubble rebuilds from the stream.

### Step 18b — UI rebuild on a designed system ✅ (same-day, from review)- **What:** the dashboard got a real design system, not vibes: the **ui-ux-pro-max skill**
  (vendored at `.opencode/skills/`, design system persisted at `design-system/sailor/MASTER.md`)
  chose the direction — *"Code dark + run green"*: slate-OLED surfaces, run-green CTA,
  JetBrains Mono + IBM Plex Sans, dense dashboard scale, stagger-list motion, explicit
  anti-pattern list. **Animate UI** (shadcn registry) powers the primitives: animated
  Sidebar (product-suite chrome), Switch, Tabs, Tooltip, Dropdown, Dialog, Sheet, Progress,
  animated Copy buttons. New views: threads list (stats + motion stagger + skeletons), thread
  chat (above), settings (sections + switches), restyled login/onboarding to the same tokens.
- **Files:** `apps/dashboard/src/index.css` (token layer), `components/app-shell.tsx`,
  `pages/*`, vendored skill + MASTER.md
- **Done when:** ✅ typecheck + build green; login → threads → thread chat → trace → settings
  all live on the new system.

### Step 18c — chat turns are CHAT turns ✅ (same-day, from review)
- **What:** a run now records **which agent** takes it (`runs.agent`, migration 0010). Batches of
  nothing but `chat_message` events run the **chat agent** (`chatStrategy` + the coding tools —
  single `respond` phase, a text-only turn ends the run, tools available so it can look things
  up or act when asked); any GitHub/machine event keeps the **coding agent**. Resumes inherit
  the original run's agent; cross-strategy phase resume is safe (the engine starts at the
  strategy's first phase when the saved phase doesn't exist). Fixes the "asked a question, got
  a reproduce→fix→verify loop" review finding. Honest accounting too: `threads.turns_used`
  increments per run and `usd_spent` accrues per run's cost.
- **Also (from the same review):** status pills are now neutral + one semantic dot (only
  *running* gets a tint — color means something, nothing is decorated); consecutive push notes
  merge into one "×N" line; system events render as quiet centered hairlines; agent messages
  are plain text with an avatar (no boxes) and user messages are right-aligned bubbles — the
  thread reads like a chat, not a log.
- **Files:** `schema.ts` + migration `0010`, `runs/create.ts`, `threads/{inbox,wake}.ts`,
  `runs/lease.ts`, `runs/execute.ts`, dashboard `status.tsx` / `conversation.tsx`
- **Done when:** ✅ integration tests pin the routing (chat-only → `agent: chat`, GitHub event
  → `agent: coding`) and the full suites stay green (95 + 40 + 65).

### Step 18d — dashboard architecture: features, elements, hooks, utils ✅ (same-day, from review)
- **What:** the dashboard reorganized from "pages + components" into a **feature-based
  architecture**: `features/{shell,auth,onboarding,repos,threads,chat,trace,settings}` each
  owning its page(s) + `api.ts` + components + feature hooks; shared layers above: `elements/`
  (our visual atoms), `components/` (registry-generated only: `ui/` + `animate-ui/`), `hooks/`
  (shared stateful), `utils/` (pure: `cn`, `format`, `api-client`, `events`). Rules are written
  down in `apps/dashboard/README.md` (where a new thing goes; deep cross-feature imports are a
  smell; registry folders stay untouched). DRY extractions shipped with the move: **RepoPicker**
  (one gate UI for onboarding + settings — previously duplicated), **useThreadStream** (the
  only SSE wiring), **useUser / usePoll / useAction**, **AgentMessage / SystemNote** primitives
  (one component renders finished AND streaming turns), **eventPreview/eventAuthor** shared by
  feed and rail. No behavior change; typecheck + build green; `run.agent` now also shown in the
  rail (chat vs coding turns).

### Step 18e — Trace becomes a whole-thread span explorer ✅ (same-day, from review)
- **What:** the Trace tab is now a **LangSmith-inspired explorer over the ENTIRE thread**, not a
  single run: `GET /api/threads/:id/trace` returns every run + all its spans in one payload
  (token deltas excluded — reconstructable from `llm_call_finished`, and they'd dominate;
  tool output trimmed to 4k for transport) plus **thread-level totals**. The client builds the
  span tree (`features/trace/build-tree.ts`): run → phase → agent step (LLM call, duration =
  latency, tokens = usage) → tool call (paired with its result by name; duration/ok from meta);
  guardrails/checkpoints/errors hang off the innermost open container; spans without explicit
  durations get estimated ones from sibling chronology (marked `~`). UI: left tree (status dot,
  token chip, duration, aligned mini **waterfall bar** per row), right detail pane with
  **Input / Output / Metadata** tabs (agent text renders as markdown). `?run=` focuses a run —
  PR trace links and conversation "trace" chips land on the right node. Thread header shows
  runs (coding/chat split), total tokens, cost, wall time, turns. The explorer live-refreshes
  while its tab is open during an active run.
- **Files:** `src/server/api.ts` (+trace route), `apps/dashboard/src/features/trace/*`
  (api, build-tree, trace-explorer; old trace-view/run-panel deleted)
- **Done when:** ✅ endpoint covered by integration tests (totals, delta exclusion, visibility,
  401); typecheck + build green; suites 66 integration / 95 package / 40 app unit.
- **Review follow-up (same day):** the right context rail is gone (noise next to the explorer —
  cancel/keep compacted into the tab header as icon buttons, pending count as a chip; the
  rail's run list was redundant with the tree). The detail pane stacks **Input → Output →
  Metadata** as sections instead of tabs (the LangSmith reading pattern). Old
  context-rail/runs-list/pending-events components deleted.

### UI refinement — neutral workspace + browser verification
- Replaced the rejected navy/green treatment with porcelain/graphite themes;
  self-hosted Inter, code-only monospace, shared Animate UI buttons, tabs,
  menus, tooltips, switches, dialogs, copy controls, and stacked accordions.
- Chat preserves drafts on failure, handles IME correctly, and follows output
  only while the reader is near the bottom. Settings supports search, discard,
  and disabling all repositories; onboarding shares the same repo picker.
- Review corrections: neutral single keyboard-focus ring (no purple halo),
  clipped icon-only sidebar with explicitly hidden labels, a 48px workspace
  header, one title/actions/view toolbar, and compact inline trace totals.
  The desktop trace workspace starts within 165px of the viewport top.
- Verification: six Playwright scenarios with mocked APIs (no actual agent
  runs), light/dark axe audits, mobile/reduced-motion coverage, screenshots,
  sidebar bounds checks and a content-area regression assertion. Run with
  `npm run test:ui -w apps/dashboard`. Root build/typecheck pass. Package unit
  suite passes with `--maxWorkers=2`; the default parallel run hit the existing
  git-sandbox timeout/cleanup flake. No package/backend logic changed here.

### Streaming reliability + structured tool activity
- Live text/reasoning publication is no longer blocked on journal I/O. Each
  frame includes its step and sequence; the final aggregate flushes short tails.
- Initial loads and refreshes reconstruct ordered assistant/tool/assistant parts
  from the journal. SSE reconnect, bounded throttling, and periodic reconciliation
  recover missed starts and completion notifications without a manual refresh.
- Package additions: provider reasoning callback/usage, tool `verb` metadata and
  call IDs on call/result events. Tool verbs are developer metadata (with useful
  built-in defaults), not an extra parameter the model must generate.
- Chat renders grouped, expandable tool activity between assistant messages;
  active groups open while working and collapse as the next answer starts.
  Provider reasoning is separate; token counts appear only when supplied.
- Regression coverage includes lost-start and lost-finish browser scenarios,
  refresh replay, tool-ID pairing, reasoning parsing, immediate publication,
  and real HTTP SSE delivery. Integration checks use an isolated test database
  and Redis DB 15, not the live worker queue.

### Naming — package: Anchor (`@anchor/core`), product: Sailor

- The framework package is **Anchor** (`@anchor/core`, directory `packages/core`)
  and the product is **Sailor** (`apps/server` + `apps/dashboard`; CLI bin `sailor`).
- One sweep renamed the whole surface: npm names + workspace links, env prefixes
  (`SAILOR_PORT`, `SAILOR_PUBLIC_URL`), Redis channels (`sailor:updates`,
  `sailor:live`), session/oauth cookies, PR branches (`sailor/issue-*`), the local
  Postgres role/database (ALTER — demo data preserved), sandbox scratch + id
  prefixes (`.anchor/`, `sb-anchor-*`), UI copy + wordmark, docs, and the design
  constitution path (`design-system/sailor/MASTER.md`).
- External names are intentionally unchanged until renamed at their source: the
  Heyo namespace (token-scoped) and the GitHub App slug (`repoinbox-dev`).
- The push guard accepts pre-rename `harness/issue-*` branches so the existing PR
  keeps being babysat; new PRs open on `sailor/issue-<n>`.

### Sailor identity + conversation polish (review follow-up)

- Added a shared SVG helm for the product mark, activity indicators, and favicon.
  Redrawn from the supplied traditional-wheel reference: eight shaped handles,
  tapered spokes, an open hub, and a heavier rim. No background tile. Removed
  the repeated avatar/name/timestamp header from agent replies after review.
  Thinking/action marks rotate while busy; reduced motion disables rotation.
- Activity stays a compact, borderless expandable line. Expanded rows show
  action verbs and outcomes, not arguments/output JSON; Trace keeps the details.
  Groups open during work and collapse as the next assistant step starts.
- Activity labels now summarize the input in roughly 4–5 useful words (file,
  search target, command family, test suite). No extra model calls. Replay
  enriches old generic labels without modifying the journal or custom labels.
- Centered “Latest message” above the composer, including mobile. Removed the
  rejected cream/texture experiment; restored the original flat sidebar tone.
- Browser coverage includes keyboard expansion, refresh, busy/finished and
  reduced-motion states, plus jump-button alignment at desktop/mobile widths.

### Agent-led runtime, composed prompts, explicit publication

- One agent loop: model → authorized tools → observations → model. A final
  response ends the turn; no forced finish calls, transition checks, or test
  gates. The separate workflow implementation was removed, not kept as legacy.
- Meaningful phases describe the approach: understand, act, validate, respond.
  `set_phase` records an agent-chosen change, with skipping/revisiting allowed.
  Completion is possible from any phase. Caller-requested pause remains a
  runtime capability, not a task prerequisite.
- Named coding-prompt components: character/tone, judgment, operating rules,
  verification philosophy, phases, and context. Sailor configures the reusable
  coding agent with product identity and GitHub capabilities instead of
  duplicating its engineering behavior.
- Current requests are actual latest user messages. Internal controls do not
  become durable user instructions. The explicit `repair:history` command
  backs up and cleans known malformed historical working memory only; it skips
  active threads and never rewrites trace events.
- Publication and GitHub replies are explicit, thread-scoped tools. A completed
  response no longer pushes or comments implicitly. Repository selection is
  rechecked at publication. Verification comes from current-tree tool evidence;
  unverified new PRs are drafts. Optional `SAILOR_REQUIRE_PASSING_TESTS=1` gates
  publication only, never conversational completion.
- Heyo execution uses guest jobs and short control-plane observations, with
  real guest deadlines, separate stdout/stderr capture, and atomic receipts.
  Launches are never blindly replayed; transient observation reads may retry.
  Unknown completion is not reported as a confirmed kill. Live VM tests now
  require an explicit `RUN_LIVE_HEYO_TESTS=1`, not just credentials in .env.

### Conversation-loop corrections (from the WebRover spiral review)

- **Dashboard messages queue; sending never cancels.** The `/messages` endpoint
  appends the event and, only on an idle thread, drains it into a run; a busy
  thread logs "queued behind run X". Interjection stays explicit
  (`POST /api/events/:id/interject` via double-Enter or the composer chip), and
  the worker drains pending events into the next turn. The old behavior was a
  drift from decision #28 — which applies to incoming GitHub comments, not the
  composer. Tests: busy send leaves `cancel_requested_at` null and both messages
  pending.
- **Chat turns carry reply framing.** `renderGithubTask` for `chat_message`
  states the message expects a reply in text first; unfinished repository work
  then continues after the reply unless the message redirects or stops it. The
  reply is the signal "What up?" never produced; the resumed phase is what the
  continuation runs on.
- **Materialization advisory.** After N consecutive tool-only turns with no
  visible text (default 8; `guardrails.toolOnlyNudgeLimit`, `false` disables),
  the engine injects one runtime-only advisory (`origin: "engine"` — never
  persisted, never resent as user memory) asking for a reply or a visible
  status; it is recorded as a neutral `advisory` trace span. Advisory only: it
  never blocks actions or ends the run.
- Why this matters: a reasoning model's hidden chain is stateless between API
  calls, so nothing visible means nothing materialized. The 40-step spiral had
  no framing, no forcing function, and folded its own findings away (compaction,
  since replaced by model-window-derived budgets: fold at ~55% of the real
  context window, clamped to the 200–300k range).
- **Compaction is a visible handoff.** When context folds, the thread shows a
  quiet "Context compacted · N folded, M kept" line that expands to the summary
  the agent now carries (plus the folded transcript in debug mode) — identical
  on the live stream and after a refresh, since both paths project the same
  `compacted` event that the trace span uses.

### Live phase trail above the composer

- The running run's approach is visible where direction is given: a small
  strip above the composer shows the ordered phases (`understand → act →
  validate → respond`). Entered phases get a check, the current one shimmers,
  later ones wait; skips are honest because the list comes from the journal's
  recorded `phase_started` events, not assumptions. `run_started` now carries
  the full phase list, the REST projection exposes `phases`/`visited`/`phase`,
  and SSE forwards a `started` frame. Refresh mid-run reconstructs the trail
  from the journal; completion hides it immediately; reduced motion renders the
  current phase as plain ink.
- The queued dashboard message sits on the same row as the phase trail — a
  small chip with an explicit **Interject** action, so the composer stays one
  clean box. Hover (or keyboard focus) reveals the whole queued batch — multiple
  messages are combined into one next turn — with a per-message **withdraw**
  (`POST /api/events/:id/cancel`; only still-pending dashboard messages, never
  consumed history or GitHub events). Interjected messages land in the thread
  with a short rise-in animation (skipped under reduced motion).
- The open **reasoning** block tails its own text while the model thinks — the
  same follow-unless-scrolled-up rule as the thread.
- **Budget dials are product policy.** The engine keeps conservative package
  defaults (40 steps / 1.5M tokens / $5), and Sailor configures long-horizon
  limits (default 300 steps / 150M tokens / $5 per run via `SAILOR_MAX_STEPS`,
  `SAILOR_MAX_TOKENS`, `SAILOR_MAX_USD`; an overnight profile of 1200 / 400M /
  $50 is documented in `.env.example`). Token usage is *cumulative* across the
  run's calls — compaction bounds the per-call context and cannot slow the sum
  — so the token cap is a runaway backstop while steps and dollars are the real
  dials. Costs are real (LLM prices set for `deepseek-v4.1-flash`), which also
  arms the dollar check.

### Sandbox continuity (A + B): the workspace survives the run

- **A — retain + adopt.** While a GitHub thread is alive, its run's sandbox is
  retained (Heyo: scale-to-zero with the disk kept; local: the directory stays)
  and the id recorded on the thread. The next run — interjection, sweep resume,
  follow-up turn — ADOPTS the same sandbox: branch, edits, and uncommitted work
  exactly as left. Adoption failure falls back to a fresh clone and clears the
  stale pointer. Terminal threads (merged/closed) release the VM.
- **B — off-machine checkpoints.** Turn-boundary checkpoints are force-pushed to
  a side branch (`sailor/issue-<n>-checkpoint`) that the push webhook ignores by
  design (it matches headRef exactly), so no acknowledgment-run storm. A fresh
  clone prefers that branch over the PR branch — it carries the latest workspace
  — and the thread records it after the first successful push. Push failures are
  reported on the checkpoint event, never fatal to the run.
- Package/product split: retention, adoption, and checkpoint push are `Sandbox`
  interface capabilities in Anchor, and the lifecycle is dogfooded through the
  package's `openSandbox` (adopt → verify → fall back) and `releaseSandbox`
  (destroy by handle); Sailor supplies policy only — which threads retain, when
  to release, and the branch naming.

### Local debug display + trace failure visibility

- ⌘⇧D / Ctrl+Shift+D toggles debug mode. It persists locally, is also available
  in the account menu, and shows an active header indicator. No agent/API
  permission changes. Normal action summaries stay compact; debug mode retains
  open groups with per-tool expandable input/output and red failure details.
- Failed trace spans have a red icon/name, an explicit Failed label, a red
  waterfall segment, and a visible failure summary in the detail pane.
- Model spans in the trace expose provider reasoning: the full recorded text as
  a muted Reasoning block inside Output, plus `reasoningTokens` metadata when the
  provider reported usage — the same journal rows the chat's Provider reasoning
  blocks read. Nothing is fabricated when a provider withholds reasoning; the
  reasoning channel is never resent to the model (provider protocol practice).
- Compaction is legible in the trace: the compacted span's Input is the
  folded-transcript preview (capped at 6k) and Output is the summary that
  replaced it; counts stay in Metadata. The DB journal now applies the same
  redaction rules as the NDJSON sink. Sailor compaction runs at 256k estimated
  tokens with a 64k verbatim tail (was 24k/8k — the flap that made long
  investigations re-read folded-away findings).
- Removed the three duplicate source snapshots (`loop 2.ts`, `strategy 2.ts`,
  `strategy 3.ts`) and their temporary typecheck exclusions after confirmation.

### Step 19 — Polish + write-up
- **What:** README with architecture diagram, eval results, and failure-mode write-up.
  (Turn compaction shipped early in the engine — decision #18.)
- **Done when:** README is presentable as a portfolio piece.

## Phase 6 — Extraction & ecosystem (stretch, after eval results)

### Step 20 — Extract the framework: own repo, published package, consumer #1
- **What:** move `packages/core` to its own repository (own README, docs, CI, license);
  make it publishable (`exports` map, `files`, version 0.1.0, scope decided at publish
  time); publish to npm/GitHub Packages; in the sailor, replace the workspace dependency
  with the published version. A minimal `examples/` runs the framework without any of our
  infra (no GitHub, no Postgres — just a local dir + an LLM key).
- **Done when:** a fresh clone of the sailor `npm install`s the published package and all
  tests pass without the workspace; the framework repo's CI is green; the example runs
  standalone.

### Step 21 — Second sandbox backend (E2B) — proves the pluggable claim
- **What:** implement `E2BSandbox` (~150 lines, same four methods: start/exec/checkpoint/
  destroy) and run a slice of the eval suite on it; publish side-by-side numbers
  (Heyo vs E2B) in the README. Intro: `SANDBOX_BACKEND=heyo|e2b` config surface
  (`local` remains CLI-injected, dev-only — decision #1).
- **Done when:** `SANDBOX_BACKEND=e2b sailor eval --subset` produces numbers next to the
  Heyo run, and the interface's drop-in claim is proven by a real third-party backend.

---

## Review flow per step
1. I implement the step + tests
2. I walk you through the code (what each file does, in plain language)
3. You review, ask questions, request changes
4. We run the step's "done-when" together
5. Pick the next step
