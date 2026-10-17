# DESIGN.md — issue-to-PR coding harness

> Living decisions log. Every entry: what was decided, why, and by whom. Update as we go.

**One-line pitch:** label a GitHub issue `agent:fix`, get a PR with the fix, passing tests, and a link to the full agent trace — all inside an isolated Firecracker microVM.

## Vocabulary (kept consistent everywhere)

- **Agent** — the LLM-driven worker that decides and acts.
- **Agent harness** (a.k.a. agent framework) — everything *around* the agent that makes it work: the loop, tools, sandbox, context management, budgets, traces. **That is `packages/agent` (`@harness/agent`).** It ships with a default coding agent (the reproduce→fix→verify strategy + the coding tool set) but knows nothing about GitHub, Postgres, or this product.
- **The product** — the issue→PR pipeline that *uses* the agent harness: threads, queues, webhooks, GitHub, dashboard. **That is `apps/harness` (`@harness/app`).**
- **This repo** — currently both (staging monorepo); at step 20 the package moves to its own repo, is named properly (its own identity — "harness" nested inside "harness" is a staging name only), and the product consumes it as consumer #1.

## Architecture (current draft)

```
GitHub events ──webhook──▶  ┌───────────────────────────────────┐
Dashboard + chat ──HTTP──▶  │ server (Hono): webhooks · api ·   │  ──▶ Postgres (threads, inbox,
                            │ dashboard + trace viewer          │      jobs, traces)
                            └───────────────────────────────────┘
                                                                     │
                  timer/cron ("babysit PRs") ────────────────────────┤
                                                                     ▼
                                    worker process (long-lived)
                                      agent thread state machine
                                      turn = agent loop (reproduce → fix → verify)
                                                        │ tools (bash, read_file, edit_file,
                                                        │        search, run_tests, finish)
                                                        ▼
                                    Heyo microVM (Firecracker), /workspace/repo
                                    checkpoints = git commits (forkable)
                                    secrets injected as env at boot
```

## Repository layout — staging workspaces now, extraction later

npm workspaces with one package + two apps. Split by **runtime first, then domain**; one-way dependencies only: `apps → packages` (a sandbox adapter must never import the agent; the package must never import the app). The package tree follows the framework layers; `engine/` is agent-agnostic, `strategies/` holds our coding agent's reproduce→fix→verify.

```
packages/agent/   @harness/agent — the framework (publishable-ready from day one)
  engine/           loop, loop detection, budgets, context, events  (agent-agnostic)
  llm/              model transport (OpenAI-compatible + streaming)
  sandbox/          execution: interface + heyo + local backends
  tools/            capabilities: Tool protocol + the coding tool set
  strategies/       behavior: coding.ts (reproduce → fix → verify) ships as default
  trace/            structured events → JSONL + DB consumers
apps/harness/     the product: cli, config, db, queue, worker, server, github, eval
apps/dashboard/   Vite + React (step 17) — consumes the harness API over HTTP
eval/tasks/       data: eval specs        image/  toolchain VM Dockerfile
drizzle/          generated migrations    tests/{unit,integration}/
```

**Extraction plan (decided):** the workspaces are *staging*. After the eval suite (stretch, step 20), `packages/agent` moves to its own repository, is published as a versioned package, and the harness consumes it from the registry — the harness becomes consumer #1 of the framework. Publishable-ready rules apply from day one: no imports from `apps/`, dependencies declared explicitly, clean `exports` map.

## Dashboard & chat (scope decision)

One dashboard with three faces, all served by the same Hono server:

