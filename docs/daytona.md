# Daytona sandbox backend

Sailor can run the agent in three sandbox backends: **Heyo** (Firecracker
microVMs, the default), **E2B** (cloud sandboxes booted from templates), and
**Daytona** (cloud workspaces booted from snapshots). This guide walks through
selecting Daytona, what it expects, and its current status.

## Selection

`SAILOR_SANDBOX` picks the backend at config load (`apps/server/src/config.ts`
→ `sandboxProvider()`):

```env
SAILOR_SANDBOX=daytona
DAYTONA_API_KEY=...        # from the Daytona dashboard (app.daytona.io)
DAYTONA_IMAGE=sailor-toolchain:latest
```

The choice flows through the whole system the same way E2B does:

```
.env / env vars
  → loadConfig()               .sandbox = "daytona", .daytona = { apiKey, image }
  → sandboxProvider(cfg)       apps/server/src/sandbox-provider.ts — the ONE routing point
  → daytonaProvider(cfg)       apps/server/src/daytona-provider.ts — translates config → Anchor options
  → anchor-ai-sdk              the SandboxProvider contract (create/adopt/release/probe)
```

A retained thread adopts the backend it was created on: `sandboxBackend` is
recorded per thread (`"daytona"` alongside `"heyo"`/`"e2b"`/`"local"`) and
`providerForBackend()` routes a resume back to Daytona.

## Current status: wired but inactive

Sailor's side is complete — config, routing, provider file, schema. What is
missing is the **anchor-ai-sdk Daytona adapter**: `anchor-ai-sdk@0.1.x` ships
`src/sandbox/daytona` as a stub whose factory throws "coming soon", and the
`./sandbox/daytona` subpath is not in the published package's `exports` map.
Until the SDK ships it, `SAILOR_SANDBOX=daytona` fails loudly at provider
construction with a pointer here — never a silent fall-back to heyo, which
would resume a Daytona-retained thread on the wrong machine.

## Activation checklist (what the SDK adapter must provide)

Anchor's provider contract (`anchor-ai-sdk`, `SandboxProvider`) decides
"done"; the acceptance test is `runSandboxConformance(provider)` —
exec fidelity, self-containment, kill deadlines, env secrets, checkpoints,
destroy idempotence, retain/adopt, git identity, and push-failure reporting.
A backend ships when that suite passes, not before.

To activate once the SDK adapter lands:

1. **Bump `anchor-ai-sdk`** to a release whose `exports` map includes
   `./sandbox/daytona` and whose `daytona({...})` factory is real.
2. **Replace the throw** in `apps/server/src/daytona-provider.ts` with the
   mirror of `e2b-provider.ts`:

   ```ts
   import { daytona } from "anchor-ai-sdk/sandbox/daytona";

   export function daytonaProvider(cfg: SailorConfig): SandboxProvider {
     return daytona({
       ...(cfg.daytona.apiKey ? { apiKey: cfg.daytona.apiKey } : {}),
       image: cfg.daytona.image,
     });
   }
   ```

3. **Build a toolchain snapshot** carrying git, a Python with pytest, Node 20+,
   and ripgrep — the same environment as `image/Dockerfile`. Daytona builds
   snapshots from Dockerfiles; a counterpart of `image/build-e2b.mjs`
   (`image/build-daytona.mjs`, publish `sailor-toolchain:latest`) is the
   natural shape. `DAYTONA_IMAGE` then names it.
4. **Run the conformance suite** against the provider
   (`runSandboxConformance`), then `sailor smoke --sandbox daytona` (or the
   env selection) for the toolchain-level check.
5. **Record it** in DECISIONS.md and flip this guide's status section.

## Why no silent fall-back

`providerForBackend("daytona", cfg)` returning the heyo provider would boot a
resume on a different machine than the work — the exact misclassification trap
decision #53 removed. A backend that cannot be constructed must fail the run
with a clear message, so the operator sees the missing dependency instead of a
half-working thread.
