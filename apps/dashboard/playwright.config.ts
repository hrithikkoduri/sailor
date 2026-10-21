import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  workers: 2,
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:5186",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: {
    // A production bundle avoids cold dependency-optimizer waits on machines
    // with a synced filesystem. Run the dashboard build before this mode.
    command: process.env.PLAYWRIGHT_PREVIEW === "1"
      ? "npm run preview -- --host 127.0.0.1 --port 5186 --strictPort"
      : "npm run dev -- --host 127.0.0.1 --port 5186 --strictPort",
    url: "http://127.0.0.1:5186",
    reuseExistingServer: false,
  },
});
