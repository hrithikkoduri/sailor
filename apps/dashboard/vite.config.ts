import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The API + auth live in `harness serve` (apps/harness, :8787). In dev we
// proxy to it; production will serve the built assets from the same origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
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
});
