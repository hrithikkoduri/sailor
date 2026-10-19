# Sailor

**Label a GitHub issue. Get back a reviewed pull request — with tests, a full trace, and receipts.**

Sailor is an issue→PR pipeline built on [**Anchor**](https://github.com/hrithikkoduri/anchor-ai-sdk)
(`anchor-ai-sdk`): a GitHub App receives events, a durable worker runs the agent inside an
isolated Firecracker microVM, and every run journals its evidence — what it ran, what passed,
what it could not verify — to a trace you can read and a pull request you can review.

## The loop

```
issue labeled agent:fix
  → webhook (Hono)        verify signature · resolve the thread · enqueue
  → worker (BullMQ)       one run per thread · heartbeats · resume-safe
  → agent in a microVM    clone · reproduce · fix · run the repo's own tests
  → publish_changes       an explicit tool — withheld unless a passing run
                          matches the exact tree it tested
  → pull request          with a trace link
```

After the PR, the same thread keeps working: CI failures and review comments wake
it, budget deaths hand off to a funded revival run, a killed worker resumes from
the last checkpoint. All three are one mechanism — **durable turns** — and none
of them re-derive work that was already done.

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
  chat (SSE); NDJSON traces per run that the PR links to; per-attempt artifacts.
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
compaction, revival — is **Anchor**, consumed from npm. Sailor owns the product
layers: rows, webhooks, GitHub, the dashboard, and the stores.

## Quickstart (development)

Prerequisites: Node 22+, Docker (Postgres + Redis), a Heyo account for real
microVMs (or run the CLI with `--local`), an OpenRouter-compatible LLM key, and
a GitHub App for the full webhook loop. Everything environment-shaped lives in
`.env.example`.

```bash
git clone git@github.com:hrithikkoduri/sailor.git && cd sailor
npm install
cp .env.example .env      # LLM_API_KEY · HEYO_TOKEN (or --local) · GITHUB_APP_*
npm run doctor            # env, services, and sandbox health at a glance
npm run dev               # compose up (if needed) + migrate + serve + worker + dashboard
```

Then pick a way in:

- **The real pipeline** — open the dashboard, label an issue `agent:fix` on a
  repository the App is installed on (webhook tunnel: `ngrok http 3000`, URL
  configured on the App).
- **One run, by hand** — `npm run sailor -- run <repo> <issue>`: the same
  engine, no webhooks.
- **Individually** — `npm run serve -w apps/server`,
  `npm run worker:watch -w apps/server`, `npm run dev -w apps/dashboard`.

## Docs

- [`DECISIONS.md`](DECISIONS.md) — the decision log: every architectural choice,
  why it was made, and what it supersedes.
- [`ROADMAP.md`](ROADMAP.md) — deferred work, each item with its trigger and size.
- [Anchor's decision log](https://github.com/hrithikkoduri/anchor-ai-sdk/blob/main/DECISIONS.md)
  — the runtime's own history.

## Status

Private, early, and honest about it: the whole pipeline runs end-to-end on real
issues — webhook to merged-ready PR, with traces — and the eval harness that
measures the agent's fixes now lives with Anchor. Next: production deployment,
the docs site (`anchor-sdk.dev`), and the benchmark rounds.
