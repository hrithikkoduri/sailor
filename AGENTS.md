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
      features/      one folder per product area, colocated api.ts + hooks
      elements/      design-system primitives (the product's UI vocabulary)
      hooks/         shared client-only hooks
      utils/         pure helpers (format, platform, text, api-client)
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

## Code hygiene

These rules apply to every change, not just new files. A green build does not
excuse a 600-line component or a second copy of a policy.

### Both sides

- **One responsibility per module.** Split before a file becomes hard to scan.
  A useful trigger is ~300 lines, or two reasons to change names in the same
  file; `executeRun` is the orchestration exception, not a precedent.
- **Extract pure functions.** Filtering, formatting, validation, and state
  transitions live outside components and route handlers, where they can be
  read on their own and tested without a renderer or a database.
- **No duplicated policy.** If two screens or two routes need the same rule,
  it belongs in one exported function/hook/service. Copying it is a bug
  waiting for one side to drift.
- **No `any` without a comment.** Narrow types or `unknown` + a guard instead.
- **No dead paths or commented-out code.** Delete it; git remembers.
- Comments explain intent and invariants, not what the next line does.

### Frontend

- **Design system first.** Reusable primitives live in `elements/`. Do not use
  a native control where the design system has a primitive (`select`, menu,
  dialog, button, input). Do not invent a one-off button or popover inside a
  feature; add the primitive once and compose it.
- **Compose, don't nest.** A page is a small composition of named sections.
  When JSX develops several unrelated blocks, extract components instead of
  adding another level of nesting. Keep presentational components narrow and
  free of fetch logic.
- **No prop plumbing.** Do not thread a value through three layers that only
  pass it along. Use composition (`children`, slots), a feature-scoped hook, or
  a provider at the boundary that actually owns the state. Context is for a
  genuinely shared concern, not for avoiding a clear prop.
- **State stays local and minimal.** Derive values during render; do not mirror
  props into state. `useEffect` is for external synchronisation only (fetch,
  subscription, DOM), never for computing derived state or reacting to a value
  that should be derived. One effect should do one thing.
- **One fetch layer.** Features call `utils/api-client.ts`; never `fetch`
  directly and never import server code. Colocate API functions in the
  feature's `api.ts`.
- **Avoid speculative memoisation.** `memo`/`useMemo`/`useCallback` only after
  a measured problem, or where referential stability is required by a
  dependency. Stable list keys; avoid recreating large option arrays on every
  render.
- **Heavy views split and lazy-load.** Trace explorer and other expensive
  panels stay behind `lazy`/`Suspense`; pages should not become the bundle.
- **Accessible by construction.** Use semantic elements, labels, keyboard
  handling, and focus management from the primitives. Never replace a control
  with a clickable `div`.

### Backend

- **Respect the layering.** `http/` parses and shapes; `services/` owns SQL and
  business rules; `db/` owns schema. No SQL in routes, no Hono in services, no
  worker-only policy duplicated in HTTP.
- **Transactions belong to the use case.** Open them in `services/`, never in a
  route or a helper that wraps one query.
- **Configuration is typed and central.** Read environment variables in
  `config.ts`; pass values down. Explicit test seams may take an injected env,
  but new runtime code should not sprinkle `process.env` through services.
- **Failures are values.** A service returns its result or `{ error, status }`;
  the route maps that to HTTP. Do not throw for expected user errors.
- **Split by aggregate, not by layer.** One use-case module per aggregate; when
  it serves two domains, split the file rather than adding branches.
- **Pure core, thin edges.** Keep protocol/transport concerns at the edge and
  deterministic rules in plain functions that tests can call directly.

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
   for a single approved operation (`secrets use_secret`) and the value is
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

This repo is **Sailor core**, the public, self-hostable edition.
The private `sailor-cloud` repo is a **downstream fork** that owns hosting,
operations, and private product work.

- Core must stay usable on its own: threads, runs, traces, sandbox adapters,
  checklist/UI, questions, repository attachment, publication, CLI, and auth.
- Cloud may diverge; it is not automatically synced back. Do not assume a
  private feature exists here.
- Never move private code or credentials into this public repo. If a change is
  genuinely public, make it here as its own change; the cloud fork can choose
  to carry it later.
- Do not build paid features behind a public flag. They belong in the private
  fork, not in a conditional branch here.

## Conventions

- TypeScript strict; no `any` in new code without a comment explaining why.
- Server modules are ESM with `.js` import specifiers.
- API routes live under `/api/*`; auth under `/auth/*`; webhooks under `/webhooks/*`.
- New API shape? Add the schema to `packages/contracts` first.
- Prefer one focused module over a growing `index.ts`.
- Comments explain intent and invariants, not restatements of the code.
- Migrations: `npm run db:generate -w apps/server`, never hand-edit `drizzle/meta`.
