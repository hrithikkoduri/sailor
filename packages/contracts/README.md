# @sailor/contracts

The wire format shared by the Sailor server and dashboard: Zod schemas plus the
types inferred from them. One shape definition means a breaking change is a
compile error on both sides instead of a runtime mismatch.

The package is **not published to npm**. Sailor core consumes it through the
workspace; the private cloud layer consumes a packed tarball.

```bash
# from the repository root
npm run contracts:pack
# -> artifacts/sailor-contracts-0.1.0.tgz

# in the consuming package
npm install /path/to/sailor/artifacts/sailor-contracts-0.1.0.tgz
```

```ts
import { threadState, type ThreadState } from "@sailor/contracts";

const state: ThreadState = threadState.parse("running");
```

- ESM only, Node 20+.
- Data-only: no framework imports, no server or dashboard code.
- Additive changes are minor versions; removing or renaming a field is major.
- `prepack` builds `dist/`, so the tarball is always generated from source.
