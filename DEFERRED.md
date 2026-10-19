# Deferred work — the contributor ledger

Everything here is a decision already made and work intentionally not built
yet. Each item names the event that pulls it back ("trigger"), where it lives,
and its rough size, so anyone can pick one up without reading the whole
history.

**How to pick one up**

1. Open an issue naming the item (one item per PR keeps review small).
2. Two rules the codebase never breaks: **mechanics in `@anchor/core`**
   (`packages/core`), **policy in Sailor** (`apps/server`, `apps/dashboard`);
   and Anchor never reads configuration — options go in, nothing touches env.
3. Gate every change with:
   ```bash
   npm run typecheck
   npm test -w packages/core
   npm test -w apps/server
   npm run test:ui -w apps/dashboard          # dashboard changes
   RUN_LIVE_HEYO_TESTS=0 \
     DATABASE_URL=postgres://sailor:sailor@localhost:5432/sailor_test \
     REDIS_URL=redis://localhost:6379/15 npm run test:integration -w apps/server
   ```
4. When an item ships: delete it here, record the decision in `DESIGN.md`.

## Tracing & observability

- **OTel trace sink** — translate `AgentEvent`s into OTLP spans; one adapter
  reaches Langfuse / Honeycomb / Datadog / Grafana. Needs the `traceSinks`
  fan-out first (run pipeline below). _Where:_ new `packages/trace-otel`.
  _Trigger:_ wanting hosted traces. _Size:_ S–M.
- **LangSmith adapter** — map run/step/tool events to LangSmith runs + spans.
  _Where:_ new `packages/trace-langsmith`. _Trigger:_ actively using LangSmith.
  _Size:_ S.
- **Braintrust adapter (tracing + evals)** — same stream also builds eval
  records for step 15. _Where:_ new `packages/trace-braintrust`.
  _Trigger:_ actively using Braintrust. _Size:_ S.
- **Export tool-author helpers** — `requireString`, `requireSandbox`,
  `formatExec` are internal to `tools/types.ts`; Sailor validates inline.
  _Where:_ `packages/core/src/tools/index.ts` exports. _Trigger:_ next tool
  authored outside Sailor. _Size:_ XS — good first issue.

## Sandbox providers

- **E2B adapter** — implement `create/adopt/release/probe` for E2B (exec,
  clone, checkpoint, retain) and pass the conformance suite. _Where:_
  `packages/core/src/sandbox/e2b.ts` + `@anchor/core/sandbox/e2b` subpath.
  _Trigger:_ a second VM vendor is needed (region, cost, comparison).
  _Size:_ M.
- **Daytona adapter** — same shape as E2B. _Where:_
  `packages/core/src/sandbox/daytona.ts`. _Trigger:_ same. _Size:_ M.
- **Egress control enforcement** — capability flag lands with the provider
  interface; enforcement (per-VM allowlists) waits for a provider that
  supports it. _Where:_ `packages/core/src/sandbox/`. _Trigger:_ a product
  needs network restriction. _Size:_ M.
- **Artifact→git image fallback chain** — try the primary image source; on job
  failure, destroy and recreate from the secondary. Remember to widen the
  build-secret refresh condition to "git anywhere in the chain". _Where:_
  `packages/core/src/sandbox/heyo/index.ts` `start()`, `apps/server/src/runs/execute.ts`.
  _Trigger:_ artifact kind primary in production **and** store flakiness seen
  on pulls. _Size:_ S–M.
- **Publish the ext4 + flip `HEYO_IMAGE_KIND=artifact`** — blocked externally:
  Heyo's namespace artifact store rejects uploads (`Broken pipe` at 1 GiB,
  `502 app-lb could not reach its artifact store` at 64 MiB, `setRepo` 502).
  The rootfs is built and verified locally. _Trigger:_ store heals → one
  `heyctl artifact push rootfs.ext4 --tag harness/sailor-toolchain:latest` +
  env flip. _Size:_ S (blocked externally).
- **`fork()` (checkpoint → new VM)** — start a second sandbox from a
  checkpoint for best-of-N races. _Where:_ `packages/core/src/sandbox/`.
  _Trigger:_ best-of-N work starts (BUILD*PLAN step 14). \_Size:* M.
- **Retained-sandbox janitor TTL** — parked VMs live until their thread is
  terminal; a TTL bounds long-idle cost. _Where:_ a sweep in
  `apps/server/src/worker/sweep.ts`. _Trigger:_ cost visibility on the Heyo
  bill. _Size:_ S.
