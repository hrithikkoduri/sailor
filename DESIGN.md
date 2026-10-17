# DESIGN.md — issue-to-PR coding harness

> Living decisions log. Every entry: what was decided, why, and by whom. Update as we go.

**One-line pitch:** label a GitHub issue `agent:fix`, get a PR with the fix, passing tests, and a link to the full agent trace — all inside an isolated Firecracker microVM.

## Architecture (current draft)

```
GitHub events ──webhook──▶ intake service (Hono) ──▶ Postgres (threads, inbox, jobs, traces)
                                                        │
                  timer/cron ("babysit PRs") ───────────┤
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
| 12 | LLM: provider-agnostic interface; OpenRouter/OpenAI-compatible first | Swappable; all models reachable | ✅ agreed |

## Inngest vs BullMQ (decision #7 detail)

- **BullMQ (Redis)**: job queue library. You write a worker process that pulls jobs. Retries, backoff, priorities, rate limits, **repeatable (cron) jobs** = our timers. Self-hosted, boring, full control. Long-running jobs fine — the worker just runs them.
- **Inngest**: event → function platform. Nice DX, built-in cron/retries/**durable multi-step workflows** (`step.run` survives crashes), fan-out. But functions are designed for serverless (time limits, no held state) — bad fit for hour-long agent turns. Self-hostable but more moving parts; or their cloud (dependency).
- **Verdict**: BullMQ for the queue + timers. Our "durable workflow" (thread state machine) lives in Postgres where we can query it. Revisit Inngest only if we later want serverless glue for intake/timers.

## Heyo facts worth remembering (from research)

- `exec(id, cmd)` = one fresh process per call, starts in `/`. Non-zero exit is a normal return value.
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
