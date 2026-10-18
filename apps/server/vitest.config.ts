import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve the workspace package to its source (same target as the tsconfig
// paths entry) so vitest needs no build step for @anchor/core.
export default defineConfig({
  resolve: {
    alias: {
      "@anchor/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    // App tests share the database and the queues; parallel files would race
    // on unique keys and interfere with each other's sweeps.
    fileParallelism: false,
  },
});