- **Ports/routes for non-coding sandboxes** — `HeyoSandbox` hardcodes
  `routes: []` (private: exec/shell only). A consumer running a dev server or
  a browser task needs exposed ports/preview routes on the deployment spec.
  _Where:_ `packages/core/src/sandbox/heyo/index.ts` (`HeyoSandboxConfig.routes`,
  health port). _Trigger:_ first non-coding consumer needing HTTP. _Size:_
  S–M.

## Run pipeline — pick-ups in `@anchor/core`

These are independent; the "depends on" notes say when order matters.

- **Git-credential callback** — replace the one-shot `githubToken` with
  `git: { token: () => Promise<string> }` on the sandbox spec so providers
  re-resolve credentials per clone/push; fixes runs longer than the 1-hour
  installation-token lifetime silently pushing with stale credentials. It also
  generalizes the credential host — the credentials file hardcodes
  `github.com`, the one thing between clone/push and any git host (Bitbucket,
  Azure DevOps).
  _Where:_ `packages/core/src/sandbox/types.ts` + adapters,
  `apps/server/src/runs/execute.ts`. _Trigger:_ none — correctness fix, ready
  now. _Size:_ S–M.
- **`createAnchor` facade** — ~20 lines of sugar over the run-pipeline calls
  (captures llm/provider/stores, returns `{ run, doctor }`). _Trigger:_ a
  second consumer wants the same wiring bundle (the eval CLI at step 15
  likely). _Size:_ XS once the items above land.

## Product & UX (Sailor)

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
- **Baseline-relative suite evidence** — FAIL*TO_PASS / PASS_TO_PASS deltas:
  `run_tests` gains `junit_path` → `meta.tests` (JUnit XML regex parse);
  success = no baseline-passing test regresses. \_Where:*
  `packages/core/src/tools/run-tests.ts`, step-15 task JSON.
  _Trigger:_ evals on real repos whose `main` is not green. _Size:_ M.
- **`blocked` → user channel** — package carries `disposition: "blocked"` +
  summary; Sailor posts it as a comment + `agent:needs-input` label and the
  human reply becomes the next event. _Where:_ `apps/server/src/github/`.
  _Trigger:_ step 13 client wiring. _Size:_ S.

## Forge providers (git hosts)

- **Bitbucket / Azure DevOps adapters** — Sailor's GitHub layer (App auth +
  installation tokens, webhook parsing and signature checks, review/comment
  interjection, checks, PR publication, the `<slug>[bot]` self-identity) has
  no equivalent for other forges. An adapter mirrors those surfaces per host
  (Bitbucket: app passwords/OAuth + webhooks; Azure DevOps: PATs/service
  hooks + PR/review APIs). Anchor is unaffected — sandbox clone/push is plain
  git once the credential host generalizes (see the git-credential callback
  item above). _Trigger:_ first non-GitHub consumer or workspace. _Size:_ M
  each.

## The path we are working — milestone: Anchor runs evals and stands alone

Two goals: (1) **Anchor + Sailor's agent config runs a SWE-bench subset** end to
end, graded by the official harness, with an A/B against a minimal harness at
the same model; (2) **the package is tight enough that a stranger installs
`@anchor/core` and drives it**. Ordered work:

**Phase 0 — quick package wins (help eval runs and daily work)**

- `edit_file` batching: 4 sandbox execs → 2 (`wc+cat` in one; `write+verify`
  in one) — ~4s back per edit on Heyo, ×~20 edits per run. Needs care: match
  semantics stay in TS; only the transport merges.
- Git-credential callback + credential-host generalization (replace the one-
  shot `githubToken`; the credentials file's `@github.com` is the last
  forge-ism in clone/push).
- Export the tool-author helpers (`requireString`, `optionalString`,
  `requireSandbox`, `formatExec`).

**Phase 1 — the eval runner (the harness benchmark; drives Anchor directly)**

- `apps/evals`: a repo-level app — no worker/queue/webhook — that imports
  `@anchor/core` directly and runs task JSONL (SWE-bench Lite subset) through
  pluggable arms: "sailor" (createSailorAgent minus GitHub tools) and
  "mini-swe-agent" (subprocess, same model). Sandbox = the toolchain VM
  (public repos clone with no credentials; producing a patch needs no
  installed deps).
