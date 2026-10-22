import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The API + auth live in `sailor serve` (apps/server, :8787). In dev we
// proxy to it; production will serve the built assets from the same origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Workspace package ships TypeScript source; let Vite transform it.
      "@sailor/contracts": fileURLToPath(
        new URL("../../packages/contracts/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/auth": "http://localhost:8787",
      "/setup": "http://localhost:8787",
      "/healthz": "http://localhost:8787",
    },
  },
  // `npm run build -w apps/dashboard && npm run preview -w apps/dashboard`
  // serves the production bundle against a locally running `sailor serve`.
  preview: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/auth": "http://localhost:8787",
      "/setup": "http://localhost:8787",
      "/healthz": "http://localhost:8787",
    },
  },
});
