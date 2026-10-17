import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve the workspace package to its source (same target as the tsconfig
// paths entry) so vitest needs no build step for @harness/agent.
export default defineConfig({
  resolve: {
    alias: {
      "@harness/agent": fileURLToPath(new URL("../../packages/agent/src/index.ts", import.meta.url)),
    },
  },
});