- Per task: fresh sandbox at base commit → arm runs → `git diff` →
  `predictions.jsonl` + per-task trace + cost. Keep the runner loop as ONE
  isolated module — it's the future Anchor lift (`anchor eval`).
- Grader: official `swebench` harness locally in Docker; parse the report.
- Baseline arm: mini-swe-agent, same model — "minimal harness A% vs Sailor's
  agent on Anchor B%".
- Report: solve rate, $/task, p50/p95 time, failure modes (repro-failed /
  wrong-fix / timeout / budget / loop / tool-error).
- Contamination controls (the 2026-10-18 smoke produced the verbatim gold
  patch — the model has Lite memorized): flag exact/near gold matches at
  grading time; add SWE-bench-Verified as a second subset; keep the
  seeded-bug track (repos we control, post-cutoff commits) as the
  contamination-free complement.
- Package item the checklist wants: `run_tests` gains `junit_path` →
  `meta.tests` (FAIL_TO_PASS / PASS_TO_PASS baseline — step 15 pre-eval
  checklist).

**Phase 3 — pull the primitives home (Sailor → Anchor)**

- Sailor ends as: rows, webhooks, GitHub, dashboard, stores.

**Phase 4 — extraction (the runbook)**

Ready: `scripts/extract-anchor.sh` (git subtree split — full history), and
things that ride the split: `LICENSE`, the build config, `DECISIONS.md`, and
`.github/workflows/ci.yml` (nested outside the monorepo's root, so it becomes
the new repo's CI from day one). Remaining steps, in order:

1. **Claim the names first** (irreversible): `scripts/publish-claim.sh`
   prepares the 0.0.1 publish in a temp copy (dist-flipped, built, dry-run);
   then `npm publish` from that copy (2FA). Reserve GitHub
   `hrithikkoduri/anchor-ai-sdk` and the domain `anchor-sdk.dev` the same day.
2. **Run the split** (`scripts/extract-anchor.sh` — filter-repo over all
   three path eras: root `src/{llm,sandbox,tools}`, `packages/agent`,
   `packages/core`; subtree split would drop the first acts) → first commit
   in the new repo: `node scripts/prepare-publish.mjs` + `"prepare": "npm run
build"` + version 0.1.0. The prepublishOnly guard refuses a src-flavored
   publish.
3. **Push** → CI runs on the carried workflow (typecheck, unit + local
   conformance, docker conformance; live Heyo stays manual/secret-gated).
4. **Publish** `anchor-ai-sdk@0.1.0`.
5. **Switch Sailor over in ONE change**: dependency (github:…#v0.1.0 or npm
   release) — imports are already `anchor-ai-sdk` (renamed pre-split), so
   this is the dependency source, tsconfig paths + vitest aliases, delete
   `packages/core`, and moving `apps/evals` into the package repo.
6. **Product page**: README (positioning, quickstart, provider table with
   capabilities + conformance status, eval-results link) + `examples/` (one
   standalone local-sandbox run; one non-coding agent).
7. **Benchmark rounds resume in the new repo**: Opus 5.5 on Lite-10 (budgets
   capped), then TerminalBench / METR / ProgramBench as `benchmarks/<name>/`.

**Not blocking any of the above:** E2B/Daytona adapters, OTel/LangSmith
adapters, forge adapters, the ext4 artifact publish, `fork()`, janitor TTL.

## Model providers

- **Native Anthropic / Gemini adapters** — first-class clients (not the
  OpenAI-compat shim) incl. **opaque reasoning replay** (carry signed
  reasoning blocks across turns). _Where:_ `packages/core/src/llm/`.
  _Trigger:_ actually running those models. _Size:_ M / S.
- **`cache_control` markers** — for providers that require explicit cache
  breakpoints. _Where:_ `packages/core/src/llm/`. _Trigger:_ an
  opt-in-caching provider is used. _Size:_ XS.
- **Vercel AI-SDK bridge** — adapter over `LLMClient`. _Where:_ new
  `packages/llm-ai-sdk`. _Trigger:_ a third ecosystem asks. _Size:_ M.

## Program-level

- **Steps 14 (best-of-N), 15 (evals), 19 (write-up), 20/21 (stretch)** — see
  `BUILD_PLAN.md`.
- **Heyo platform issues (operator-dependent)** — artifact-store upload path
  (`Broken pipe` / `502` / `setRepo` credential refusal),
  `get.us2.heyo.work` TLS handshake failure. Reported via the owner; retry
  when acknowledged. Details in `BUILD_PLAN.md` step 16.
