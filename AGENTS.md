# AGENTS.md — how this repository is organised

Read this before changing anything. It is the contract for humans and agents
working in Sailor.

## What this repo is

Sailor is the product: an engineering workspace where a conversation becomes
shipped work (threads, runs, traces, repositories, pull requests). The agent
runtime is a **separate package** — [`anchor-ai-sdk`](https://github.com/hrithikkoduri/anchor-ai-sdk)
— consumed from npm. Mechanics live in the package; policy lives here.

## Layout

```
apps/
  server/        API + worker: Hono routes, BullMQ consumers, Postgres, GitHub
    src/
      db/            schema, migrations, pool             (no business rules)
      http/          HTTP edge only: app, routes/, SSE      (no SQL)
      services/      business logic, owns SQL               (no Hono)
        runs/        lifecycle, leases, queries, commands
        threads/     queries, commands, inbox, questions
        github/      App auth, webhooks, PR delivery
        agents/      prompts + agents; agents/tools/
        trace/       journal, recorder, queries
        secrets/     encrypted account secrets
        auth/        sessions, passwords, OAuth
      sandbox/       provider selection + heyo/e2b         (infra adapter)
      worker/        queue consumers                       (entry point)
      queue/         BullMQ setup
  dashboard/     React SPA (Vite)
    src/
      app/           routing, providers
      features/      one folder per product area, colocated api.ts
      elements/      design-system primitives
      components/    generated/vendored UI (animate-ui, shadcn)
packages/
  contracts/     shared API types + zod schemas (server and dashboard both import)
scripts/         dev stack, seed tooling
image/           sandbox toolchain images
fixtures/        fixture repositories for tests
docs/            public documentation
docs/design-notes/  design references (no primitives; UI lives in elements/)
```

## The layering rule

```
db → services → http → dashboard
```

- **db**: schema and migrations only. No queries beyond the pool.
- **services**: own SQL and business rules. Never import Hono, never parse HTTP.
- **http**: parse → authorize → call service → shape response. **No SQL.**
- **dashboard**: consumes the API; imports types from `@sailor/contracts`.

Dependencies point one way. `http/` and `worker/` may import `services/` and
`db/`; `services/` may import `db/`; the worker never imports `http/`; the
dashboard never imports the server.

Two entry points share the service layer: `server` (HTTP) and `worker` (queues).
A rule implemented in one must not be duplicated in the other.

### Ownership rules

- **Transactions belong to the use case.** Open them in `services/`, never in a
  route handler and never in a helper that only wraps one query.
- **Service failures are values, not exceptions.** A use case returns either its
  result or `{ error, status }`; the route maps that to a status code. Services
  do not import Hono and do not know about cookies, headers, or redirects.
- **No repository layer over Drizzle.** `db/` holds the schema and the pool;
  services query with Drizzle directly. A second abstraction over an ORM is
  ceremony, not safety.
- **Route files are per resource.** `http/routes/threads.ts` owns `/api/threads*`.
  Do not create cross-resource route files; do not split one resource across two.
- **One use-case module per aggregate**, split when it passes ~300 lines or
  starts serving two domains (for example `threads/commands.ts` →
  `threads/create.ts`, `threads/messages.ts`, `threads/repository.ts`).

## Where new code goes

| You are adding | It belongs in |
|---|---|
| An HTTP endpoint | `apps/server/src/http/routes/<resource>.ts` |
| The rules or transaction behind it | `apps/server/src/services/<domain>/commands.ts` (writes) or `queries.ts` (reads) |
| A new wire type | `packages/contracts` first, then both sides import it |
| A table or column | `apps/server/src/db/schema.ts` + a generated migration |
| A third-party system | `sandbox/` (execution) or `services/<domain>/client.ts` (API client) |
| A dashboard request | `apps/dashboard/src/features/<feature>/api.ts` |
| A reusable primitive | `apps/dashboard/src/elements/` |
| A product-specific widget | `apps/dashboard/src/features/<feature>/components/` |
| Generated/vendored UI | `apps/dashboard/src/components/` |

## Naming

- `http/` on the server is **HTTP delivery** (routes and their adapters).
  `api.ts` in the dashboard is the **typed client for that feature**. The server
  folder is named for its protocol; "api" on the dashboard means "calls the API".
  Do not use either name for anything else.
- The dashboard has exactly one fetch layer: `src/utils/api-client.ts`. Feature
  modules call it; they do not call `fetch` themselves.
- `features/<name>/` holds the feature's `api.ts`, `components/`, hooks, and
  `types.ts`. A feature does not import another feature's internals; share via
  `elements/`, `utils/`, or `@sailor/contracts`.

## Commands

```bash
npm run dev                  # Postgres + Redis + serve + worker + dashboard
npm run migrate              # apply migrations (run before serving)
npm run typecheck            # both workspaces
npm test -w apps/server      # unit
npm run test:integration -w apps/server
npm run test:ui -w apps/dashboard
npm run build                # typecheck + contracts + server + dashboard
```

Gates before any commit: `npm run typecheck`, unit + integration for the server,
`npm run test:ui` for dashboard changes. A green suite is the definition of
"done"; a failing suite is not "someone else's problem".

## Invariants (do not break these)

1. **Postgres is the truth.** Streams are nudges; the client refetches. Never
   treat a websocket/SSE delivery as state.
2. **Secrets never enter the sandbox.** Account secrets are decrypted server-side
   for a single approved operation (`run_with_secret`) and the value is
   stripped from observations. A secret must never appear in a prompt,
   the thread store, `trace_events`, a PR, or `.anchor/notes.md`.
3. **Git credentials are scoped per thread.** `tokenFor(installationId, [repo])`
   — never an installation-wide token in a sandbox.
4. **All user data is owner-scoped.** Every query touching threads/runs/events/
   secrets filters by `userId`. Repository access is re-checked at the point of
   a side effect, not only at thread creation.
5. **Publication is explicit.** A finished turn publishes nothing; only
   `publish_changes` does, and it re-verifies repository access and evidence.
6. **Agents ask with `ask_questions`.** Questions in prose do not pause work and
   are not answered through the UI.
7. **Tests and configuration are read-only for agents** unless the task is
   explicitly about them.

## Core vs cloud

This repo is **Sailor core** (open source).
The paid layer lives in a private `sailor-cloud` package that consumes core.

- Stays in core: threads, runs, traces, sandbox adapters, checklist/UI,
  questions, repository attachment, publication, CLI, auth, and enough to run
  locally (Dockerfile, dev compose, CI merge gates).
- Goes to `sailor-cloud`: multi-agent orchestration, browser sessions,
  flow-state UX extras, billing/entitlements, orgs, SSO/SAML, audit export, and
  hosting operations.

Public code must expose the **seams** those features need (agent/tool registries,
an extension list, dashboard slots) — but not the features themselves. Never
gate a paid feature with a flag inside public code; put the code in the private
package.

## Conventions

- TypeScript strict; no `any` in new code without a comment explaining why.
- Server modules are ESM with `.js` import specifiers.
- API routes live under `/api/*`; auth under `/auth/*`; webhooks under `/webhooks/*`.
- New API shape? Add the schema to `packages/contracts` first.
- Prefer one focused module over a growing `index.ts`.
- Comments explain intent and invariants, not restatements of the code.
- Migrations: `npm run db:generate -w apps/server`, never hand-edit `drizzle/meta`.
