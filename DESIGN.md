# DESIGN.md — Sailor, built on Anchor

> Living decisions log. Every entry: what was decided, why, and by whom. Update as we go.
> Earlier numbered entries preserve the design history. Decision #51 below
> supersedes the mandatory phase/test-gate and implicit-publication behavior.

**One-line pitch:** label a GitHub issue `agent:fix`, get a PR with the fix, passing tests, and a link to the full agent trace — all inside an isolated Firecracker microVM.

## Vocabulary (kept consistent everywhere)

- **Agent** — the LLM-driven worker that decides and acts.
- **Anchor** — the reusable agent framework: loop, tools, sandbox, context management, budgets, and traces. **`packages/core` (`@anchor/core`)** includes a coding profile with composed guidance and agent-controlled phases, but knows nothing about GitHub, Postgres, or Sailor.
- **Sailor** — the product built on Anchor: threads, queues, webhooks, GitHub, and dashboard. **`apps/server` (`@sailor/server`)** configures the coding agent with product identity and scoped publication tools; **`apps/dashboard`** is its UI.
- **This repo** — currently both (staging monorepo); at step 20 Anchor moves to its own repository and Sailor consumes its published package as consumer #1.

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
                                      turn = model → tools → observations → model
                                                        │ tools (bash, read_file, edit_file,
                                                         │        search, run_tests,
                                                         │        publish_changes, reply_on_github)
                                                        ▼
                                    Heyo microVM (Firecracker), /workspace/repo
                                    checkpoints = git commits (forkable)
                                    secrets injected as env at boot
```

## Repository layout — staging workspaces now, extraction later

npm workspaces with one package + two apps. Split by **runtime first, then domain**; one-way dependencies only: `apps → packages`. The package tree follows the framework layers: `engine/` is agent-agnostic; `agents/` supplies prompt components, descriptive approach phases, and capability bundles. No separate workflow engine or mandatory phase gates.

```
packages/core/   @anchor/core — the framework (publishable-ready from day one)
  engine/           loop, loop detection, budgets, context, events  (agent-agnostic)
  llm/              model transport (OpenAI-compatible + streaming)
  sandbox/          execution: interface + heyo + local backends
  tools/            capabilities: Tool protocol + the coding tool set
  agents/           built-in agents: strategy + tools bundles (coding, chat)
  trace/            structured events → JSONL + DB consumers
