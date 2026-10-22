import { test, expect } from "@playwright/test";
import { mockWorkspace, manualStream, emitLive } from "./fixtures";

// Providers deliver text in bursts. The UI reveals a burst progressively
// (once per frame) and still finishes promptly; reduced motion shows it at once.

const burst = Array.from({ length: 12 }, (_, i) => `Sentence ${i + 1} explains one more step of the fix.`).join(" ");

test("a streamed burst is revealed progressively, then completely", async ({ page }) => {
  // This machine reports reduced motion; pin the default explicitly.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await mockWorkspace(page, { active: true });
  await manualStream(page);
  await page.goto("/threads/thread-1");
  const response = page.getByRole("article", { name: "Agent response" });
  await expect(response).toHaveAttribute("aria-busy", "true");

  await emitLive(page, { kind: "delta", step: 1, sequence: 2, text: burst });
  // A moment later only part of the burst is on screen…
  await page.waitForTimeout(80);
  const partial = (await response.locator(".prose-sailor").innerText()).length;
  expect(partial).toBeGreaterThan(0);
  expect(partial).toBeLessThan(burst.length);
  // …and the whole burst arrives within the catch-up window.
  await expect(response).toContainText("Sentence 12 explains one more step of the fix.", { timeout: 1500 });
});

test("reduced motion shows streamed text immediately", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockWorkspace(page, { active: true });
  await manualStream(page);
  await page.goto("/threads/thread-1");
  const response = page.getByRole("article", { name: "Agent response" });
  await expect(response).toHaveAttribute("aria-busy", "true");
  await emitLive(page, { kind: "delta", step: 1, sequence: 2, text: burst });
  await expect(response).toContainText("Sentence 12 explains one more step of the fix.", { timeout: 200 });
});
