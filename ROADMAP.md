# ROADMAP.md — deferred work (the contributor ledger)

Everything here is a decision already made and work intentionally not built
yet. Each item names the event that pulls it back ("trigger"), where it lives,
and its rough size, so anyone can pick one up without reading the whole
history. **Package-side work lives in the Anchor repo's `ROADMAP.md`.**

**How to pick one up**

1. Open an issue naming the item (one item per PR keeps review small).
2. The rule that keeps the boundary honest: **mechanics in `anchor-ai-sdk`,
   policy here** — Sailor owns rows, webhooks, GitHub, the dashboard, and the
   stores.
3. Gate every change with:
   ```bash
   npm run typecheck
   npm test -w apps/server
   npm run test:ui -w apps/dashboard          # dashboard changes
   RUN_LIVE_HEYO_TESTS=0 \
     DATABASE_URL=postgres://sailor:sailor@localhost:5432/sailor_test \
     REDIS_URL=redis://localhost:6379/15 npm run test:integration -w apps/server
   ```
   (Package gates run in the Anchor repo's CI.)
4. When an item ships: delete it here, record the decision in `DECISIONS.md`.

## Product & UX

- **Event presentation config** — shipped as a defaults map
  (`apps/dashboard/src/features/chat/presentation.ts`); make it
  operator-editable (env/JSON) only if someone asks. _Trigger:_ user request.
  _Size:_ XS — good first issue.
- **Review context follow-ups** — webhook capture + task rendering + chat
  receipt shipped for reviews. Remaining: `issue_comment` context (no hunk
  exists — resolve file/line from the comment API), reply threading via
  `in_reply_to_id`, "outdated" comment state. _Where:_
  `apps/server/src/server/app.ts`, `apps/server/src/github/render.ts`.
  _Trigger:_ next review-thread complaint. _Size:_ S.
- **"Queue instead of interject" affordance** — UI to downgrade an
  interjection back to queued (design decision #28 deferred this). _Where:_
  `apps/dashboard/src/features/chat/`. _Trigger:_ user request. _Size:_ S.
- **`blocked` → user channel** — the consumer handoff schema carries
  `disposition: "blocked"` + summary (the engine only transports the opaque
  handoff — decision #64); Sailor posts it as a comment + `agent:needs-input`
  label and the human reply becomes the next event. _Where:_
  `apps/server/src/github/`, `apps/server/src/agents/sailor-handoff.ts`.
  _Trigger:_ step 13 client wiring. _Size:_ S.
- **Agent teams in the pipeline** — once Anchor ships delegation (package
  decision #71, "Agent teams" in its roadmap), a run declares a roster instead
  of one agent: the **implementer** stays the lead, a **verifier** teammate
  (read-only tools, its own prompt, no view of the implementer's reasoning)
  independently checks the diff and returns a verdict, and an **investigator**
  teammate can own reproduction so the implementer's context stays clean. The
  verifier's verdict is *evidence for the existing publication gate*
  (`publication.requirePassingTests` / `validateFinish`), not a second
  completion signal — `finish()` and the disposition path are unchanged
  (Anchor #64/#71). Policy that stays here: the roster, each role's tool
  subset, the budget split, and what a verdict gates. _Where:_
  `apps/server/src/agents/`, `apps/server/src/runs/execute.ts`. _Trigger:_
  Anchor's delegation lands; the verifier is the first delegation.
  _Size:_ M.

## Forge providers (git hosts)

- **Bitbucket / Azure DevOps adapters** — Sailor's GitHub layer (App auth +
  installation tokens, webhook parsing and signature checks, review/comment
  interjection, checks, PR publication, the `<slug>[bot]` self-identity) has
  no equivalent for other forges. An adapter mirrors those surfaces per host
  (Bitbucket: app passwords/OAuth + webhooks; Azure DevOps: PATs/service
  hooks + PR/review APIs). Anchor is unaffected — sandbox clone/push is plain
  git once the credential host generalizes (see Anchor's roadmap).
  _Trigger:_ first non-GitHub consumer or workspace. _Size:_ M each.

## Ops & platform

- **Retained-sandbox janitor TTL** — parked VMs live until their thread is
  terminal; a TTL bounds long-idle cost. _Where:_ a sweep in
  `apps/server/src/worker/sweep.ts`. _Trigger:_ cost visibility on the Heyo
  bill. _Size:_ S.
- **The image namespace** — `harness/sailor-toolchain` and the Heyo namespace
  `harness` still carry the old monorepo name. Renaming means rebuilding and
  re-pushing the toolchain image (`image/build.sh`), then swapping
  `HEYO_IMAGE`/`HEYO_NAMESPACE`. _Trigger:_ the next image rebuild, or before
  any public launch. _Size:_ S (+ one image build).
- **Pin the toolchain tag by digest** — the deployment names
  `harness/sailor-toolchain:latest`, so an image rebuild silently changes what
  every new VM boots. `heyctl set artifact --ref <digest>` pins it; do that
  once the image stops moving. _Size:_ S.
- **Heyo platform issue (operator-dependent)** — `get.us2.heyo.work` TLS
  handshake failure. Reported via the owner; retry when acknowledged.
- **The write-up (BUILD_PLAN step 19)** — the public narrative: how the
  pipeline works, the eval numbers, and the Anchor split. _Trigger:_ before
  any launch. _Size:_ M.

## Recently completed (for context)

- **Issue-free delivery and question contract (2026-10-20)** — Repository-backed
  on-demand threads can publish and update PRs on stable `sailor/thread-<id>`
  branches, including work from earlier turns. Attachment unlocks publication
  during the same run; every side effect rechecks enabled repository ownership.
  All user questions use `ask_questions` and pause, including changed scope.
  Issues are optional triage; Linear/Jira integration remains unimplemented.
- **Motion consistency (2026-10-20)** — Shared settled springs for dialogs and
  switcher highlights; tab panels retain their exit animation without blur or
  per-token layout animation. Workspace entry, rail scrolling, and tab movement
  honor reduced motion.
- **Compact thread controls (2026-10-20)** — Open tabs, inline rename, and
  Conversation/Trace share one header row. Stop replaces Send in the composer
  while a run is active. The keyboard switcher preserves message drafts,
  question answers, and reading position; closing a tab never cancels work.
  Existing workspace threads can attach an enabled repository from the composer;
  busy threads queue checkout for the next run.
- **Repository refresh (2026-10-20)** — Settings can resync linked installations
  from GitHub without changing saved enabled/disabled choices. New repos start
  disabled; revoked repos disappear after a complete paginated fetch. Refresh
  is disabled while local toggle edits are unsaved. A missing-repo note links
  to GitHub App installation access settings.
- **Workspace and on-demand threads (2026-10-20)** — Home, Threads, Issues,
  Pull requests, Traces, and Settings have separate routes. A composer creates
  a user-owned thread without creating a GitHub issue, optionally checking out
  an enabled repository before the first model call. Empty threads offer
  `attach_repository` (clear requests) and `ask_questions` (ambiguous ones).
  Questions are durable forms; submitting answers starts one continuation on
  the same retained sandbox. Traces list individual runs and deep-link into
  the existing explorer. The palette and typography remain porcelain/graphite.
- **E2B sandbox selection (2026-10-20)** — `SAILOR_SANDBOX=e2b` selects
  Anchor's E2B adapter for runs and smoke checks; Heyo remains the default.
  `E2B_TEMPLATE` names the consumer's template. `image/e2b.Dockerfile` and
  `image/build-e2b.mjs` build the Sailor toolchain without Heyo boot plumbing.
  The published `sailor-toolchain:latest` template passed the toolchain smoke
  in 8.8s, including 3.0s to start and clone. No agent run was triggered.
- **The toolchain artifact, published (2026-10-20)** — the Heyo store accepted
  the 4 GiB rootfs (`heyctl artifact push`, public tag
  `harness/sailor-toolchain:latest`), after the owner's fix. `image/build.sh`
  now builds a real ext4 (docker export → `mke2fs -d` in a Linux container,
  since macOS cannot set root ownership) and pushes it. `.env` runs
  `HEYO_IMAGE_KIND=artifact`; Sailor gained `HEYO_IMAGE_STORE` for a
  namespace-scoped store. Smoke passed: boot **125.6s** (was 207s with the
  git clone-and-build), toolchain green (git/python/pytest/node/npm/rg).
- **The extraction (2026-10-19)** — Anchor published: `anchor-ai-sdk@0.1.0` on
  npm, its own repo with full history, CI, README, logo, examples, and
  decision log; Sailor consumes it from the registry. `packages/core` and
  `apps/evals` deleted from this monorepo; repo renamed `sailor`. Full story:
  DECISIONS #65–#66.
- **Milestone “Anchor runs evals and stands alone”** — done. The benchmark
  harness lives at `anchor-ai-sdk/evals` with the results artifacts
  (`comparison.md`, `verdicts.jsonl`); rounds resume there.
- **Issue-fix quality and evidence (2026-10-19)** — the prompt now reads "the
  reported failure" as the defect wherever it occurs (siblings and callers that
  share the cause), requires declined follow-ups to be posted on the issue
  rather than only in chat, and raises verification to re-runnable evidence
  when a repo has no suite. Decision #70. Follow-up, Anchor-side: export the
  prompt components so products can append instead of interpreting from
  outside.
