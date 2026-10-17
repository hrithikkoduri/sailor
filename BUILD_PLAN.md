# BUILD_PLAN.md — step-by-step build

> Working agreement: we build **one step at a time**. Each step lists *what* we build,
> *why*, *which files*, and *done-when* (how we prove it works). After each step I walk
> you through the code; you review; we adjust; then pick the next step.

**Stack (locked):** TypeScript · Postgres + Redis + BullMQ (full stack, wired from step 2) ·
Hono (webhook intake) · long-lived worker process · Heyo microVM sandboxes (`heyo` backend)
+ local `process` backend for dev · OpenRouter-compatible LLM client · fine-grained PAT for GitHub.

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

### Step 4 — `heyo` backend (real Firecracker microVMs)
- **What:** same interface over `@heyocomputer/hws`: createDeployment → pull image →
  boot → `exec` (wrapped with guest `timeout` since Heyo's API timeout doesn't kill) →
  checkpoint commits → destroy. Plus the git-credentials setup (outside `/workspace`).
- **Files:** `src/sandbox/heyo.ts`, `src/sandbox/index.ts` (factory), `harness sandbox smoke`
- **Done when:** smoke test against Heyo Cloud passes: VM boots → repo clones → tests run →
  checkpoint sha recorded → VM destroyed. **Needs your `HEYO_TOKEN`.**

---

## Phase 2 — Tools + agent brain

### Step 5 — Tools (`bash`, `read_file`, `edit_file`, `search`, `run_tests`, `finish`)
- **What:** every tool = a thin, safe wrapper over `sandbox.exec`. `edit_file` = exact-string
  replace with verification (refuses ambiguous matches). All outputs pass through the
  **truncator** (head + tail + "N lines omitted") before entering model context.
- **Files:** `src/tools/*.ts`, `src/tools/truncate.ts`, `tests/tools.test.ts`
- **Done when:** tests prove edit verification, search caps, truncation at limits.

### Step 6 — LLM client (OpenRouter / OpenAI-compatible)
- **What:** one `LLMClient` interface: `complete(messages, tools) → text | toolCalls + usage`.
  Retries with backoff, token/cost accounting per call (we need $ budgets later).
- **Files:** `src/llm/client.ts`, `src/llm/openai.ts`
- **Done when:** a scripted call returns tool calls correctly and usage is recorded.

### Step 7 — Agent loop (reproduce → fix → verify) ★ vertical slice
- **What:** the phase machine + system prompt + guardrails (step/token/$ budgets,
  loop detection: same command 3× → force new approach). Repo map written at start.
  Ends with `finish(summary)`. This step makes `harness run <repo> <issue>` work.
- **Files:** `src/agent/{loop.ts,phases.ts,prompts.ts,guardrails.ts,repomap.ts}`
- **Done when:** `harness run ./fixtures/buggy-lib "add() returns wrong sum"` opens no PR yet
  but leaves: failing test → fix → passing test, all inside the sandbox. **First real demo.**

---

## Phase 3 — Observability + resilience

### Step 8 — Traces (structured JSONL + DB)
- **What:** every step logged: prompt sent, tool called, output (truncated), tokens, latency,
  cost. Written to `traces/<run-id>.jsonl` **and** `trace_events` table.
- **Files:** `src/trace/*.ts`
- **Done when:** after a run, the trace shows the full story of what the agent did.

### Step 9 — Checkpoints, resume, fork
- **What:** auto-checkpoint after each meaningful step; `harness run --resume <run-id>`;
  `fork(sha)` creates a new sandbox at a checkpoint (this is what best-of-N and
  crash-recovery both stand on).
- **Files:** `src/agent/checkpoints.ts`, CLI flags
- **Done when:** kill a run mid-way, `--resume` finishes it from the last checkpoint.

---

## Phase 4 — Full stack in motion (threads, GitHub, babysitting)

### Step 10 — Worker process + run jobs
- **What:** long-lived `npm run worker` consuming the BullMQ `runs` queue; one job = one
  agent run end-to-end (sandbox → loop → checkpoint → trace). Graceful shutdown.
- **Files:** `src/worker/index.ts`, `src/worker/runJob.ts`
- **Done when:** enqueue a run in DB → worker executes it → status transitions recorded.

### Step 11 — Threads: inbox, one-turn-at-a-time, state machine
- **What:** the **thread** record (a conversation that lives across turns) with an event
  inbox, a per-thread lock, coalescing of incoming events, and the lifecycle state machine
  (`queued → running → pr_open → waiting_ci ⇄ fixing → merged|closed|abandoned`).
- **Files:** `src/threads/{thread.ts,inbox.ts,state.ts}`, tests
- **Done when:** state machine tests pass; concurrent events don't spawn concurrent turns.

### Step 12 — GitHub integration + webhooks (`harness serve`)
- **What:** PAT client (fetch issue, create branch, push commits, open PR with trace link —
  **never touches main**). Hono webhook service: signature verify, dedup
  (`X-GitHub-Delivery` + business keys), `issues: labeled` → create thread → enqueue run.
- **Files:** `src/github/*.ts`, `src/server/*.ts`
- **Done when:** label an issue `agent:fix` on a test repo → a PR appears automatically.

### Step 13 — PR babysitting (timers + events)
- **What:** handle `check_run`/`status`/`pull_request_review` events → enqueue turns;
  BullMQ **repeatable job** (cron every 10 min) sweeps open agent PRs for failed checks,
  unanswered comments, merge conflicts. Budgets cap it (max turns/$ per thread).
- **Files:** `src/worker/babysit.ts`, `src/github/checks.ts`
- **Done when:** push a red commit to the PR branch → agent detects + fixes → checks green.

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
- **Files:** `src/eval/*`, `eval/tasks/*.json`
- **Done when:** one command produces the full report + per-task traces.

### Step 16 — Toolchain VM image
- **What:** custom Heyo image (git, node, python, ripgrep, test runners — maybe docker)
  built via `heyvm mvm build`, published to the artifact store. Runs boot warm, no apt-get.
- **Files:** `image/Dockerfile.firecracker`, build script
- **Done when:** Heyo smoke boots from our image with zero install steps.

### Step 17 — Polish + write-up
- **What:** trace viewer HTML page (linked from PRs), turn compaction (summarize old turns
  when context fills), README with architecture diagram, results, and failure-mode write-up.
- **Done when:** README is presentable as a portfolio piece.

---

## Review flow per step
1. I implement the step + tests
2. I walk you through the code (what each file does, in plain language)
3. You review, ask questions, request changes
4. We run the step's "done-when" together
5. Pick the next step
