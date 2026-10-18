import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockWorkspace, manualStream, emitLive, detail } from "./fixtures";

test("thread list: search, filter, accessible navigation and theme persistence", async ({
  page,
}, info) => {
  const errors = await mockWorkspace(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Handle empty batches gracefully" }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Search threads" })
    .fill("does-not-exist");
  await expect(page.getByText("No matching threads")).toBeVisible();
  await page.getByRole("textbox", { name: "Search threads" }).clear();
  await page.getByRole("tab", { name: /Active/ }).click();
  await expect(page.getByText("No matching threads")).toBeVisible();
  await page.getByRole("tab", { name: /All threads/ }).click();
  await page.screenshot({ path: info.outputPath("threads-light.png") });
  await page
    .getByRole("main")
    .getByRole("button", { name: "Toggle Sidebar" })
    .click();
  await expect(
    page.locator('[data-slot="sidebar"][data-state="collapsed"]'),
  ).toBeVisible();
  await expect(page.locator("[data-sidebar-label]:visible")).toHaveCount(0);
  const rail = await page
    .locator('[data-slot="sidebar-container"]')
    .boundingBox();
  const settingsLink = await page
    .getByRole("link", { name: "Settings", exact: true })
    .boundingBox();
  expect(settingsLink!.x + settingsLink!.width).toBeLessThanOrEqual(
    rail!.x + rail!.width,
  );
  await page.screenshot({ path: info.outputPath("threads-collapsed.png") });
  await page
    .getByRole("main")
    .getByRole("button", { name: "Toggle Sidebar" })
    .click();
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(
    page.getByRole("heading", { name: "Handle empty batches gracefully" }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("threads-dark.png") });
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(audit.violations).toEqual([]);
  expect(errors).toEqual([]);
});

