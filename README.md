<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="Sailor" width="96" />
  </picture>
</p>

<h1 align="center">Sailor</h1>

<p align="center">
  <strong>An engineering workspace. From a conversation to shipped work.</strong><br />
  Start with a goal, optionally attach a repository, and follow every step — the agent runs in an isolated
  Firecracker microVM, built on
  <a href="https://github.com/hrithikkoduri/anchor-ai-sdk">Anchor</a>.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-early%20alpha-0f1115?style=flat-square" alt="early alpha" />
  <img src="https://img.shields.io/badge/built%20on-anchor--ai--sdk-0f1115?style=flat-square" alt="built on anchor-ai-sdk" />
  <img src="https://img.shields.io/badge/runs%20in-Firecracker%20microVMs-0f1115?style=flat-square" alt="Firecracker microVMs" />
</p>

---

<p align="center">
  <img src="docs/assets/dashboard.png" alt="Sailor's dashboard" width="860" />
</p>

## The loop

Start directly from **Home → Start thread**, without a GitHub
issue. Write a request and optionally attach an enabled repository. If no
repository is selected, Sailor can work in a fresh sandbox, attach a clearly
identified repository, or ask you to choose through an inline form. Answering
the form resumes the same conversation and retained sandbox.

The sidebar has **Home**, **Threads**, **Issues**, **Pull requests**, **Traces**,
and **Settings**. Issues and PRs show work tracked by Sailor; Traces lists runs
with steps, token usage, cost, duration, and links into the full journal.

After updating, run `npm run migrate` before starting the server/worker. The
workspace migration adds thread titles and durable question forms. Publication
does not require an issue: a repo-backed thread can open and update
a PR when the user requests delivery. A repo-less thread must attach an enabled
repository first. GitHub issues are one optional triage entry point, not the
definition of a Sailor thread. Other triage integrations are future work.

```
conversation or triaged GitHub issue
  → intake (Hono)         authorize · resolve the thread · enqueue
  → worker (BullMQ)       one run per thread · heartbeats · resume-safe
  → agent in a microVM    clone · reproduce · fix · run the repo's own tests
  → publish_changes       explicit, access-checked delivery when requested;
                          unverified work is a draft (stricter policy optional)
  → pull request          with a trace link
```

After the PR, the same thread keeps working: CI failures and review comments
wake it, budget deaths hand off to a funded revival run, a killed worker
resumes from the last checkpoint. All three are one mechanism — **durable
turns** — and none of them re-derive work that was already done.

## What's in the box

- **GitHub App intake** — webhooks with signature verification, one thread per
  issue/PR, coalesced events, priority to review comments over chatter.
- **Durable runs** — the database is the truth; leases + heartbeats detect dead
  workers and enqueue a resume; checkpoints are pushed to a side branch, so a
  lost VM never loses the work.
- **Budgets & revival** — per-thread turns and dollars. A run that dies out of
  budget leaves a handoff; the next run continues the *same task, phase, and
  budget* until the thread's caps are spent — then a human gets the note.
- **Evidence-gated publication** — `run_tests` records the tree hash it ran
  against; `publish_changes` refuses to ship unless a green run matches that
  exact tree. The agent never reads success out of a confident sentence.
- **Live everything** — a dashboard with threads, runs, a trace viewer, and
  chat (SSE); NDJSON traces per run that the PR links to; per-attempt
  artifacts.
- **Isolation by default** — every agent run executes in its own Heyo
  microVM; the local backend exists for development only.

## How it works

```
apps/server       Hono API + webhooks + CLI + long-lived worker
                  Postgres: threads · runs · trace_events · inbox
                  Redis/BullMQ: the queue, retries, timers
apps/dashboard    React dashboard — threads, runs, trace viewer, chat (Vite)
image/            the toolchain image (git · node · python · test runners)
                  that microVMs boot from
fixtures/         a tiny buggy library used by the end-to-end tests
```

The agent runtime itself — the loop, the sandbox contract, traces, budgets,
compaction, revival — is **Anchor**, consumed from npm. Sailor owns the
product layers: rows, webhooks, GitHub, the dashboard, and the stores.

## Quickstart (development)

Prerequisites: Node 22+, Docker (Postgres + Redis), a Heyo account for real
microVMs (or run the CLI with `--local`), an OpenRouter-compatible LLM key,
and a GitHub App for the full webhook loop ([~3-minute setup](docs/github-app.md)
— you bring your own). Everything environment-shaped lives in `.env.example`.

```bash
git clone https://github.com/hrithikkoduri/sailor.git && cd sailor
npm install
cp .env.example .env      # LLM_API_KEY · HEYO_TOKEN (or --local) · GITHUB_APP_*
npm run doctor            # env, services, and sandbox health at a glance
npm run dev               # compose up (if needed) + migrate + serve + worker + dashboard
```

Then pick a way in:

- **The real pipeline** — open the dashboard, label an issue `agent:fix` on a
  repository the App is installed on (webhook tunnel: `ngrok http 8787`, URL
  configured on the App).
- **One run, by hand** — `npm run sailor -- run <repo> <issue>`: the same
  engine, no webhooks. Add `--verbose` to stream the model, `--keep` to keep
  the sandbox for debugging.
- **Individually** — `npm run serve -w apps/server`,
  `npm run worker:watch -w apps/server`, `npm run dev -w apps/dashboard`.

## Docs

- [`DECISIONS.md`](DECISIONS.md) — the decision log, classified
  (architectural / cosmetic / misc): every choice, why, and what it supersedes.
- [`ROADMAP.md`](ROADMAP.md) — deferred work, each item with its trigger and size.
- [Anchor](https://github.com/hrithikkoduri/anchor-ai-sdk) — the runtime, its
  [decision log](https://github.com/hrithikkoduri/anchor-ai-sdk/blob/main/DECISIONS.md),
  and the [evaluation results](https://github.com/hrithikkoduri/anchor-ai-sdk/tree/main/evals/benchmarks/swe-bench/results)
  (equal resolution vs mini-swe-agent on SWE-bench Lite at ~⅓ the cost).

## Status

Early, and honest about it: the whole pipeline runs end-to-end on
real issues — webhook to reviewed PR, with traces — and every architectural
piece below it (durable turns, revival, evidence gates) is exercised by the
package's own conformance and evaluation suites. Next: production deployment,
the docs site (`anchor-sdk.dev`), and the benchmark rounds.
