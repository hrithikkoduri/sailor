import { test, expect } from "@playwright/test";
import { mockWorkspace, manualStream, emitLive } from "./fixtures";

test("composer phase trail: lists the approach, shimmers the active phase, hides on completion", async ({
  page,
}, info) => {
  await mockWorkspace(page, { active: true });
  await manualStream(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/threads/thread-1");
  await expect(
    page.getByRole("textbox", { name: "Message the agent" }),
  ).toBeVisible();
  const trail = page.getByTestId("phase-trail");
  await expect(trail).toHaveCount(0); // nothing until the run reports its phases

  await emitLive(page, {
    kind: "started",
    sequence: 1,
    phases: ["understand", "act", "validate", "respond"],
  });
  await emitLive(page, { kind: "phase", sequence: 2, phase: "understand" });
  await expect(trail).toBeVisible();
  await expect(page.locator('[data-phase-state="current"]')).toHaveText(
    "Understand",
  );
  await expect(page.locator('[data-phase-state="upcoming"]')).toHaveText([
    "Act",
    "Validate",
    "Respond",
  ]);

  await emitLive(page, { kind: "phase", sequence: 3, phase: "act" });
  const current = page.locator('[data-phase-state="current"]');
  await expect(current).toHaveText("Act");
  await expect(current).toHaveClass(/phase-shimmer/);
  await expect(current).toHaveCSS("animation-name", "phase-shimmer");
  await expect(page.locator('[data-phase-state="visited"]')).toHaveText([
    "Understand",
  ]);

  // Reduced motion: the current phase renders as plain ink, not a sweep.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(current).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.screenshot({ path: info.outputPath("phase-trail.png") });

  // Completion hides the strip immediately — no lingering ghost phase.
  await emitLive(page, {
    kind: "run_finished",
    sequence: 4,
    ok: true,
    summary: "Done.",
  });
  await expect(trail).toHaveCount(0);
});

test("phase trail survives refresh mid-run from the journal", async ({
  page,
}, info) => {
  await mockWorkspace(page, { active: true });
  await manualStream(page);
  const parts: never[] = [];
  await page.route("**/api/threads/thread-1", (route) =>
    route.fulfill({
      json: (() => {
        const base = {
          thread: {
            id: "thread-1",
            repo: "acme/worker-service",
            issueNumber: 42,
            state: "running",
            source: "github",
            prNumber: null,
            prUrl: null,
            headRef: "sailor/issue-42",
            baseRef: "main",
            phase: "understand",
            summary: null,
            turnsUsed: 2,
            budgetMaxTurns: 20,
            usdSpent: "0.01",
            budgetMaxUsd: "10",
            checkpointSha: null,
            watch: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          runs: [
            {
              id: "run-1",
              status: "running",
              trigger: "inbox",
              agent: "chat",
              phase: null,
              disposition: null,
              error: null,
              task: "review only",
              startedAt: new Date().toISOString(),
              finishedAt: null,
              createdAt: new Date().toISOString(),
              agentText: null,
              conversation: {
                parts,
                sequence: 2,
                finished: false,
                phases: ["understand", "act", "validate", "respond"],
                visited: ["understand", "validate"],
                phase: "validate",
              },
            },
          ],
          events: [],
          pendingEvents: [],
        };
        return base;
      })(),
    }),
  );
  await page.goto("/threads/thread-1");
  const trail = page.getByTestId("phase-trail");
  await expect(trail).toBeVisible();
  await expect(page.locator('[data-phase-state="current"]')).toHaveText(
    "Validate",
  );
  await expect(page.locator('[data-phase-state="visited"]')).toHaveText([
    "Understand",
  ]);
  await page.screenshot({ path: info.outputPath("phase-trail-refresh.png") });
});
