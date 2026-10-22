import { defineConfig } from "vitest/config";

// anchor-ai-sdk resolves through node_modules — a real install of the
// extracted package (github:hrithikkoduri/anchor-ai-sdk#v0.1.0), not source
// aliases. The package repo owns its src now; this app owns none of it.
export default defineConfig({
  test: {
    // App tests share the database and the queues; parallel files would race
    // on unique keys and interfere with each other's sweeps.
    fileParallelism: false,
    // Keeps test jobs off the dev stack's Redis database (see tests/setup.ts).
    setupFiles: ["tests/setup.ts"],
  },
});