test("conversation: draft survives failure, retry sends, trace is the entire thread", async ({
  page,
}, info) => {
  const errors = await mockWorkspace(page, { failSend: true });
  await page.goto("/threads/thread-1");
  await expect(
    page.getByRole("article", { name: "Agent response" }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("conversation-light.png") });
  const composer = page.getByRole("textbox", { name: "Message the agent" });
  await composer.fill("What changed?");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not send");
  await expect(composer).toHaveValue("What changed?");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await page.getByRole("tab", { name: "Trace", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Entire thread/ }),
  ).toBeVisible();
  const workspace = await page.locator("[data-trace-workspace]").boundingBox();
  expect(workspace!.y).toBeLessThan(165);
  await page.getByRole("button", { name: /^run · label/ }).click();
  await expect(
    page.getByRole("heading", { name: "run · label" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Metadata", exact: true }).click();
  await page.getByRole("button", { name: "Metadata", exact: true }).click();
  await page.screenshot({ path: info.outputPath("trace-light.png") });
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await page.screenshot({ path: info.outputPath("trace-dark.png") });
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(audit.violations).toEqual([]);
  expect(errors).toEqual([]);
});

test("settings: repo switches, disable-all save, discard, appearance", async ({
  page,
}, info) => {
  const errors = await mockWorkspace(page);
  await page.goto("/settings");
  const control = page.getByRole("switch", {
    name: "Enable acme/worker-service",
  });
  await expect(control).toBeChecked();
  await control.click();
  await expect(
    page.getByRole("button", { name: "Save changes" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(control).toBeChecked();
  await control.click();
  const save = page.waitForRequest(
    (req) =>
      req.url().endsWith("/api/onboarding/repos") && req.method() === "POST",
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  expect((await save).postDataJSON().enabled).toEqual([]);
  await page
    .getByRole("heading", { name: "Workspace settings" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("settings-light.png"),
    fullPage: true,
  });
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole("tab", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.screenshot({
    path: info.outputPath("settings-dark.png"),
    fullPage: true,
  });
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(audit.violations).toEqual([]);
  expect(errors).toEqual([]);
});

test("busy chat: explicit interjection remains available", async ({ page }) => {
  await mockWorkspace(page, { active: true });
  await page.goto("/threads/thread-1");
  await page
    .getByRole("textbox", { name: "Message the agent" })
    .fill("Please pause and explain the plan.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("button", { name: "Interject", exact: true }).click();
  await expect(
    page.getByText("Interjected. The agent will pick this up next."),
  ).toBeVisible();
});

test("mobile and reduced motion: no horizontal overflow, navigation works", async ({
  page,
}, info) => {
  const errors = await mockWorkspace(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/threads/thread-1");
  await expect(
    page.getByRole("textbox", { name: "Message the agent" }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("chat-mobile.png") });
  await page.getByRole("tab", { name: "Trace", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Entire thread/ }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("trace-mobile.png") });
  await page.getByRole("button", { name: /Entire thread/ }).click();
  await expect(
    page.getByRole("heading", { name: "Entire thread" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Toggle Sidebar" }).click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Workspace settings" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("login and onboarding share the same controls and labels", async ({
  page,
}, info) => {
  await mockWorkspace(page);
  await page.goto("/login");
  await expect(page.getByLabel("Email address")).toBeVisible();
  await page.getByRole("tab", { name: "Create account", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Create workspace" }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("login-light.png") });
  await page.goto("/onboarding");
  await expect(
    page.getByRole("heading", { name: "Where should we work?" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Continue with current selection" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your next fix is a label away." }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("onboarding-light.png") });
});

test("stream: missed start, reasoning, tool verbs between replies, completion and refresh", async ({
  page,
}, info) => {
  const errors = await mockWorkspace(page, { active: true });
  await manualStream(page);
  await page.goto("/threads/thread-1");
  await expect(page.getByText("Working on it", { exact: true })).toBeVisible();
  // No llm_started frame: connecting mid-call must not discard deltas.
  await emitLive(page, {
    kind: "reasoning",
    step: 1,
    sequence: 1,
    text: "Checking project history.",
  });
  await expect(
    page.getByText("Checking project history.", { exact: true }),
  ).toBeVisible();
  await emitLive(page, {
    kind: "delta",
    step: 1,
    sequence: 2,
    text: "I’ll check the README.",
  });
  await expect(
    page.getByText("I’ll check the README.", { exact: true }),
  ).toBeVisible();
  await emitLive(page, {
    kind: "assistant_done",
    step: 1,
    sequence: 3,
    text: "I’ll check the README.",
    reasoning: "Checking project history.",
    reasoningTokens: 5,
  });
  await emitLive(page, {
    kind: "tool_call",
    step: 1,
    sequence: 4,
    name: "read_file",
    callId: "read-1",
    verb: "Reading README.md",
    input: { path: "README.md" },
  });
  await expect(
    page.getByRole("button", { name: "Reading README.md", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await emitLive(page, {
    kind: "tool_result",
    step: 1,
    sequence: 5,
    name: "read_file",
    callId: "read-1",
    verb: "Reading README.md",
    content: "# Worker service",
    ok: true,
  });
  await emitLive(page, {
    kind: "llm_started",
    step: 2,
    sequence: 6,
    phase: "respond",
  });
  await emitLive(page, {
    kind: "delta",
    step: 2,
    sequence: 7,
    text: "The README is complete.",
  });
  const activity = page.getByRole("button", {
    name: "1 action completed",
    exact: true,
  });
  await expect(activity).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByText("I’ll check the README.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("The README is complete.", { exact: true }),
  ).toBeVisible();
  await emitLive(page, {
    kind: "assistant_done",
    step: 2,
    sequence: 8,
    text: "The README is complete.",
  });
  await emitLive(page, {
    kind: "run_finished",
    step: 2,
    sequence: 9,
    summary: "The README is complete.",
    ok: true,
  });
  await expect(page.getByText("Working on it", { exact: true })).toHaveCount(0);
  await activity.click();
  await expect(
    page.getByText("# Worker service", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("5 reasoning tokens", { exact: false }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("chat-activity.png") });

  // Rehydrate from persisted blocks with the same stable IDs after refresh.
  const parts = [
    {
      id: "reasoning-1",
      kind: "reasoning",
      step: 1,
      sequence: 3,
      text: "Checking project history.",
      reasoningTokens: 5,
      complete: true,
    },
    {
      id: "text-1",
      kind: "text",
      step: 1,
      sequence: 3,
      text: "I’ll check the README.",
      complete: true,
    },
    {
      id: "tool-1-read-1",
      kind: "tool",
      step: 1,
      sequence: 5,
      name: "read_file",
      verb: "Reading README.md",
      callId: "read-1",
      input: { path: "README.md" },
      content: "# Worker service",
      ok: true,
      complete: true,
    },
    {
      id: "text-2",
      kind: "text",
      step: 2,
      sequence: 8,
      text: "The README is complete.",
      complete: true,
    },
  ];
  await page.route("**/api/threads/thread-1", (route) =>
    route.fulfill({
      json: {
        ...detail,
        runs: [
          {
            ...detail.runs[0],
            agentText: "The README is complete.",
            conversation: { parts, sequence: 9, finished: true },
          },
        ],
      },
    }),
  );
  await page.reload();
  await expect(
    page.getByText("The README is complete.", { exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "1 action completed", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await page
    .getByRole("button", { name: "1 action completed", exact: true })
    .click();
  await expect(
    page.getByText("# Worker service", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("reconciliation: a lost completion nudge never requires a browser refresh", async ({
  page,
}) => {
  await mockWorkspace(page, { active: true });
  await manualStream(page);
  let completed = false;
  await page.route("**/api/threads/thread-1", (route) =>
    route.fulfill({
      json: {
        ...detail,
        runs: [
          {
            ...detail.runs[0],
            status: completed ? "succeeded" : "running",
            agentText: completed ? "Recovered the completed reply." : null,
            conversation: {
              parts: completed
                ? [
                    {
                      id: "text-1",
                      kind: "text",
                      step: 1,
                      sequence: 8,
                      text: "Recovered the completed reply.",
                      complete: true,
                    },
                  ]
                : [],
              sequence: completed ? 9 : 0,
              finished: completed,
            },
          },
        ],
      },
    }),
  );
  await page.goto("/threads/thread-1");
  await expect(page.getByText("Working on it", { exact: true })).toBeVisible();
  completed = true; // No SSE frame is sent. The bounded reconciliation catches up.
  await expect(
    page.getByText("Recovered the completed reply.", { exact: true }),
  ).toBeVisible({ timeout: 6000 });
  await expect(page.getByText("Working on it", { exact: true })).toHaveCount(0);
});