1. **Trace viewer** — a run's full step-by-step story (prompts, tool calls, outputs, tokens, cost). The PR links here ("a link to a full trace").
2. **Operations view** — threads list (state, budget, PR link) → runs → trace; live status. Small action endpoints (cancel run, keep sandbox) come after.
3. **Chat interface** — talk to a thread from the browser. **A chat message is just another inbox event** (`chat_message`) flowing through the exact same pipeline as GitHub comments: inbox → one-turn-at-a-time lock → worker → agent turn. Agent replies are stored in a `messages` table (author: user|agent) and rendered as the transcript. No second execution path, no duplicated logic. Live updates over **SSE** with the rendering rules below (decision #14).

`messages` table arrives with the chat step via `drizzle-kit generate`. Auth v1: no auth, dashboard binds localhost only. GitHub remains the primary conversation surface for outside users (issue comments, PR reviews); chat is the operator's window into a thread.

**No dedicated messaging service.** The three messaging jobs are each covered by something we already run: intake = a POST route in `server/api.ts`; delivery = BullMQ on Redis (retries, exactly-once, already proven in tests); persistence = Postgres (`events` + `messages`, the source of truth). The browser learns about replies over **SSE** (worker → Redis pub/sub → server → EventSource) — but Postgres stays the truth: a dropped stream or a refresh loses nothing, clients read-repair from the API. The only coordination rule — `wakeThread(threadId)`: enqueue a run if the thread is idle, otherwise the message waits in the inbox for the current turn's coalescing — lives in `src/threads/` (step 11), shared by webhooks and chat alike.

## Realtime over SSE — and how we avoid re-render storms

- **Transport.** `GET /api/threads/:id/stream` (SSE). The worker publishes change nudges to a Redis pub/sub channel; the server subscribes and fans out to that thread's open connections. Redis pub/sub is fire-and-forget — fine, because stream events are *accelerants, never truth*.
- **Two event kinds.** *State nudges*: small JSON (message created/updated, run status change, trace appended) — consumers update one node. *Token batches*: the streaming reply's **cumulative text snapshot**, flushed ~every 100ms — never one event per token.
- **Persistence.** A reply row is created the moment the turn starts (`status: streaming`) and updated on each batch flush; `complete` at turn end. Refresh mid-stream → the client renders the partial text from the row and keeps receiving batches.
- **No-gap guarantee without replay logs.** Batches carry the **full text so far, not deltas** — a lost event can't create a gap, reconnect needs no `Last-Event-ID` replay, and a duplicate is harmless (idempotent replace). On reconnect the client simply refetches the thread state (read-repair).
- **Rendering rules (the re-render fix).** Append-only transcript; **one DOM node per message**; during streaming *only* the streaming node mutates (append a text node — nothing else re-renders); state nudges touch only the affected node; the message list is never rebuilt on stream events. Rule of thumb: a token batch handler does O(1) DOM work.

## Durable execution (Inngest-style principles, on our own stack)

The "durable execution" school (Inngest, Temporal) exists to survive crashes, deploys, and retries without losing work or double-applying effects. We adopt the principles; we keep our own execution model (long-lived worker — decision #7):

1. **State outside the process.** Postgres holds the truth: threads, runs, messages, events, trace_events. A worker crash, a deploy, or a browser refresh loses nothing — every reader read-repairs from the DB. *There is no browser "session" to lose: the session IS the Postgres thread row.*
2. **Journaled steps.** `trace_events (run_id, seq)` is the run's journal: every LLM call (full prompt + response), tool call, and result, with a monotonic seq. The journal is what makes resume exact — rebuild the conversation, and (stretch) replay recorded LLM responses instead of paying for them again.
3. **Lease + heartbeat, auto-resume.** While executing, a worker renews `runs.heartbeat_at` (~30s). A sweep marks stale runs `interrupted` and re-enqueues a resume run: restore the sandbox from `checkpoint_sha`, rebuild context from the journal, continue. Baseline = resume at checkpoint granularity; stretch = step-level memoization (replay journaled LLM calls by `(run_id, step)`).
4. **At-least-once everywhere + idempotent effects.** Queues redeliver, webhooks repeat, workers retry — so every *effect* is guarded: PR creation checks `threads.pr_number` first, comments are looked up before posting, branch pushes are force-push idempotent, deliveries deduped by GUID, threads by `(repo, issue)`.
5. **Turn = resumable state machine.** Inputs = pending inbox events + thread summary + journal. A turn completes and checkpoints forward, or dies and resumes — it never half-applies invisible state.

**Not copied, deliberately:** serverless time-capped functions (hour-long turns are the anti-Lambda workload), hosted durable-execution platforms (our journal + leases implement the needed subset in a few hundred lines), full deterministic-replay engines (Temporal-grade machinery we don't need).

Lands in: step 9 (lease/heartbeat/resume + journal), steps 17–18 (SSE).

## Confirmed decisions

| # | Decision | Rationale | Status |
|---|---|---|---|
| 1 | Sandbox backends: `heyo` = the **only production sandbox**. `LocalSandbox` is a **dev/test implementation of the `Sandbox` interface**, injected via an explicit `--local` CLI flag or directly in tests — it is NOT a config type (`HARNESS_SANDBOX` deleted) | Mac can't run Firecracker (KVM is Linux-only), so dev needs a local implementation — but production must never silently fall back to unisolated execution. Test doubles are injected at the interface seam (and the Heyo SDK accepts a mock `fetch` for adapter tests) | ✅ refactored |
| 2 | Tools execute as self-contained shell commands in the VM via `exec` | Heyo `exec` starts fresh in `/` every call — `cd`/env don't persist | ✅ agreed |
| 3 | **Tool call contract**: every command must be self-contained (`cd /workspace/repo && …`) and wrapped with the Linux `timeout` utility | Heyo's `timeoutSecs` only bounds the API call — the guest process keeps running otherwise. `timeout --signal=KILL <s> bash -c '…'` gives real kill semantics | ✅ agreed — MUST be enforced in the tool definitions |
| 4 | Tools = thin structured wrappers over shell (not raw bash for the model) | `edit_file` = exact-string replace with verification; single truncation point; structured trace events; typed tool calls are more reliable for LLMs | ✅ agreed |
| 5 | Checkpoints = git commits in `/workspace`; resume = pull; fork = clone at sha | Maps to Heyo's own pattern; one mechanism covers crash-resume AND best-of-N | ✅ agreed |
| 6 | Secrets never enter `/workspace`. GitHub creds: short-lived, repo-scoped tokens, injected as env at boot (Heyo secrets plugin), git creds in `/etc/git-credentials` | Guardrail from spec; no leak via repo copy/log paste | ✅ agreed |
| 7 | Stack: **Postgres + Redis + BullMQ** (queue + repeatable/timer jobs) + Hono webhook intake + long-lived worker process for agent turns | Agent turns run minutes–hours → worker process, not serverless functions. Inngest evaluated; see tradeoffs below | ✅ agreed |
| 8 | GitHub auth: **fine-grained PAT** on a bot account for now; GitHub App later (product path) | PAT gets us to the demo fastest; the REST calls are identical either way, so nothing gets thrown away. (GitHub App = bot identity users install, no user OAuth involved; OAuth App is a different thing — user login — not needed) | ✅ decided: PAT |
| 9 | VM image: custom "toolchain image" (git + node + python + ripgrep + test runners baked in) published to Heyo artifact store | `heyo/debian` has no git/node/python; apt-get per run is slow + flaky. Image = like a Docker image, but boots as a VM | ✅ agreed in principle |
| 10 | Thread model: persistent record (Postgres) + inbox of events; one turn at a time per thread; coalesce incoming events; priorities: review comments > CI failures > chatter | Answers "review comments go to same agent thread" + dedup | ✅ agreed in principle |
| 11 | PR babysitting: event-driven (check_run/review webhooks) + cron sweep of open PRs; bounded by thread state machine + budgets (max turns, max $) | Catches dropped webhooks/flaky CI; can't loop forever | ✅ agreed in principle |
| 12 | LLM: provider-agnostic interface; OpenRouter/OpenAI-compatible first. **Streaming: single wire path** — every call is `stream: true`, `complete()` aggregates `stream()`, tool-call fragments assemble by index; `onDelta` feeds the trace and the chat SSE (step 18) | Swappable; all models reachable; one parser can't drift; token-level events for free | ✅ agreed |
| 13 | Dashboard: threads/runs view + trace viewer + **chat interface**. Chat messages reuse the thread inbox pipeline (`chat_message` event); replies in a `messages` table. `server/` hosts api + webhooks + dashboard in one Hono app; no auth v1 (localhost) | One pipeline for every trigger — GitHub comments, CI events, and chat are all inbox events. GitHub stays the primary conversation surface; chat is the operator window | ✅ decided |
| 14 | Realtime over **SSE** (not polling, not WebSockets): worker → Redis pub/sub → server → EventSource. Token batches = cumulative text snapshots flushed ~10/s (never per-token); streaming reply persisted as a `messages` row updated per flush; O(1) DOM updates — only the streaming node mutates | Snapshot semantics make events idempotent and gap-proof (no replay log, no deltas); batching + single-node updates kill re-render storms; refresh mid-stream loses nothing | ✅ decided |
| 15 | **Durable execution principles** on our own stack: DB-as-truth (no browser session state), journaled steps (`trace_events`), run lease + heartbeat with auto-resume from checkpoint, idempotent effects everywhere. No serverless/hosted durable-execution platform | Crash/deploy/refresh loses nothing; resumes without human action; honors the anti-Lambda reasoning of decision #7 | ✅ decided |
| 16 | Framework extraction: `packages/agent` develops in-repo as an npm workspace (**staging**), then is extracted to its own repo and **published** (step 20); the harness imports the published package as consumer #1. Publishable-ready rules from day one: no `apps/` imports, explicit deps, clean `exports` map | Separate repo = real boundary + own CI/docs/versioning; consumer-#1 proves reusability. Staging in-repo avoids cross-repo iteration pain during the build | ✅ decided |
| 17 | **Threads / cross-run memory — framework-first.** The package ships the generic capability now: `ThreadStore` interface + `MemoryThreadStore` default + engine integration (`thread` option loads prior turns, saves on every exit path; summary flows into the system prompt). `PostgresThreadStore` implements the interface in the app when step 11 consumes it; extraction (step 20) merely moves the repo. No DB dependency in the package, ever — the framework defines the shape, the consumer supplies the notebook (same split as LangGraph's `MemorySaver` vs `langgraph-checkpoint-postgres`; "checkpointer" is that vocabulary's name for the concept). Named **ThreadStore** throughout — ecosystem- and product-consistent language | Conversation memory across runs is generic (chat agents are the proof case, not just issue→PR). Built interface-first per review so the framework stays genuinely framework-shaped; product-specific continuity (GitHub lifecycle, dedupe, budgets, crash-resume) stays product-side | ✅ decided |
| 18 | **Compaction pulled forward into the engine** (was step 19): checked before every turn; chars/4 token estimate; oldest span folded into the running summary via one LLM call (usage counted in budgets); protocol-safe cut (kept span never starts at a `tool` message); system prompt regenerated; `compacted` event emitted; `compaction: false` disables | Threads live for days — without this they crash on context limits. Self-contained in `engine/`, so built early rather than deferred | ✅ decided |
| 19 | **Everything but the LLM is optional** (AI-SDK-style ergonomics). Defaults: `strategy` → `chatStrategy` (`finishWhenNoToolCalls`: a text-only turn IS the reply), `tools` → `[]`, `sandbox` → none; `codingStrategy` declares `requiresSandbox` (validated at startup, like `requiredTools`); tools that need execution fail gracefully via `requireSandbox()` when none is supplied. Single-call use = `llm.complete()` | Simple things simple, complex things possible: `runAgent({task},{llm})` is a chat loop; the same API with tools+sandbox+strategy is the coding harness. The harness becomes a *configuration*, not the only way | ✅ decided |
| 20 | **Guardrail inventory**: budgets, loop detection, text-only stall, compaction, finish gate, command timeouts, truncation, redaction. All built-in and always on by default (opt-in protections get forgotten), each with a dial: `budgets.*`, `guardrails.repeatedToolCallLimit` (default 3, `false` disables), `guardrails.emptyTurnNudgeLimit` (default 2, `false` = never stall), `compaction.*`, `validateFinish` (strategy hook). Interventions are `guardrail` events | Answers "what are guardrails, are they wired, are they attachable" precisely: wired ✅, dials ✅, and the one strategy-attachable piece (finish gate) is a hook. Full user-defined guardrail middleware is deliberately not built — not needed until a consumer asks | ✅ decided |

## Inngest vs BullMQ (decision #7 detail)

- **BullMQ (Redis)**: job queue library. You write a worker process that pulls jobs. Retries, backoff, priorities, rate limits, **repeatable (cron) jobs** = our timers. Self-hosted, boring, full control. Long-running jobs fine — the worker just runs them.
- **Inngest**: event → function platform. Nice DX, built-in cron/retries/**durable multi-step workflows** (`step.run` survives crashes), fan-out. But functions are designed for serverless (time limits, no held state) — bad fit for hour-long agent turns. Self-hostable but more moving parts; or their cloud (dependency).
- **Verdict**: BullMQ for the queue + timers. Our "durable workflow" (thread state machine) lives in Postgres where we can query it. Revisit Inngest only if we later want serverless glue for intake/timers.

## Heyo facts worth remembering (from research)

- `exec(id, cmd)` = one fresh process per call, starts in `/`. Non-zero exit is a normal return value. **Its `cwd` option is not dependable across server versions** — always embed `cd <dir> && …` in the command itself (the HeyoSandbox adapter does this inside its wrapper; smoke-tested 2026-10-17: first smoke failed with "not a git repository" precisely because of this).
- Heyo timeout does NOT kill the guest command → always wrap with guest `timeout`.
- Stateful ≠ immortal: lifecycle is running → stopped (disk retained, `idle_action: retain`) → resumed → destroyed (`deleteDeployment` / `evictVm`). Disk survives restarts; nothing survives deletion.
- HWS ("Heyo Web Services") = control plane (like a mini AWS: manages VMs + plugins: secrets, image store, logs, git hosting, Postgres, queue). **Plugins attach to namespaces (tenants), not inside sandboxes.** A sandbox is just a VM.
- Docker *inside* a sandbox VM: possible in Heyo (full Linux kernel in Firecracker guest — bake Docker into the custom image; pattern proven by Docker's own "Docker Sandboxes" product). Also possible in modern E2B (they ship docker-in-sandbox templates). What nobody gives: nested *VMs* (VM-in-VM) without special hardware exposure.
- Heyo `heyvm wt` = worktree sandboxes: pairs a git worktree with a sandbox whose `/workspace` is that worktree — interesting for best-of-N / parallel-branch flows later.

## Tool call contract (decision #3 — enforce in every tool)

```
command sent to exec = timeout --signal=KILL <timeoutSecs> bash -c 'cd /workspace/repo && <actual command>'
```
- No reliance on state from previous exec calls (no `cd`, no `export`, no background jobs assumed alive).
- Files always referenced by absolute path or relative to /workspace/repo.
- Tool outputs truncated head+tail before entering model context (context management lives in one place).

## Best-of-N (decision)

**Fork point = after the reproduce phase.** One shared run writes the failing test + diagnoses the bug, commits a checkpoint, then N sandboxes fork from that commit and race the fix. Each attempt verifies against the *same* failing test → fair comparison, cheaper attempts. Config flag `--fork-from-scratch` kept as an escape hatch.

## Eval suite (decision)

Task spec (JSON): repo + base commit + issue text + setup/test commands + success criteria + budget.
Sources: SWE-bench Lite subset + seeded bugs in repos we control.
`harness eval` runs all tasks end-to-end → solve rate, $/task, p50/p95 time, failure-mode breakdown (repro-failed / wrong-fix / timeout / budget / loop / tool-error). Full JSONL trace per task.

## Secrets

- **Local dev:** `.env` file (gitignored). Real env vars override `.env`; `.env` overrides built-in defaults.
- **Production:** platform secret store (K8s Secrets / Docker secrets / Fly.io / AWS SM) → injected as **environment variables** at boot. No `.env` files on disk. On Heyo infra, the secrets plugin (write-only vault, `env_from` at VM boot) is the primitive.
- `HEYO_TOKEN` / `LLM_API_KEY` never leave the orchestrator. `GITHUB_TOKEN` is minted per-run, short-lived, one-repo-scoped (GitHub App installation tokens long-term); git creds live in `/etc/git-credentials` **outside** `/workspace`.
- Guardrails: trace redaction (no token-shaped strings in logs/DB), secrets never in VM images or repo copies.

## Open questions

- Webhook dedup: `X-GitHub-Delivery` + business-key unique constraints — confirm when implementing
- Which SWE-bench Lite subset (30–50 tasks) and how to handle per-instance setup images
- Toolchain image contents (git, node, python, ripgrep, docker?, test runners) — finalize when we know target repos
- Dashboard auth in production (v1 is localhost-only, no auth): token? behind Heyo's auth gate? decide when deploying
