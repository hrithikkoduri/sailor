# @harness/dashboard

The Harness product UI — consumer #1 of `@harness/agent`. React 19 + Vite 8 +
Tailwind v4, with **Animate UI** (shadcn registry) primitives and a design
system sourced from the **ui-ux-pro-max** skill (constitution:
`../../design-system/harness/MASTER.md` — "code dark + run green").

## Structure (and the rules that keep it honest)

```
src/
  main.tsx                entry
  index.css               design tokens (the only place colors/fonts are defined)

  app/                    routing — the app's shape, nothing else
    App.tsx

  features/               one folder per product capability; a feature OWNS:
    shell/                  its page(s), its api.ts, its components, feature hooks
    auth/                 ┌─ features may import the *public surface* of other
    onboarding/           │  features (api.ts, exported page/components) — pages
    repos/                │  compose features; deep imports across features are a
    threads/              │  smell
    chat/                 └─ when two features need the same thing, it moves UP:
    trace/
    settings/
      <feature>/api.ts      fetchers + types for that capability's endpoints
      <feature>/components/ pieces used only by this feature
      <feature>/*-page.tsx  route components
      <feature>/use-*.ts    hooks that need this feature's context

  elements/               visual atoms of OUR making (no data fetching):
    brand, markdown, status-pill, empty-state

  components/             GENERATED primitives — registry-managed:
    ui/                     shadcn base (button, input, skeleton, separator)
    animate-ui/             Animate UI components + primitives (motion)
    ⚠ `npx shadcn add` writes here — don't hand-organize this folder

  hooks/                  shared stateful helpers (use-user, use-poll, use-action)
                          (the registry-generated use-mobile/use-* live here too)

  utils/                  PURE functions only — no React, no fetching:
    cn.ts                   class merge (the registry's `utils` alias points here)
    format.ts               time/duration/token/… formatting
    api-client.ts           the one fetch wrapper (+ ApiError)
    events.ts               event-payload readers shared by chat + threads
```

Where does a new thing go?

1. Used by one feature → that feature's `components/` or a local hook.
2. Used by ≥2 features → `elements/` (visual), `hooks/` (stateful), `utils/`
   (pure), or a shared component under `components/` if it's composed UI.
3. Talks to the API → a feature `api.ts` that imports `@/utils/api-client`.
4. Registry-managed → stays in `components/ui` / `components/animate-ui`.

Reusability in practice: `RepoPicker` (features/repos) is THE repo-gate UI —
onboarding and settings both mount it; `useThreadStream` (features/chat) is
the only SSE wiring; `AgentMessage` renders both finished and streaming turns;
`SystemNote` renders every system event; `eventPreview`/`eventAuthor`
(utils/events) feed the feed AND the rail.

## Commands (from the repo root)

```bash
npm run dev                        # full stack; this app on :5173 (proxies /api,/auth to :8787)
npm run build -w apps/dashboard    # production bundle → dist/
npm run preview -w apps/dashboard  # serve the bundle (:5173, API proxy) against a running serve
npm run typecheck -w apps/dashboard
```