apps/server/     the product: cli, config, db, queue, worker, server, github, eval
apps/dashboard/   Vite + React (step 17) — consumes the sailor API over HTTP
eval/tasks/       data: eval specs        image/  toolchain VM Dockerfile
drizzle/          generated migrations    tests/{unit,integration}/
```

**Extraction plan (decided):** the workspaces are *staging*. After the eval suite (stretch, step 20), `packages/core` moves to its own repository, is published as a versioned package, and the sailor consumes it from the registry — the sailor becomes consumer #1 of the framework. Publishable-ready rules apply from day one: no imports from `apps/`, dependencies declared explicitly, clean `exports` map.

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
| 1 | Sandbox backends: `heyo` = the **only production sandbox**. `LocalSandbox` is a **dev/test implementation of the `Sandbox` interface**, injected via an explicit `--local` CLI flag or directly in tests — it is NOT a config type (`SAILOR_SANDBOX` deleted) | Mac can't run Firecracker (KVM is Linux-only), so dev needs a local implementation — but production must never silently fall back to unisolated execution. Test doubles are injected at the interface seam (and the Heyo SDK accepts a mock `fetch` for adapter tests) | ✅ refactored |
| 2 | Tools execute as self-contained shell commands in the VM via `exec` | Heyo `exec` starts fresh in `/` every call — `cd`/env don't persist | ✅ agreed |
| 3 | **Tool call contract**: every command must be self-contained (`cd /workspace/repo && …`) and wrapped with the Linux `timeout` utility | Heyo's `timeoutSecs` only bounds the API call — the guest process keeps running otherwise. `timeout --signal=KILL <s> bash -c '…'` gives real kill semantics | ✅ agreed — MUST be enforced in the tool definitions |
| 4 | Tools = thin structured wrappers over shell (not raw bash for the model) | `edit_file` = exact-string replace with verification; single truncation point; structured trace events; typed tool calls are more reliable for LLMs | ✅ agreed |
| 5 | Checkpoints = git commits in `/workspace`; resume = pull; fork = clone at sha | Maps to Heyo's own pattern; one mechanism covers crash-resume AND best-of-N | ✅ agreed |
| 6 | Secrets never enter `/workspace`. GitHub creds: short-lived, repo-scoped tokens, injected as env at boot (Heyo secrets plugin), git creds in `/etc/git-credentials` | Guardrail from spec; no leak via repo copy/log paste | ✅ agreed |
| 7 | Stack: **Postgres + Redis + BullMQ** (queue + repeatable/timer jobs) + Hono webhook intake + long-lived worker process for agent turns | Agent turns run minutes–hours → worker process, not serverless functions. Inngest evaluated; see tradeoffs below | ✅ agreed |
| 8 | GitHub auth: **fine-grained PAT** on a bot account for now; GitHub App later (product path) | PAT gets us to the demo fastest; the REST calls are identical either way, so nothing gets thrown away. (GitHub App = bot identity users install, no user OAuth involved; OAuth App is a different thing — user login — not needed) **Revisit trigger:** >1 repo / outside installs / checks-API needs — an App collapses per-repo webhook setup + PAT juggling into ONE app config + per-repo install, at the cost of JWT→installation-token minting (runtime code, not config); swap surface = the client's auth layer + where the webhook is registered — the pipeline (verify → dedup → triage → thread → PR) is untouched | ✅ decided: PAT |
| 9 | VM image: custom "toolchain image" (git + node + python + ripgrep + test runners baked in) published to Heyo artifact store | `heyo/debian` has no git/node/python; apt-get per run is slow + flaky. Image = like a Docker image, but boots as a VM | ✅ agreed in principle |
| 10 | Thread model: persistent record (Postgres) + inbox of events; one turn at a time per thread; coalesce incoming events; priorities: review comments > CI failures > chatter | Answers "review comments go to same agent thread" + dedup | ✅ agreed in principle |
| 11 | PR babysitting: event-driven (check_run/review webhooks) + cron sweep of open PRs; bounded by thread state machine + budgets (max turns, max $) | Catches dropped webhooks/flaky CI; can't loop forever | ✅ agreed in principle |
| 12 | LLM: provider-agnostic interface; OpenRouter/OpenAI-compatible first. **Streaming: single wire path** — every call is `stream: true`, `complete()` aggregates `stream()`, tool-call fragments assemble by index; `onDelta` feeds the trace and the chat SSE (step 18) | Swappable; all models reachable; one parser can't drift; token-level events for free | ✅ agreed |
| 13 | Dashboard: threads/runs view + trace viewer + **chat interface**. Chat messages reuse the thread inbox pipeline (`chat_message` event); replies in a `messages` table. `server/` hosts api + webhooks + dashboard in one Hono app; no auth v1 (localhost) | One pipeline for every trigger — GitHub comments, CI events, and chat are all inbox events. GitHub stays the primary conversation surface; chat is the operator window | ✅ decided |
| 14 | Realtime over **SSE** (not polling, not WebSockets): worker → Redis pub/sub → server → EventSource. Token batches = cumulative text snapshots flushed ~10/s (never per-token); streaming reply persisted as a `messages` row updated per flush; O(1) DOM updates — only the streaming node mutates | Snapshot semantics make events idempotent and gap-proof (no replay log, no deltas); batching + single-node updates kill re-render storms; refresh mid-stream loses nothing | ✅ decided |
| 15 | **Durable execution principles** on our own stack: DB-as-truth (no browser session state), journaled steps (`trace_events`), run lease + heartbeat with auto-resume from checkpoint, idempotent effects everywhere. No serverless/hosted durable-execution platform | Crash/deploy/refresh loses nothing; resumes without human action; honors the anti-Lambda reasoning of decision #7 | ✅ decided |
| 16 | Framework extraction: `packages/core` develops in-repo as an npm workspace (**staging**), then is extracted to its own repo and **published** (step 20); the sailor imports the published package as consumer #1. Publishable-ready rules from day one: no `apps/` imports, explicit deps, clean `exports` map | Separate repo = real boundary + own CI/docs/versioning; consumer-#1 proves reusability. Staging in-repo avoids cross-repo iteration pain during the build | ✅ decided |
| 17 | **Threads / cross-run memory — framework-first.** The package ships the generic capability now: `ThreadStore` interface + `MemoryThreadStore` default + engine integration (`thread` option loads prior turns, saves on every exit path; summary flows into the system prompt). `PostgresThreadStore` implements the interface in the app when step 11 consumes it; extraction (step 20) merely moves the repo. No DB dependency in the package, ever — the framework defines the shape, the consumer supplies the notebook (same split as LangGraph's `MemorySaver` vs `langgraph-checkpoint-postgres`; "checkpointer" is that vocabulary's name for the concept). Named **ThreadStore** throughout — ecosystem- and product-consistent language | Conversation memory across runs is generic (chat agents are the proof case, not just issue→PR). Built interface-first per review so the framework stays genuinely framework-shaped; product-specific continuity (GitHub lifecycle, dedupe, budgets, crash-resume) stays product-side | ✅ decided |
| 18 | **Compaction pulled forward into the engine** (was step 19): checked before every turn; chars/4 token estimate; oldest span folded into the running summary via one LLM call (usage counted in budgets); protocol-safe cut (kept span never starts at a `tool` message); system prompt regenerated; `compacted` event emitted; `compaction: false` disables | Threads live for days — without this they crash on context limits. Self-contained in `engine/`, so built early rather than deferred | ✅ decided |
| 19 | **Everything but the LLM is optional** (AI-SDK-style ergonomics). Defaults: `strategy` → `chatStrategy` (`finishWhenNoToolCalls`: a text-only turn IS the reply), `tools` → `[]`, `sandbox` → none; `codingStrategy` declares `requiresSandbox` (validated at startup, like `requiredTools`); tools that need execution fail gracefully via `requireSandbox()` when none is supplied. Single-call use = `llm.complete()` | Simple things simple, complex things possible: `runAgent({task},{llm})` is a chat loop; the same API with tools+sandbox+strategy is the coding sailor. The sailor becomes a *configuration*, not the only way | ✅ decided |
| 20 | **Guardrail inventory**: budgets, loop detection, text-only stall, compaction, finish gate, command timeouts, truncation, redaction. All built-in and always on by default (opt-in protections get forgotten), each with a dial: `budgets.*`, `guardrails.repeatedToolCallLimit` (default 3, `false` disables), `guardrails.emptyTurnNudgeLimit` (default 2, `false` = never stall), `compaction.*`, `validateFinish` (strategy hook). Interventions are `guardrail` events | Answers "what are guardrails, are they wired, are they attachable" precisely: wired ✅, dials ✅, and the one strategy-attachable piece (finish gate) is a hook. Full user-defined guardrail middleware is deliberately not built — not needed until a consumer asks | ✅ decided |
| 21 | **Best-of-N placement — capability in the package, policy in the app.** Package: `Sandbox.fork(ref)`, engine `pauseAfterPhase` (graceful stop at a phase boundary returning resumable state — shared with step 9's crash-resume), and `runBestOfN({ attempts, forkAtPhase, judge })` with a **pluggable judge** (default: tests-passed → smallest diff → cheapest). App: the `--best-of` flag, race budgets, attempt rows in `runs`, per-attempt traces, winner's PR, loser cleanup, eval reporting | Same layering rule as #17/#19. It's also not always-on: opt-in for the hard tail, since it costs N× compute. Judge stays objective (tests are the hard filter) with the smallest-diff heuristic's limits documented | ✅ decided |
| 22 | **Durable turns split (step 9):** package = `pauseAfterPhase` + per-turn thread persistence + `StoredThread.phase` (resume position) + boundary checkpoints + `Sandbox.fork(ref)` (clean state at the ref; uncommitted changes not carried). App = `heartbeat_at`/`messages`/`phase` columns + lease helpers + `sweepStaleRuns` (stale → interrupted → resume enqueued, race-safe). Resume is **state-based rebuild** (thread + checkpoint + journal), never VM resurrection — so it works identically on local/heyo/E2B. The end-to-end worker-kill demo lands with the worker (step 10) | Keeps the framework/app line intact: the engine knows how to pause/resume; only the product knows about heartbeats, sweeps, and queues. Also gives best-of-N (step 14) its primitives for free | ✅ decided |
| 23 | **Turn taxonomy on a thread.** Thread = memory + identity (lives long); a run = one unit of work with a *chosen strategy* (short); phases live inside one run. The resume position (`phase`) survives only for unfinished work: crash → last per-turn phase, pause → next phase, completed run → **cleared** (follow-ups start fresh phases over the same conversation). Mid-run messages queue in the inbox (one-turn-at-a-time; cancel via `signal` for "stop now" — abort ends the run with reason `"cancelled"` at the next turn boundary; mid-command abort is a future refinement). The product controls where a run starts explicitly (`startPhase`), which is how interjected work is resumed at the phase it was interrupted in (the run result reports its ending `phase`). A question can be a **chat-shaped run on the same thread**. Triage of "question vs work vs resume" is product policy (steps 12–13); per-strategy phase maps noted for when mixed strategies on one thread become common | Answers "one phase machine can't fit every turn": it doesn't have to — strategies are per-run, memory is per-thread, and the resume position only tracks unfinished business. The product owns the AbortController; the engine just honors it | ✅ decided |
| 24 | **Worker + lease coherence (step 10).** `sailor worker` consumes the runs queue (concurrency 1) and drives the sweep as a BullMQ 6 Job Scheduler; `executeRun` is a reusable, injectable executor (heartbeats, cancel registry, dual-sink traces, status/usage/checkpoint recording); `PostgresThreadStore` pulled forward from step 11. **Lease rule: `staleAfterMs ≥ 1.5 × heartbeat interval`, validated at startup** — the live demo found the flaw (3s threshold vs 30s cadence → the sweep ate its own live run). BullMQ's stalled-job redelivery is a second recovery net for hard-killed workers — both mechanisms were observed recovering the same kill, and both resume runs succeeded | The kill-the-worker demo is the proof the durability story works end to end; the coherence rule prevents the one failure mode the demo surfaced | ✅ decided |
| 25 | **Cross-process cancel — the interjection primitive.** `cancelRun` = in-process fast path (the worker's own controller registry); `requestCancel` = durable flag on `runs.cancel_requested_at`, settable by ANY process (webhook server, chat API, CLI); executeRun's watcher (default 2s tick) aborts at the next turn boundary → reason `cancelled`. `createRun` extracted as the one door new runs enter (DB row = truth, queue job = doorbell) | The interjection handler lives in a different process from the worker — an in-memory abort button would have silently done nothing. Now the stop is durable and observable. Redis pub/sub noted as the sub-second-latency upgrade | ✅ decided |
| 26 | **Threads wired (step 11):** inbox (`appendEvent` — webhook or internal; `pendingEvents` ordered; `consumeEvents` = coalescing by batch), `wakeThread` with **DB-enforced one-turn-at-a-time** (partial unique index `runs_one_active_per_thread` on status in queued/running — race-safe by construction, not check-then-act; concurrent wakes create exactly one run, proven), lifecycle state machine with validated transitions (PR states wired by steps 12–13), sweep tolerates the unique conflict (skips; the active run owns the turn). Events carry an optional webhook delivery GUID (migration 0005) | Two webhooks arriving simultaneously must not spawn two turns — the database guarantees it. Events sit in the inbox while a run is active; the next turn consumes the batch. The new index also caught an illegal state in a test (two running runs on one thread) — working as intended | ✅ decided |
| 27 | **Inbox drain — queue semantics made real.** `drainInbox`: events that arrived while a run was active become ONE new run when the thread goes idle (coalesced task via a minimal batch renderer; trigger `inbox`; events consumed once the run exists — the instruction survives in `runs.task`). The worker drains after every run. **Default = queue for machine events; interjection is explicit** (refined by #28: external reviews — any author — and human events interject; self events are context-only). Real triage — strategy choice + per-kind rendering — arrives with steps 12–13 | Answers "queued or interjected?" precisely, and closes the hole where a queued event could have waited forever after the busy run ended: nothing was consuming the inbox post-turn. Now the cycle is: comment → inbox → run ends → drain → next run whose task IS the comment | ✅ decided |
| 28 | **Interjection policy — self vs external + semantics, with explicit override.** **INTERJECT (busy threads):** external **reviews** (`pull_request_review` + review comments — ANY author: human or review bot — CodeRabbit, Copilot review…) and human messages/comments. Humans and reviewers get heard NOW — the agent must never finish work they just redirected. The axis is NOT human-vs-bot (a review bot's review is real feedback); it is **self vs external** + event semantics. **QUEUE: machine events AND self events** — check_run/CI, sweeper nudges, non-review bot chatter, and our own pushes/comments/PR edits (**not suppressed** — waking on them is fine and expected). **The act-vs-note call is the AGENT's — the router renders, it does not pre-decide:** self push → "no action needed — acknowledge that it landed" (a short thread message; acks never write to GitHub, so echo chains terminate after one ack — per-thread budgets backstop); other bots' events → "fix it if it needs fixing, comment if a clarification is the right response, otherwise note it". **Explicit override — the Cursor-pattern Interject button:** the dashboard exposes one on any pending event (machine events included); it takes the same one path (`requestCancel` + the event becomes the next turn — the post-turn drain turns it into a run). Chat surface (step 18): a send interjects (human-authored); the earlier Enter=queue / double-Enter=interject sketch reconciles there — a "queue instead" affordance can ship with that UI. Identity + semantics are deterministic (`sender.login` vs our bot, `sender.type`, event kind) — no LLM needed for the primary call; triage (12–13) still chooses strategy/task-rendering and the subsumption decision (same-goal interjection replaces the interrupted continuation; side-questions keep it). Optional later refinement: triage may DOWNGRADE obvious non-actionable chatter ("thanks!") to queue | Per review (three rounds): botness alone must not disqualify an event (review bots post real feedback); self events must wake and be seen (push confirmations), not suppressed; and act-vs-note belongs to the agent — the router renders expected behavior, the agent judges. Loop-safety by output discipline: acks write to the thread, never GitHub, so echo chains terminate; per-thread budgets backstop | ✅ decided |
| 29 | **Built-in agents as bundles (`agents/`).** Each built-in agent is a folder: `strategy.ts` (+ agent-specific helpers like `repomap.ts`), `tools.ts`, and an `Agent` preset `{ name, strategy, tools }` — `agents/coding/`, `agents/chat/`. The engine accepts `agent: codingAgent` as a shortcut; explicit `strategy`/`tools` still work and override the preset per-field. Tool *implementations* stay in the shared `tools/` library; the agent's `tools.ts` curates its list — deliberate, not `allTools` — so the registry growing never silently widens an agent | The two options on the table coexist: importing one agent gets strategy+tools (zero-config); custom agents are the same primitives configured separately. Capability stays shared; policy + composition live with the agent. Also matches the ecosystem shape (an "Agent" ≈ instructions + tools) | ✅ decided |
| 30 | **GitHub door wired (step 12).** `sailor serve` (Hono): HMAC-verify the RAW body → delivery-GUID ledger (at-least-once → exactly-once) → `issues: labeled agent:fix` → find-or-create thread (`source: github`, `baseRef` = repo default, `headRef` = `sailor/issue-N`) → append event → wake with the issue rendered as the task (consumed when the wake succeeds; parked + drained when busy). PAT client (getIssue / createPullRequest / whoami; injectable fetch). **PR delivery** after a succeeded run, BEFORE the sandbox dies: `git push --force origin HEAD:refs/heads/sailor/*` (guard refuses the base; credentials already installed by the sandbox layer) → PR = summary + trace link (`/threads/:id?run=:runId`) → thread `pr_open`; a delivery failure is recorded on the run, not fatal. `wakeThread` refuses terminal threads (**open question resolved**). Triage classifier (#28) implemented + unit-tested; wired for `labeled` now — comments/reviews/checks get their handlers in step 13 | The label→PR promise now exists end-to-end and is mock-e2e proven (signed webhook → DB rows → push to a real bare origin → fake API); only the live demo needs the real token/secret | ✅ decided |
| 31 | **Run dispositions + watch requests WIRED (package + app).** `finish` gains optional `disposition` (`done`/`watch`/`blocked`), `watch` (product-defined spec), `resumeAt` (phase id). Engine: validates `resumeAt` against the strategy's phases (rejecting like `validateFinish`), defaults the disposition ("watch" when a spec is present; else done/blocked from success), carries all three on `AgentResult` + the `run_finished` event, guards that a malformed finish call can never end a run — and the key semantic: **a watch finish keeps the thread's resume position at `resumeAt` instead of clearing it**, so any later wake starts right there via the existing startPhase/thread-phase machinery. App: `runs.disposition` + `threads.watch` columns; any other declared conclusion clears the standing watch; worker logs `[watch → resume at fix]` | Makes babysitting **agent-shaped** ("I'll suspend here; wake me when CI settles; resume at fix") with zero sleeping runs — the loop still ends, only the resume pointer persists. Zero new machinery: reuses decision #23's resume-position contract end to end | ✅ decided |
| 32 | **`finish` is an engine intrinsic — not a consumer tool.** The engine injects finish into every run's tool list on top of whatever was supplied; a consumer tool named `finish` is ignored; `intrinsics: { finish: false }` opts out. Dropped from `allTools`, `codingTools`, and `codingStrategy.requiredTools` — consumers never list it, strategies never require it (the prompt still describes it; `validateFinish` still adjudicates). Runs can still end by text (chat), budgets, or stall when opted out | The model can only call what the wire protocol declares — but *who declares it* is ours: like `return` in a language, ending a run is the engine's contract, not a capability consumers must remember to wire. Kills the "forgot to add finish" footgun class; the registry now contains only true capabilities | ✅ decided |
| 33 | **Agent-requested transitions WIRED — the coding agent's fix→verify is now one.** New intrinsic `request_transition({to, reason})`, injected only when the strategy adjudicates (`onTransitionRequest`) or a phase uses `advanceOn: "agent_request"`. Engine: validates the target phase, adjudicates with the evidence log (same propose/dispose pattern as `validateFinish`), feeds rejections back as tool errors, applies accepted moves with a checkpoint + phase message (protocol-safe ordering: tool_result THEN phase message), honors `pauseAfterPhase` at the boundary, emits `transition_rejected` guardrails. `advanceOn` accepts an evidence predicate OR `"agent_request"`; phase-budget nudges hint at `request_transition` for request-phases. Coding strategy: `fix` no longer auto-advances on a passing suite; the agent requests `verify` (adjudicated: last full-suite run must be green); backward moves (verify→fix with a failing run on record) allowed | The agent knows when the fix is actually done — a mid-fix suite run can no longer teleport the phase — while the evidence still disposes. `reproduce` stays fully evidence-driven: the selectable-source model from the design discussion, now real | ✅ decided |
| 34 | **Trusted transitions by default (package principle).** Any multi-phase strategy gets `request_transition`; with no `onTransitionRequest` policy the agent may move on — **allowed, never blocked, and recorded** (`via: "agent_request_unverified"`, tool meta `unverified: true`). Policies hard-gate by providing the hook (the coding agent's fix→verify keeps its green-suite adjudication). The only hard gate is the **success claim** (`validateFinish`) — strategy-owned, always escape-able via `finish(success=false)` → blocked → human — because it's the product's outcome contract, not a control wall. Phase-budget nudges offer the escape at the right moment ("you may request_transition to move ahead — the escape will be recorded") | A phase whose evidence never appears must not trap work that later phases could do; framework defaults shouldn't wall agents in based on the author's guesses. Moving on = autonomy (visible in traces); claiming done = evidence. Correcting a review concern: hard-gating *everything* was the scary part — the fix isn't less rigor, it's putting rigor where the contract is | ✅ decided |
| 35 | **Control surface simplified: `advance` + `finish` — checks, not predicates (supersedes the mechanics of #33; keeps #34's trust default).** `advanceOn` is gone — phases never advance automatically. The agent calls `advance()` (default: next phase; `to` for jumps/backtracks); each phase may carry an optional `validateAdvance({to, reason, evidence})` deciding whether the move is allowed; absent = trusted + recorded (`via: "advance_unverified"`). `onTransitionRequest` is gone (per-phase checks replaced it). `request_transition` renamed `advance` (to/reason optional), injected for any multi-phase strategy. `finish` unchanged — the stop verb; `validateFinish` the success gate. Nudges unified. | Two verbs on one axis: continue (advance) vs stop (finish) — never redundant, they are the two decisions an agent makes, now with ONE mechanism per decision and zero advance config. The "a mid-phase tool result teleports the phase" bug class is structurally gone | ✅ decided |
| 36 | **Checks delay moves; they never trap the loop.** `advance({force: true})` overrides a denied `validateAdvance` — the check still runs, the denial downgrades to a recorded override (`via: "advance_forced"`, a `check_overridden` guardrail event, the check's reason in the tool result), and the move happens. Nudges surface the escape for checked phases after overstay; the coding prompt mentions it. The success claim (`validateFinish`) remains the one hard gate — with `finish(success=false)` → blocked as the always-available honest exit | ANY check, however well designed, can be unsatisfiable in situations its author never imagined; a framework must never let a condition own the loop's life. The agent always retains a way forward — explicit, attributed, visible in traces — while the outcome contract stays honest. Correcting the earlier framing: baseline-relative evidence fixes the *coding agent's outcome*; this fixes the *framework's liveness* | ✅ decided |
| 37 | **Checks are just functions — async, capability-full.** `validateAdvance`/`validateFinish` may be async and receive an `AdvanceCheckContext` (target, reason, evidence, the run's `sandbox`); a check can run its own verification, invoke a tool, or call anything the host can reach — e.g. an external approval API the sandboxed agent cannot. A throwing check is a denial (error as the reason), not a crash. Checks are ALWAYS developer-supplied (strategy code) — never a tool parameter the model fills in, or the model would pass its own gate; `to`/`force` remain the agent's params | "Check" stops being a special mini-language and becomes what it is: an ordinary function with the same powers as the rest of the strategy. Corrects the read that `check` belongs to the advance tool's schema | ✅ decided |
| 38 | **Freshness-verified evidence — the coding agent's checks use the sandbox (first real use of #37).** `run_tests` records `meta.treeHash` (working-tree content hash via `git add -A && git write-tree`, best-effort); the fix→verify check and `validateFinish` **recompute it through the sandbox at move time** — a green run whose tree has since changed is stale and doesn't count. `validateFinish` now receives a `FinishCheckContext {evidence, sandbox}`, mirroring advance checks. Cost: two `git` calls per gate — no suite re-run | Closes the stale-evidence hole (green run → edit → claim) that pure evidence-log inspection can't see, and proves #37's capability pays for itself. No git → evidence-only fallback | ✅ decided |
| 39 | **A phase reads `check` + `allowForce` (naming from review).** `validateAdvance` → **`check`**; `validateFinish` → **`checkFinish`**; and each phase may set **`allowForce`** (default true, decision #36) — "may the agent override a denial with `advance({force: true})`?". `allowForce: false` makes a gate absolute: satisfy the check, or exit via `finish(success=false)` → blocked; the nudge only offers the force hint when the phase allows it; the advance tool documents the restriction. The coding agent sets `allowForce: true` on every phase, explicitly — its outcome contract lives at `checkFinish`, so movement stays escapable | The phase definition now literally reads as the review asked: `check` (any function) + `allowForce` (true/false). Deliberate absolutes are possible but opt-in, never the default | ✅ decided |
| 40 | **PR babysitting wired (step 13).** Webhook handlers: `check_run`/`status` failures → queue; reviews + review comments (ANY author) and human comments → **interject** (durable `requestCancel` on the active run; the event parks; the post-turn drain resumes the batch at the cancelled run's ending phase — subsumption); self pushes → queue + "no action — acknowledge" render; `pull_request` closed → merged/closed terminal (+ cancel any active run). The 10-min sweep (`worker/babysit.ts`, Job Scheduler id `babysit-prs`; targeted via `threadId`): terminal detection, **merge conflicts (no webhook exists)**, failed checks, unanswered comments (newer than the last run, excluding the bot); `threads.watch` narrows, budgets cap, active runs defer, pending findings dedupe. Renderer (`github/render.ts`) is the one #28 voice — shared by webhook, drain, and sweep. Follow-ups clone the PR branch (`sandboxSpecForThread`) and `deliverPullRequest` pushes updates to an existing PR in place. `blocked` → PR/issue comment + `agent:needs-input` label. Client gains getPullRequest / getCheckRuns / listIssueComments / commentOnIssue / addLabels | Completes the issue→PR lifecycle: the agent now reacts to the world after the PR opens, exactly per decisions #27/#28/#31 — and the cleanup paths (terminal states, budgets, dedup, one-turn deference) make it safe to leave running | ✅ decided |
| 41 | **Accounts: Sign in with GitHub via the SAME GitHub App (user-to-server OAuth).** First login = signup (upsert on `github_user_id`). **Amended by #44:** both email+password (**argon2id**) and GitHub sign-in are supported — originally "no passwords, ever", revised at the user's request; argon2id keeps the stolen-DB-is-expensive property. Sessions: 32-byte random token; cookie `httpOnly`+`Secure`+`SameSite=Lax`; the DB stores only `sha256(token)` — a leaked DB can't replay sessions. User GitHub tokens are used once (profile fetch) and never persisted. App private key + client secret are *deployment* secrets (env / platform secret store), never DB. `DEV_AUTH_BYPASS` documented dev-only, loud at startup, for UI iteration without GitHub | Answers "how do we store user secrets securely?" — by not holding them (and by hashing the one secret users do give us). Model: `users`, `sessions` | ✅ decided |
| 42 | **GitHub auth swaps PAT → GitHub App.** JWT (RS256, app private key) → per-installation access tokens (~1h, cached with refresh); `GitHubAppService.clientFor(installationId)` replaces the single static client (still test-injectable — fakes unchanged); webhooks become **app-level** (one secret on the App; every payload carries `installation.id`); `threads` gain `user_id` + `installation_id` (webhook → installation → user); sandbox git credentials = the installation token for that run; bot login is derived (`{slug}[bot]`) — `GITHUB_BOT_LOGIN` and `GITHUB_TOKEN` retire; onboarding binds the installation to the user via the install `state` param, with the `installation` webhook's `sender` as the fallback binder | The PAT pattern doesn't survive the dashboard anyway (per-repo webhooks, one shared token, personal-account identity); the App gives install-per-repo, token scoping/expiry, and the real product onboarding. The swap surface was contained — exactly as DESIGN #8 predicted | ✅ decided |
| 43 | **Local dev story.** Without an App: everything remains testable via fakes/fixtures (that's how all current tests run) and `DEV_AUTH_BYPASS` unlocks the dashboard UI for iteration. For anything touching REAL repos, a free **dev GitHub App** (~3 min) is required — installation tokens are the credential to clone private repos and push. Dev-App checklist: callback `http://localhost:8787/auth/github/callback`, setup URL `http://localhost:8787/setup`, webhook `<tunnel>/webhooks/github` + secret; repo permissions = Contents RW, Issues RW, Pull requests RW, Checks R, Metadata R; events = issues, issue_comment, pull_request, pull_request_review, pull_request_review_comment, check_run, status, push, installation, installation_repositories; generate a private key; install on your test repos | "How do I test without an app?" — split answer: no app needed for the engine/tests/UI; an app needed the moment real repos are involved (the agent must pull them). One dev App serves all local testing | ✅ decided |
| 44 | **Repo selection is THE gate + both sign-in methods + the dashboard app exists (step 17a).** Onboarding: install App → `/setup` links the installation to the logged-in user (install `state` param; `installation` webhook `sender` fallback) and syncs the install's repos **disabled by default** → user picks repos → `repositories.enabled`. **Every** webhook except `installation`/`installation_repositories` checks `repoEnabled(installation_id, repo)` first — unselected repos are recorded in the delivery ledger and ignored, so labels on unrelated repos never become work. Accounts: email+password (**argon2id** via `@node-rs/argon2`) AND GitHub sign-in; `users.email` / `password_hash` / `github_user_id` all nullable; a GitHub verified email matching an existing account links onto it (one user row, both methods). Sessions per #41. Login + onboarding UI live in `apps/dashboard` — **Vite + React + Tailwind v4** (decided here), dev server :5173 proxies `/api /auth /setup /healthz` → `sailor serve` :8787; the design still serves 17b's dashboard. `installation` webhooks upsert/suspend/delete the row; `installation_repositories` syncs added/removed | The product question "what does the agent watch?" now has an answer the user controls end-to-end, and both sign-in styles work without weakening either (no PAT, no stored GitHub tokens, argon2id for passwords) | ✅ decided |
| 45 | **The dashboard is wired (step 17b) — nudge, never payload.** REST (`/api/threads`, `/api/threads/:id`, `/api/runs/:id`) is the whole truth; **SSE carries only `{threadId}` nudges** — the worker publishes on every trace write + status change (Redis pub/sub), serve's subscriber fans them out to the clients watching that thread, and serve-internal writes (webhooks, API actions) notify the hub directly. The client debounces + refetches, so the stream can drop/duplicate freely and the UI cannot drift from Postgres (#14). Actions reuse existing primitives: **cancel** = the durable flag (#25) for a running run, a direct status flip for a queued one (plus an executor guard: a cancelled-before-start run never executes); **keep sandbox** = new `runs.keep_sandbox` column re-read right before destroy (a flip while running wins the race); **Interject** = #28's explicit override (running → cancel the active run so the pending event becomes the next turn; idle → drain now). The PR trace link `/threads/:id?run=:runId` renders that run's full trace (phases, LLM turns, tool calls/results, guardrails, checkpoints, finish). Visibility v1: owned threads + installation-less dev threads (real multi-tenant scoping comes with the public launch). `npm run dev` starts the complete stack (compose + migrate + serve + worker + dashboard) | One mental model for the whole product: **Postgres is the truth, Redis is the doorbell, the browser renders what it reads** — no client-side state machine to drift, no bespoke action paths, and the same primitives the webhooks use | ✅ decided |
| 46 | **`Sandbox.hasChangesFrom(ref)` — the tree-vs-commit comparison is an interface method now (trees, never commits).** Promoted from the product fix for the 2026-10-18 push↔wake loop: checkpoints legitimately create commits at every phase boundary *without* changing content, so *"new commits ⇒ new work"* is never a valid inference. The knowledge belongs with the checkpoint mechanism — the sandbox — so every backend implements it (Local + Heyo, same git semantics) and every consumer (delivery, CI triggers, webhooks) gets the correct comparison out of the box instead of rediscovering it. Semantics: compares the **staged tree** against `ref^{tree}` (uncommitted work counts); `origin/<branch>` refs get a best-effort fetch first; unresolvable ref or git failure **fails open → true** (never silently drop a delivery). `pr.ts`'s delivery collapses to one call; conformance test seals the trap at the interface (checkpoint-only → false, real edit → true, stale-tracking-ref refresh → true, missing ref → true) | Mechanism → package; policy → product, as decided in the same-day discussion. A consumer built tomorrow on `@anchor/core` cannot fall into this loop by construction, and the package's resume contract (unconditional checkpoint commits) stays untouched | ✅ decided |
| 47 | **The UI is a designed system now (step 18/18b) — skill-driven, Animate UI primitives, live chat.** The **ui-ux-pro-max skill** (vendored under `.opencode/skills/`, its output persisted at `design-system/sailor/MASTER.md`) drives the direction: *"Code dark + run green"* — slate-OLED palette, run-green CTA (`#22C55E`, dark-on-green text), JetBrains Mono headings/code + IBM Plex Sans body, dense dashboard scale, stagger-list motion, and its anti-pattern list is binding (no emoji icons, 150–300ms transitions, visible focus, 4.5:1 contrast in both schemes, no layout-shifting hovers). **Animate UI** (shadcn distribution) supplies the animated primitives: Sidebar chrome, Switch, Tabs, Tooltip, Dialog, Sheet, Progress, Copy; components are own-code in the repo (copy-first, restyleable). **Chat is the thread**: humans from `events`, the agent from its per-run final text (trace), system notes for label/CI/push — the engine's protocol chatter never renders. **Composer policy:** Enter queues the message (inbox event, #28 semantics), Enter again (or the Interject chip) promotes it via the existing event-interject endpoint — the double-Enter sketch, reconciled with zero new machinery. **Token streaming:** `sailor:live` carries compact projections (cumulative text ~10/s per #14, phase moves, tool call/result, finish) from the executor through Redis to the same SSE stream; the client renders a caret bubble and reconciles on nudge-refetch. **No `messages` table** (deviation from the original plan): events + traces + the live projection already are the record | The dashboard finally looks and behaves like the product it fronts — and the design rules live in one persisted artifact, so future views have a constitution instead of a palette guess | ✅ decided |
| 48 | **A run remembers WHICH agent takes it — chat turns are chat turns (from the same-day UI review).** New `runs.agent` column (default `coding`): `drainInbox` classifies the batch — nothing but `chat_message` events → **chat agent** (`chatStrategy` + the coding tools: one `respond` phase, a text-only reply ends the run; tools stay available so it can read the repo or act when asked); any GitHub/machine event → **coding agent**. Webhook-delivered turns are coding; crash resumes inherit the original run's agent. Cross-strategy resume is safe by construction (unknown saved phase → the strategy's first phase). Closes the review finding *"I asked 'what did you do' and got the whole reproduce→fix→verify loop"*: a question now produces a conversational reply, and its trace is a clean single-turn `respond`. **Restraint pass in the same breath:** status pills = neutral + one semantic dot (only `running` is tinted — color carries meaning, not decoration); consecutive push notes merge (`×N`); system events render as quiet centered hairlines; agent messages are plain text with an avatar (no boxes), user messages are right-aligned bubbles. **Honest accounting:** `threads.turns_used` increments per run; `usd_spent` accrues each run's cost — the rail is no longer cosmetic | The review's core insight — mechanics and conversation were conflated — is fixed at the source: the agent is a property of the work, not a hardcoded pipeline; and the thread finally reads like a conversation with an engineer, not a CI log | ✅ decided |
| 49 | **The Trace tab is a whole-thread span explorer (from the same-day UI review, LangSmith-inspired).** `GET /api/threads/:id/trace` ships every run + all spans + **thread-level totals** in one payload — token deltas excluded (reconstructable, payload-dominating) and tool output trimmed to 4k for transport. The client builds the tree (run → phase → agent step → tool call; tool results paired by name; guardrails/checkpoints/errors attach to the innermost open container; missing durations estimated from sibling chronology, marked `~`) and renders it LangSmith-style: tree pane with status dot, token chip, duration, and an aligned **mini waterfall bar** per row; detail pane with **Input / Output / Metadata** (agent text as markdown). `?run=` focuses a run (PR links + conversation chips land correctly); the header shows runs (coding/chat), tokens, cost, wall time, turns. Not a general tracing backend — a faithful render of exactly what we record. | Review verdict accepted: per-run trace + scattered thread stats had no novelty in the UI; ONE tree over the thread, aggregates on top, detail on the right is the honest way to show recorded truth | ✅ decided |
| 50 | **Names: the package is Anchor (`@anchor/core`), the product is Sailor.** From the naming session: the framework gets its own brand — Anchor, scoped `@anchor/core` on npm (the unscoped name is taken; the `@anchor` scope is empty), directory `packages/core`, sandbox scratch dir `.anchor/sandboxes`, sandbox ids `sb-anchor-*` — and the product becomes Sailor: root workspace `sailor`, backend `apps/server` (`@sailor/server`, CLI bin `sailor`), UI `apps/dashboard` (`@sailor/dashboard`). One sweep carried the vocabulary everywhere: env prefixes (`SAILOR_PORT`, `SAILOR_PUBLIC_URL`), Redis channels (`sailor:updates`/`sailor:live`), session/oauth cookies (`sailor_session`, `sailor_oauth_state`, `sailor_install_state`), PR branches (`sailor/issue-<n>` from `headRefFor`), the local Postgres role/database (`sailor`, data preserved by ALTER), the wordmark, UI copy, docs, and the design constitution (`design-system/sailor/MASTER.md`). External names stay until changed at their source — the Heyo namespace (scoped to the existing token) and the GitHub App slug (`repoinbox-dev`); `HEYO_NAMESPACE`/`GITHUB_APP_SLUG` follow afterwards. The push guard accepts both `sailor/issue-*` and pre-rename `harness/issue-*`, so the already-open PR keeps being babysat on its branch | Package and product need distinct, non-overlapping identities before more features pile on: one framework anyone can embed ("Anchor — build agents that can do the work"), one workspace it powers ("Sailor — from issue to reviewable change") | ✅ decided |

## Decision #51 — agent-led execution, phases as approach, composed prompts

The runtime is one model/tools/observations loop. It does not reject completion
for missing test evidence or force a reproduce/fix/verify itinerary. A final
response ends an assistant turn, not a verification certificate or publication.
This supersedes the workflow-gate and implicit side-effect portions of the
earlier decisions; no legacy workflow runner is retained.

- **Meaningful phases:** understand → act → validate → respond describe a
  useful approach. `set_phase` records the agent's progress, permits skipping
  and revisiting, and never imposes evidence gates. Caller-controlled pauses,
  budgets, cancellation, sandbox isolation, and tool capability bounds remain.
- **Composed behavior:** the coding profile assembles named character/tone,
  judgment, operating rules, verification philosophy, phases, and context.
  Sailor specializes that exact profile with product identity and GitHub tools,
  rather than duplicating the agent or maintaining a different chat personality.
- **Honest task grounding:** the current request is the latest real user
  message. Internal controls are explicitly distinguished from conversation;
  normal runtime history handling does not guess by text prefix. A separate
  backed-up repair command cleans known historical orchestration directives
  from idle threads only, preserving the immutable trace journal.
- **Explicit side effects:** only `publish_changes` publishes and only
  `reply_on_github` posts a discussion reply. Repository selection is checked
  again at that boundary. Current-tree test evidence is reported independently;
  unverified new PRs are drafts. `SAILOR_REQUIRE_PASSING_TESTS=1` can withhold
  publication without keeping the conversation trapped in a retry loop.
- **Timeout truth:** Heyo runs commands as deadline-bound guest jobs observed
  with short API calls. Launches are not blindly replayed, unknown completion
  is not called a confirmed kill, and output collectors are supervised too.
  Live VM tests require an explicit `RUN_LIVE_HEYO_TESTS=1`.
- **Debug display:** ⌘⇧D / Ctrl+Shift+D reveals expandable tool input/output
  and red failure details, without changing agent permissions or behavior.
- **Conversation-loop corrections (same review):** dashboard sends queue and
  never cancel — the queued chip (phase row) carries Interject and, on hover,
  per-message withdraws; interjected messages land in the thread animated.
  Interruption is the explicit `/interject` action, matching the composer
  policy (#47); chat turns carry reply framing — answer first, then
  unfinished work continues after the reply unless the message redirects it;
  and after consecutive
  silent tool turns the engine may inject a runtime-only **materialization
  advisory** (`guardrails.toolOnlyNudgeLimit`, default 8, `false` disables) —
  advisory, dialable, never a gate. Reasoning is journaled, shown in chat and
  trace, never resent to the model; compaction is derived from the model's
  real window (fold at ~55%, clamped to the 200–300k working range with a
  recent-quarter tail; static 256k/64k only when the catalog is unreachable)
  so switching models cannot silently break or overrun it. It keeps
  findings instead of folding them into a re-read loop, and renders in the
  thread as an expandable handoff — fold counts, the summary carried forward,
  and (debug mode) the folded transcript.
- **Budget dials:** engine defaults stay conservative package policy; Sailor
  raises them for long-horizon work (`SAILOR_MAX_STEPS` / `SAILOR_MAX_TOKENS` /
  `SAILOR_MAX_USD`, defaults 300 / 150M / $5 per run — a fraction of the
  thread's $25 so revivals have room; overnight 1200 / 400M / 50. Defaults
  assume deepseek-flash prices: on a pricier model dollars bind first).
  Cumulative tokens grow with every call no matter how well compaction bounds
  the per-call context, so steps and dollars are the real dials — the token cap
  is only a runaway backstop.
- **Sandbox continuity (A + B):** live GitHub threads retain their sandbox and
  the next run adopts it (same workspace, edits intact); turn-boundary
  checkpoints are force-pushed to a `*-checkpoint` side branch the push webhook
  ignores, so a destroyed VM never loses the work. Terminal threads release the
  VM. Retention/adoption/push are Anchor capabilities, dogfooded through the
  package's own `openSandbox`/`releaseSandbox` lifecycle; the policy is
  Sailor's.
- **Toolchain image (step 16):** the sandbox stops being `heyo/bun:latest` —
  `image/Dockerfile` (Ubuntu 24.04 + Python/pip/pytest + Node 22 + build
  essentials + ripgrep) is built and pushed to the namespace's artifact store
  (`harness/sailor-toolchain:latest`) by `image/build.sh`. A VM boots able to
  run real test suites; `sailor sandbox smoke --toolchain` is the check.

## Decision #52 — SDK naming: say the noun, verb first

Public names must decode at a glance, the way you would say them out loud —
no internal metaphor in an export. The package's existing names already pass
this test (`runAgent`, `openSandbox`, `releaseSandbox`, `createLLMClient`),
and the provider refactor must not regress them: the review sketch's
`openWorkspace` and `runLifecycle`/`createRunner` never ship.

- **One noun per concept, everywhere:** the type is `Sandbox`, so the
  functions say `Sandbox` (`openSandbox`, `releaseSandbox`) — not
  "workspace", "session" or "runner". Internal helpers may be named anything;
  only exports face this test.
- **Verb + noun for actions:** `runAgent(task, opts)` — the loop and its
  lifecycle (sinks, heartbeat, `shouldCancel`, budgets) are options of one
  function, not a second `createRunner` object; `openSandbox({...})`,
  `releaseSandbox(handle)`, `planRevival(result, budget)`.
- **Options over compositor helpers:** `traceSinks: [jsonl, pg]` for the
  common case; a compose helper exists only if composing is genuinely awkward.
- **Providers are brand nouns behind subpaths:** `heyo({...})`, `local()`,
  later `e2b`/`daytona`, imported from `@anchor/core/sandbox/<name>`; the
  registry takes provider objects, not string enums.
- **Settled renames from the review sketch:** `SandboxHandleStore` →
  `SandboxStore` (where a thread's retained handle lives); `teeSinks` and
  `createRunner` are not exported.

## Decision #53 — The provider seam shipped: capabilities are promises, the conformance suite is the acceptance test

Phase 2 landed as PR #1 (merged, `e5413d9`). One contract —
`SandboxProvider` (`name` as a free-form string, `capabilities`,
`create`/`adopt`/`release`/`probe`) — and every consumer speaks it: Sailor's
`execute.ts`, `sailor run`, and `sailor smoke` build providers explicitly
through one `heyoProvider(cfg)` translation point; handles carry
`provider.name` verbatim, so no future backend can be misclassified as heyo
(both `backend === "local" ? … : "heyo"` ternaries are gone).
`createSandbox` and its options union were removed pre-publish — zero callers
after the migration; `provider.create(spec)` is the replacement.

- **SDK isolation is proven, not aspirational:** the root entry loads with
  `@heyocomputer/hws` physically removed from `node_modules`; the `heyo` and
  `local` factories live behind `@anchor/core/sandbox/<name>` subpaths
  (with `upsertHeyoSecret` on the heyo subpath), and a genericity guard keeps
  the SDK and the test framework out of every other entry.
- **Capabilities are promises the suite holds you to.** `SandboxCapabilities`
  gains `localPath`; the conformance suite gates scenarios on declaration.
  First catch: `local()` declared `fork: false` while implementing `fork()`.
- **`runSandboxConformance(provider)` is the adapter acceptance test**
  (`@anchor/core/testing`, vitest as optional peer): exec fidelity,
  self-containment, kill deadlines, env secrets, checkpoints, destroy
  idempotence, retain/adopt, git identity, push-failure reporting — plus
  clone, `hasChangesFrom`, `localPath` copies, bare-origin pushes, and fork
  where declared. Scenario bodies assert through `Sandbox`/`SandboxProvider`
  only, never through backend internals. E2B/Daytona adapters are "done" when
  this file passes.
- **The live arm stays opt-in:** `RUN_LIVE_HEYO_TESTS=1` boots one VM per
  scenario; `ANCHOR_CONFORMANCE_REPO` enables the clone-shaped scenarios.

## Streaming and activity follow-up (2026-10-18)

- **Package mechanism:** LLM streams accept an optional `onReasoning` callback;
  only provider-returned reasoning text/summary fields are forwarded. Optional
  `reasoningTokens` comes from provider usage and is already part of completion
  tokens, not added a second time. Each tool-call/result event carries its
  `callId` and a human-readable `verb`. Tools may configure a static or
  input-dependent verb through `defineTool(..., { verb })`; display metadata
  is not included in the provider's function schema.
- **Product transport:** publish live projections before queued trace writes.
  Snapshots include step and sequence so one model call cannot overwrite another.
  Journal replay produces ordered text, reasoning, and tool parts on initial load
  and refresh; finished calls use full aggregates, active ones also replay deltas.
- **Client recovery:** accept deltas even if the call-start frame was missed.
  Refetch on SSE connect/reconnect, throttle nudges with bounded latency, and
  reconcile active turns every two seconds (idle threads every ten seconds).
  This covers missed completion notifications and dev-server restarts without
  requiring a browser refresh. Persisted and live parts merge by stable IDs and
  sequence; a stale snapshot cannot roll the visible answer backward.
- **Interaction:** render text → tool activity → text in order. Activity stays
  open while working, collapses when the next assistant message starts, and can
  be reopened for tool input/output and errors. Reasoning is a separate
  expandable section, with token counts only when reported. Hidden/unreturned
  reasoning is not fabricated. No new messages table is needed.

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
`sailor eval` runs all tasks end-to-end → solve rate, $/task, p50/p95 time, failure-mode breakdown (repro-failed / wrong-fix / timeout / budget / loop / tool-error). Full JSONL trace per task.

## Secrets

- **Local dev:** `.env` file (gitignored). Real env vars override `.env`; `.env` overrides built-in defaults.
- **Production:** platform secret store (K8s Secrets / Docker secrets / Fly.io / AWS SM) → injected as **environment variables** at boot. No `.env` files on disk. On Heyo infra, the secrets plugin (write-only vault, `env_from` at VM boot) is the primitive.
- `HEYO_TOKEN` / `LLM_API_KEY` never leave the orchestrator. `GITHUB_TOKEN` is minted per-run, short-lived, one-repo-scoped (GitHub App installation tokens long-term); git creds live in `/etc/git-credentials` **outside** `/workspace`.
- Guardrails: trace redaction (no token-shaped strings in logs/DB), secrets never in VM images or repo copies.

## Open questions

- Which SWE-bench Lite subset (30–50 tasks) and how to handle per-instance setup images
- Toolchain image contents (git, node, python, ripgrep, docker?, test runners) — finalize when we know target repos
- Dashboard auth in production (v1 is localhost-only, no auth): token? behind Heyo's auth gate? decide when deploying
- **Sandbox retention across runs (interjection + babysit wakes):** every run destroys its sandbox today; a review-comment wake therefore boots a fresh VM and re-clones the PR branch — *correct* (the pushed branch is the handoff point) but not free. Proposal: the thread stores the sandbox handle; a **warm window** (Heyo already retains `/workspace` on scale-to-zero — 600s + `idle_action: retain`; local's `keep` exists) lets quick follow-ups reattach (interjection continuation, CI-fix loop); long-idle wakes cold-clone; a janitor destroys on terminal state/TTL; reattach must `fetch` + checkout-and-reset to avoid a stale workspace. Checkpoint-restore (`checkpoint_sha` → clone + checkout) remains the backend-independent fallback
- **Baseline-relative suite evidence (pre-eval, from review).** "Full suite passes" is the wrong predicate for real repos — SWE-bench repos often ship pre-existing failing/flaky tests on `main`, which would deadlock `fix` (and `validateFinish`) forever. Design: `reproduce` records a **baseline** (first full-suite run, per-test results); success becomes a **delta** — FAIL_TO_PASS (task-provided target tests, or ≥1 baseline-failing test now passing) AND PASS_TO_PASS (no baseline-passing test regresses); exit codes remain the fallback when no per-test data exists. Requires per-test results: `run_tests` gains `junit_path` → `meta.tests` (regex-parsed JUnit XML, zero-dep — vitest/jest junit reporters, `pytest --junitxml`, gotestsum all emit it); step 15's task JSON carries the F2P/P2P lists. Optional de-flake: rerun baseline failures once before recording. Evidence-gating itself stays — the *definition of success* gets honest
- **`advance.to` as a phase enum (nice-to-have).** The injected `advance` schema could declare `to` as an enum of the strategy's phase ids — fewer invalid targets. Low priority: default-next covers the common case, and the engine already rejects unknowns with the phase list
- **`blocked` → user channel (product policy).** Package contract: `disposition: "blocked"` + `summary` (phrased as the question) + optional `resumeAt`; the engine carries, the product delivers. For sailor: post the question as a PR/issue comment (+ `agent:needs-input` label) and let the thread sleep; the human reply is a human-authored event → interject/queue (#28) → new run. Dashboard (step 18) shows the same summary as a message with a reply box. Nothing for the package to build — step 13 adds the client's comment/label methods
