import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve the workspace package to its source (same target as the tsconfig
// paths entry) so vitest needs no build step for anchor-ai-sdk.
export default defineConfig({
  resolve: {
    alias: [
      {
        // Exact match only — a string alias would prefix-capture subpaths.
        find: /^anchor-ai-sdk$/,
        replacement: fileURLToPath(
          new URL("../../packages/core/src/index.ts", import.meta.url),
        ),
      },
      {
        find: /^anchor-ai-sdk\/sandbox\/heyo$/,
        replacement: fileURLToPath(
          new URL(
            "../../packages/core/src/sandbox/heyo/index.ts",
            import.meta.url,
          ),
        ),
      },
      {
        find: /^anchor-ai-sdk\/sandbox\/local$/,
        replacement: fileURLToPath(
          new URL(
            "../../packages/core/src/sandbox/local/index.ts",
            import.meta.url,
          ),
        ),
      },
    ],
  },
  test: {
    // App tests share the database and the queues; parallel files would race
    // on unique keys and interfere with each other's sweeps.
    fileParallelism: false,
  },
});
