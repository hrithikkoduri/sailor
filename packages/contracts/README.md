# @sailor/contracts

The wire format shared by the Sailor server and dashboard: Zod schemas plus the
types inferred from them. One shape definition means a breaking change is a
compile error on both sides instead of a runtime mismatch.

```bash
npm install @sailor/contracts
```

```ts
import { threadState, type ThreadState } from "@sailor/contracts";

const state: ThreadState = threadState.parse("running");
```

- ESM only, Node 20+.
- Data-only: no framework imports, no server or dashboard code.
- Additive changes are minor versions; removing or renaming a field is major.

## Publishing

The package is built to `dist/` and published from the workspace root:

```bash
npm run build:contracts
npm publish -w packages/contracts --access public
```

CI publishes on a `contracts-v*` tag when the `NPM_TOKEN` secret is present.
The npm scope (`@sailor`) must exist and the token must be allowed to publish to it.
