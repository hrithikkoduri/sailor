# Sailor — workspace design system

This curated direction supersedes the generated “code dark + run green” theme,
which the product review explicitly rejected. UI/UX Pro Max informed the
accessibility, hierarchy, and interaction checks; its marketing-page and
color suggestions are recommendations, not the product design.

## Intent

A calm workspace for working with an engineer, not a terminal or a CI console.
Content first, quiet navigation, clear actions, inspectable evidence.

## Palette

| Role | Light / porcelain | Dark / graphite |
| --- | --- | --- |
| Canvas | `#faf9f7` | `#191919` |
| Sidebar | `#f1f0ed` | `#141414` |
| Surface | `#ffffff` | `#202020` |
| Foreground | `#252422` | `#e9e7e3` |
| Secondary text | `#68645e` | `#aaa6a0` |
| Divider | `#e5e2dd` | `#333332` |
| Selection | `#eeece8` | `#302f2d` |
| Selection text | `#45413b` | `#e9e7e3` |

- Primary actions are ink on light, ivory on dark. No neon CTA.
- Focus and selection stay neutral. One keyboard-focus outline, never layered rings.
- Green/red/amber are small semantic indicators, not panel colors.
- Use semantic tokens from `apps/dashboard/src/index.css` everywhere.
- Light is the default; theme choice persists locally, including before React loads.
- Keep the sidebar flat porcelain. The cream/grain experiment was rejected;
  don't reintroduce textured surfaces.

## Identity

- `elements/brand` owns the Sailor helm: eight shaped handles, a heavier rim,
  tapered spokes, and an open hub. The SVG favicon mirrors the same geometry.
- Render the mark without a tile, border, or background.
- Use the same mark in the shell, authentication screens, and activity rows.
  Agent replies have no repeated avatar, name, or timestamp header; start with
  the content. Rotation indicates real work only: thinking and pending actions.
  Stop for reduced motion.

## Typography and rhythm

- Self-hosted Inter for all interface text. JetBrains Mono only for code,
  object IDs, and numeric trace columns. No uppercase monospace UI chrome.
- Body 14px with generous leading; labels 12–13px; microcopy 11px.
- Headings 20–26px, medium weight, tight tracking. One heading per view.
- 4px spacing rhythm; 16–24px card padding; 32–48px page gutters.
- Chat has a stable 800px measure. Avoid redundant boxes around agent replies.
- Compact workspace header (48px); thread title/actions/view switch share one
  toolbar. Trace totals are inline, not dashboard metric cards. Preserve vertical
  space for the actual conversation and evidence.

## Component implementation map

| Interaction | Implementation |
| --- | --- |
| Navigation and mobile drawer | Animate UI Sidebar + Sheet |
| Primary/secondary/text/icon actions | `elements/button` wrapping Animate UI Button |
| Icon explanations | `elements/icon-button` wrapping Animate UI Tooltip |
| View and filter navigation | Animate UI Tabs (keyboard and animated indicator) |
| Account, theme menu, run options, tree actions | Animate UI Dropdown Menu |
| Repository permissions | Animate UI Switch with associated labels |
| Queued messages | Animate UI Dialog |
| Input / Output / Metadata | Stacked Animate UI Accordion, initially open |
| Copying responses, code, span details | Animate UI Copy Button |
| Text input / loading | shadcn Input / Skeleton |

Install primitives for actual interactions, not to maximize the registry count.
Our feature components own layout and data. Registry primitives own accessible
behavior and motion. Vendored fixes must be recorded in the dashboard README.

## Product rules

- Conversation is the default thread view. Trace is the whole thread, not a
  separate list of turns beside another run list. No context rail.
- Run and thread aggregates belong in the trace; do not decorate chat messages
  with token costs, internal IDs, or phase badges.
- Trace selection survives refresh. Input, Output, Metadata stay stacked.
- Trace failures must be obvious without relying on color alone: red icon and
  name, a visible “Failed” label, and a failure summary in the detail pane.
  A failed execution request does not establish that the guest process stopped.
- Preserve drafts on errors. Enter sends, Shift+Enter inserts a line; queued
  messages can be explicitly interjected. Composition/IME must not submit.
- Follow live output only while the user is near the bottom. Offer a “latest
  message” action centered above the composer instead of pulling someone away
  from what they are reading.
- Tool activity is a quiet, borderless disclosure line (“N actions performed”).
  Expanding reveals action verbs and outcomes, not argument/output JSON; those
  remain in Trace. Open while working, collapse as the next assistant step starts,
  and allow manual reopening. Reasoning remains independently expandable.
- While a run is working, a small phase trail sits above the composer:
  `Understand → Act → Validate → Respond`, with entered phases checked, the
  current one shimmering, and later ones waiting. It reflects what the trace
  actually recorded (skips stay visible), disappears on completion, and renders
  the current phase as plain ink under reduced motion.
- Local debug mode (⌘⇧D / Ctrl+Shift+D) keeps action groups open and reveals
  per-tool expandable input/output. Failed calls have red labels and output plus
  explicit failure text. Keep a visible active indicator and a pointer-accessible
  toggle. It is a display preference, not permission or execution mode.
- All search, filters, menus, and controls must work. No decorative fake actions.

## Motion and verification

- Spring indicator for tabs/menus; subtle button press; short panel fades.
- No large hover scaling, looping decorative animation, or stagger on every refresh.
- Honor reduced motion at MotionConfig and CSS levels.
- Browser tests use mocked APIs: no real runs, GitHub mutations, or VM costs.
- Check light/dark contrast independently, mobile overflow, keyboard labels,
  account navigation, trace inspection, send failure/retry, and disable-all repos.
- `npm run test:ui -w apps/dashboard` captures screenshots and runs axe audits.
