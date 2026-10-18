# Deferred work — the ledger

Decisions are made now; work is built when its trigger fires. Nothing here is
forgotten, and nothing here is "someday" — each item names the event that pulls
it back. When an item ships, delete it from this file and record the _decision_
in `DESIGN.md`.

**Standing principles** (apply to every item below)

- Mechanics in Anchor (`packages/core`), policy in Sailor (`apps/server`,
  `apps/dashboard`); Anchor exposes interfaces, never infrastructure.
- Anchor is configuration-free: options go in, nothing reads env (decision #16).
- SDK naming (decision #52): `runAgent`, `openSandbox` — say the noun, verb
  first; no `runLifecycle` / `openWorkspace` / `createRunner`.
- Vendor-free core: external integrations (trace platforms, model vendors) are
  separate packages or consumer code.

## Tracing & observability

- **OTel trace sink** — the first external adapter; one OTLP sink reaches
  Langfuse / Honeycomb / Datadog / Grafana. _Trigger:_ wanting hosted traces
  (after the slice-5 sink fan-out lands). _Size:_ S–M.
- **LangSmith / Braintrust native adapters** — per-vendor span mapping.
  Braintrust doubles as an **eval consumer** (step 15) off the same event
  stream. _Trigger:_ actively using the platform. _Size:_ S each.
- **Export tool-author helpers** — `requireString`, `requireSandbox`,
  `formatExec` are internal today; Sailor validates inline. _Trigger:_ next
  tool authored outside Sailor. _Size:_ XS.

## Sandbox providers

- **Slice 1 — `SandboxProvider` + registry + subpath exports + conformance
  suite.** _Status:_ in flight; not deferred.
- **E2B adapter / Daytona adapter** — each maps its own tiers to the generic
  `size` and passes the conformance suite. _Trigger:_ a second VM vendor is
  actually needed (region, cost, comparison). _Size:_ M each.
- **Egress control enforcement** — capability flag lands with slice 1;
  enforcement waits. _Trigger:_ a provider supports it and a product needs it.
  _Size:_ M.
- **Artifact→git image fallback chain** — try the primary image source, and on
  job failure destroy + recreate from the secondary (design sketched in the
  provider session; remember to widen the build-secret refresh condition to
  "git anywhere in the chain"). _Trigger:_ artifact kind is primary in
  production **and** store flakiness is observed on pulls. _Size:_ S–M.
- **Publish the ext4 + flip `HEYO_IMAGE_KIND=artifact`** — blocked externally:
  Heyo's namespace artifact store rejects uploads (`Broken pipe` at 1 GiB,
  `502 app-lb could not reach its artifact store` at 64 MiB, `setRepo` 502).
  The rootfs is built and verified locally. _Trigger:_ store heals → one
  `heyctl artifact push rootfs.ext4 --tag harness/sailor-toolchain:latest` +
  env flip. _Size:_ S (blocked).
- **`fork()` (checkpoint → new VM)** — for step 14 best-of-N. _Trigger:_
  best-of-N work starts. _Size:_ M.
- **Retained-sandbox janitor TTL** — parked VMs live until the thread is
  terminal; a TTL would bound long-idle cost. _Trigger:_ cost visibility on
  the Heyo bill. _Size:_ S.

## Package slices (the review's order, minus what has shipped)

- **Slice 2 — git-token callback + provider `prepare()`**: `git: { token: () =>
Promise<string> }` (fixes >1h runs pushing with expired credentials) and the
  provider absorbs the build-secret refresh (`upsertHeyoSecret` call site).
  _Size:_ S–M.
- **Slice 3 — `openSandbox` store-backed session**: `sources: [checkpoint,
head, base]`, `SandboxStore`, adoption/fallback callbacks become store ops.
  _Size:_ M.
- **Slice 4 — `createLLMClient({ catalog: "auto" })`**: prices + compaction
  derived internally. _Size:_ S.
- **Slice 5 — `TraceSink` + `traceSinks: [...]`**: shared sequence + redaction
  before fan-out; move live/transcript projectors next to the event schema
  (versioned with it). _Size:_ M.
- **Slice 6 — `runAgent` grows the lifecycle**: sinks, heartbeat,
  `shouldCancel`, status mapping, usage/cost — one entry point. _Size:_ L,
  do last.
- **Slice 7 — `planRevival` + `ThreadBudget` + `latestEvidenceForTree`**: pure
  policy primitives; Sailor persists the decisions. _Size:_ S.
- **`createAnchor` facade** — ~20 lines of sugar over the slices' calls.
  _Trigger:_ a second consumer wants the same wiring bundle (eval CLI at step
  15 likely). _Size:_ XS once the slices land.

## Product & UX

- **Event presentation config** — shipped as a defaults map
  (`apps/dashboard/src/features/chat/presentation.ts`); follow-up: operator-
  editable (env/JSON) only if someone asks. _Size:_ XS.
- **Review context** — shipped: webhook captures `diff_hunk` / `line` / `side`
  / `subject_type` / PR title, the task renderer includes the anchor + hunk,
  and the chat shows an expandable system receipt. Follow-ups: resolve
  `issue_comment` context the same way (no hunk exists there), reply
  threading (`in_reply_to_id`), "outdated" comment state. _Size:_ S.
- **"Queue instead of interject" affordance** — the #28-deferred UI for
  downgrading an interjection. _Trigger:_ user request. _Size:_ S.
- **Baseline-relative suite evidence** — FAIL_TO_PASS / PASS_TO_PASS deltas
  (`run_tests` gains `junit_path` → `meta.tests`). _Trigger:_ step 15 evals on
  real repos whose `main` is not green. _Size:_ M.
- **`blocked` → user channel** — package carries `disposition: "blocked"` +
  summary; Sailor posts it as a comment + `agent:needs-input` label and the
  reply becomes the next event. _Trigger:_ step 13 client wiring. _Size:_ S.

## Model providers

- **Native Anthropic / Gemini adapters**, **opaque reasoning replay**, and
  **`cache_control` markers** (for opt-in-caching providers). _Trigger:_
  actually running those models. _Size:_ M / S / XS.
- **Vercel AI-SDK bridge**. _Trigger:_ a third ecosystem asks. _Size:_ M.

## Program-level

- **Steps 14 (best-of-N), 15 (evals), 19 (write-up), 20/21 (stretch)** —
  tracked in `BUILD_PLAN.md`.
- **Heyo platform issues (operator-dependent)** — artifact-store upload path
  (broken pipe / 502 / `setRepo` credential refusal), `get.us2.heyo.work` TLS
  handshake failure. Reported via the owner; retry when acknowledged.
  `BUILD_PLAN.md` step 16 carries the details.
