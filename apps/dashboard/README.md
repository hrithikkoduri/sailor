# @harness/dashboard

The Harness product UI — consumer #1 of `@harness/agent`. React 19 + Vite 8 +
Tailwind v4, with **Animate UI** (shadcn registry) primitives and a design
system sourced from the **ui-ux-pro-max** skill (constitution:
`../../design-system/harness/MASTER.md` — porcelain / graphite).

## Structure (and the rules that keep it honest)

```
src/
  main.tsx                entry
  index.css               design tokens (the only place colors/fonts are defined)

  app/                    routing + shared application providers
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
    button, icon-button, brand, markdown, status-pill, empty-state

  components/             GENERATED primitives — registry-managed:
    ui/                     shadcn base (button, input, skeleton, separator)
    animate-ui/             Animate UI components + primitives (motion)
    ⚠ `npx shadcn add` writes here — don't hand-organize this folder

  hooks/                  shared stateful helpers (use-user, use-poll, use-action)
                          (the registry-generated use-mobile/use-* live here too)

  utils/                  cross-cutting utilities, no feature state:
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
`SystemNote` renders every system event; event payload utilities support both
the conversation and the queued-update dialog. The old context rail is gone.

## Commands (from the repo root)

```bash
npm run dev                        # full stack; this app on :5173 (proxies /api,/auth to :8787)
npm run build -w apps/dashboard    # production bundle → dist/
npm run preview -w apps/dashboard  # serve the bundle (:5173, API proxy) against a running serve
npm run typecheck -w apps/dashboard
npm run test:ui -w apps/dashboard  # isolated Vite (:5186), mocked APIs; no worker needed
```

The UI suite uses Playwright Chromium (`npx playwright install chromium` once).
It exercises both themes, mobile/reduced-motion navigation, chat error recovery
and interjection, repository search/discard/disable-all, and thread trace inspection.
Screenshots and failed-test traces go to the gitignored `test-results/` folder.
Axe audits cover the threads, trace, and settings views in both themes.

Chat stream regressions also exercise missing call-start frames, reasoning/text
separation, tool verbs between assistant messages, automatic activity collapse,
refresh replay, and completion recovery with no SSE notification. Live updates
are step/sequence scoped; a two-second active-turn reconciliation prevents the
UI getting stranded on “Thinking” if a notification is dropped.

## Vendored Animate UI fixes

Copy-first components are source we own, not an unmodifiable dependency. Keep
these corrections when updating from the registry:

- Sidebar: Radix tooltip uses `delayDuration`; placement belongs on content.
- Highlight: don't add `aria-selected` to arbitrary divs or links. The underlying
  tab/menu primitive supplies the appropriate accessible state.
- Switch: keep `onCheckedChange`, `checked`, `defaultChecked` off the motion DOM
  button; Radix owns checked state and emits the callback.
- Registry helpers use `@/utils`, as configured in `components.json`.
- Tabs: use one neutral keyboard-focus ring, not layered outline/ring treatments.
- Sidebar: icon-only mode explicitly hides labels and clips the inner content;
  navigation uses its active state instead of a hover highlight overlay.
