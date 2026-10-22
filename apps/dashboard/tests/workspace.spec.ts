import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  mockWorkspace,
  manualStream,
  emitLive,
  detail,
  trace,
  settleTheme,
} from "./fixtures";

test("thread list: search, filter, accessible navigation and theme persistence", async ({
  page,
}, info) => {
  const errors = await mockWorkspace(page);
  await page.goto("/threads");
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    "href",
    "/favicon.svg",
  );
  const favicon = await page.request.get("/favicon.svg");
  expect(favicon.ok()).toBe(true);
  expect(favicon.headers()["content-type"]).toContain("image/svg+xml");
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
  await page.locator('[data-slot="sidebar-header"] [data-slot="sidebar-trigger"]').click();
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
  // The header trigger collapses; the footer trigger is the keyboard-reachable
  // expand control on the sidebar.
  await page.locator('[data-slot="sidebar-footer"] [data-slot="sidebar-trigger"]').click();
  // Audit the settled expanded state, not a label mid-opacity transition.
  await expect(page.locator('[data-slot="sidebar-group-label"]')).toHaveCSS(
    "opacity",
    "1",
  );
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await settleTheme(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(
    page.getByRole("heading", { name: "Handle empty batches gracefully" }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("threads-dark.png") });
  // The list fades in after loading; audit its final colors, not blended text.
  await expect(page.getByRole("tabpanel")).toHaveCSS("opacity", "1");
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
  const response = page.getByRole("article", { name: "Agent response" });
  await expect(response.getByText("Sailor", { exact: true })).toHaveCount(0);
  await expect(response.locator("time")).toHaveCount(0);
  const home = page.getByRole("link", { name: "Sailor home" });
  const homeMark = home.locator("svg");
  expect(
    await homeMark.evaluate(
      (el) => getComputedStyle(el.parentElement!).backgroundColor,
    ),
  ).toBe("rgba(0, 0, 0, 0)");
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
  // The cache metric explains the bill: cached reads over total input.
  await expect(page.getByText("Cache", { exact: true })).toBeVisible();
  await expect(page.getByText("91%", { exact: true })).toBeVisible();
  const workspace = await page.locator("[data-trace-workspace]").boundingBox();
  expect(workspace!.y).toBeLessThan(165);
  await page.getByRole("button", { name: /^run · label/ }).click();
  await expect(
    page.getByRole("heading", { name: "run · label" }),
  ).toBeVisible();
  // Intrinsics read as their action (set_phase → "Moving into the verify
  // phase"), and the whole journal downloads as one JSON file.
  await expect(
    page.getByRole("button", { name: /Moving into the verify phase/ }),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download trace as JSON" }).click();
  const file = await downloadPromise;
  expect(file.suggestedFilename()).toBe("trace-thread-1.json");
  await page.getByRole("button", { name: "Metadata", exact: true }).click();
  await page.getByRole("button", { name: "Metadata", exact: true }).click();
  await page.screenshot({ path: info.outputPath("trace-light.png") });
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await settleTheme(page);
  await page.screenshot({ path: info.outputPath("trace-dark.png") });
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(audit.violations).toEqual([]);
  expect(errors).toEqual([]);
});

test("trace: failed tool calls are visibly red with execution error details", async ({
  page,
}, info) => {
  const errors = await mockWorkspace(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const failure = "Sandbox API error (500): Command timed out after 30 seconds";
  await page.route("**/api/threads/thread-1/trace", (route) =>
    route.fulfill({
      json: {
        ...trace,
        spans: trace.spans.map((span) =>
          span.type === "tool_call"
            ? {
                ...span,
                payload: {
                  ...span.payload,
                  name: "bash",
                  input: { command: "echo hi" },
                },
              }
            : span.type === "tool_result"
              ? {
                  ...span,
                  payload: {
                    ...span.payload,
                    name: "bash",
                    ok: false,
                    content: failure,
                    meta: { exitCode: -1, timedOut: true, durationMs: 30162 },
                  },
                }
              : span,
        ),
      },
    }),
  );
  await page.goto("/threads/thread-1?view=trace");
  const tool = page.getByRole("button", { name: /^bash Failed/ }).first();
  await expect(tool).toBeVisible();
  const row = page.locator('[data-span-status="fail"]').first();
  await expect(row.getByText("Failed", { exact: true })).toHaveCSS(
    "color",
    "rgb(191, 70, 70)",
  );
  await tool.click();
  await expect(
    page.getByRole("heading", { name: "bash", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Failure details" }),
  ).toContainText("Sandbox execution request failed");
  await expect(page.getByText(failure, { exact: false }).last()).toBeVisible();
  for (const panel of await page
    .locator('[data-slot="accordion-content"]')
    .all()) {
    await expect(panel).toHaveCSS("opacity", "1");
  }
  await page.screenshot({
    path: info.outputPath("trace-failed-tool-light.png"),
  });
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await settleTheme(page);
  await expect(row.getByText("Failed", { exact: true })).toHaveCSS(
    "color",
    "rgb(225, 149, 149)",
  );
  await page.screenshot({
    path: info.outputPath("trace-failed-tool-dark.png"),
  });
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
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
  await settleTheme(page);
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

test("busy chat: queued messages stack as bubbles, interject, and land animated", async ({
  page,
}) => {
  await mockWorkspace(page, { active: true });
  await page.goto("/threads/thread-1");
  await page
    .getByRole("textbox", { name: "Message the agent" })
    .fill("Please pause and explain the plan.");
  await page.getByRole("textbox", { name: "Message the agent" }).press("Enter");
  // Queued messages show as themselves — user bubbles in a stack on the phase
  // row — and are NOT feed messages yet.
  const stack = page.getByTestId("queued-bubbles");
  await expect(stack).toBeVisible();
  await expect(stack).toContainText("Please pause and explain the plan.");
  await expect(page.locator('[data-message-id="e3"]')).toHaveCount(0);
  // A second message peeks behind the first; hovering fans the stack out with
  // a per-message withdraw.
  await page
    .getByRole("textbox", { name: "Message the agent" })
    .fill("Also check the Watch runs.");
  await page.getByRole("textbox", { name: "Message the agent" }).press("Enter");
  await expect(stack).toContainText("Also check the Watch runs.");
  await stack.hover();
  const queuedList = page.getByTestId("queued-list");
  await expect(queuedList).toBeVisible();
  await expect(queuedList).toContainText("Please pause and explain the plan.");
  await expect(queuedList).toContainText("Also check the Watch runs.");
  await queuedList
    .getByRole("button", { name: "Cancel queued message" })
    .first()
    .click();
  // Withdrawn means gone: not in the stack, never in the feed.
  await expect(queuedList).not.toContainText(
    "Please pause and explain the plan.",
  );
  await expect(page.locator('[data-message-id="e3"]')).toHaveCount(0);
  // Interjecting the remaining message stops the run — the bubble stays in the
  // stack with the stopping note until the drain consumes it.
  await stack.getByRole("button", { name: "Interject", exact: true }).click();
  await expect(stack).toContainText("Interjected · stopping the run…");
  await expect(page.locator('[data-message-id="e4"]')).toHaveCount(0);
  // The run ends and the drain consumes the event (the next send stands in for
  // that boundary): the message lands in the chat animated, and the newest
  // message takes its place in the stack.
  await page
    .getByRole("textbox", { name: "Message the agent" })
    .fill("One more note.");
  await page.getByRole("textbox", { name: "Message the agent" }).press("Enter");
  await expect(page.locator('[data-message-id="e4"]')).toHaveClass(
    /message-land/,
  );
  await expect(stack).toContainText("One more note.");
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
  await page.locator('main [data-slot="sidebar-trigger"]').click();
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
  const response = page.getByRole("article", { name: "Agent response" });
  await expect(response).toHaveAttribute("aria-busy", "true");
  const busyMark = response.locator(".helm-spin").first();
  await expect(busyMark).toHaveCSS("animation-name", "helm-steer");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(busyMark).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
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
  // Live activity expands to the action verbs; its helm turns only while busy.
  const busyActivity = page.getByRole("button", {
    name: "1 action in progress",
    exact: true,
  });
  await expect(busyActivity).toHaveAttribute("aria-expanded", "true");
  const actions = page.getByRole("list", { name: "Actions performed" });
  const actionPanel = page
    .locator('[data-slot="accordion-content"]')
    .filter({ has: actions });
  await expect(
    actions.getByText("Reading README.md", { exact: true }),
  ).toBeVisible();
  await expect(actions.locator(".helm-spin")).toHaveCount(1);
  await expect(actionPanel).toHaveCSS("opacity", "1");
  await page.screenshot({ path: info.outputPath("chat-activity-running.png") });
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
  await expect(actions.locator(".helm-spin")).toHaveCount(0);
  // A compaction marker lands between steps: visible counts + expandable summary.
  await emitLive(page, {
    kind: "compacted",
    step: 1,
    sequence: 6,
    removedMessages: 21,
    keptMessages: 16,
    summary: "Folded earlier exploration into this summary.",
    folding: "assistant → bash(ls)\ntool result: ok",
  });
  await emitLive(page, {
    kind: "llm_started",
    step: 2,
    sequence: 7,
    phase: "respond",
  });
  await emitLive(page, {
    kind: "delta",
    step: 2,
    sequence: 8,
    text: "The README is complete.",
  });
  // The next assistant step collapses activity to one quiet disclosure line.
  const activity = page.getByRole("button", {
    name: "1 action performed",
    exact: true,
  });
  await expect(activity).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByText("I’ll check the README.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("The README is complete.", { exact: true }),
  ).toBeVisible();
  const compaction = page.getByRole("button", { name: /Context compacted/ });
  await expect(compaction).toHaveAttribute("aria-expanded", "false");
  await compaction.click();
  await expect(
    page.getByText("Summary carried forward", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Folded earlier exploration into this summary.", {
      exact: true,
    }),
  ).toBeVisible();
  await emitLive(page, {
    kind: "assistant_done",
    step: 2,
    sequence: 9,
    text: "The README is complete.",
  });
  await emitLive(page, {
    kind: "run_finished",
    step: 2,
    sequence: 10,
    summary: "The README is complete.",
    ok: true,
  });
  await expect(response).toHaveAttribute("aria-busy", "false");
  await expect(response.locator(".helm-spin")).toHaveCount(0);
  await activity.focus();
  await page.keyboard.press("Enter");
  await expect(activity).toHaveAttribute("aria-expanded", "true");
  await expect(
    actions.getByText("Reading README.md", { exact: true }),
  ).toBeVisible();
  await expect(actions.getByText("Completed", { exact: true })).toBeVisible();
  await expect(actionPanel).toHaveCSS("opacity", "1");
  // Tool output never renders in the conversation; the trace is the record.
  await expect(page.getByText("# Worker service", { exact: true })).toHaveCount(
    0,
  );
  await expect(actions.locator("pre")).toHaveCount(0);
  await expect(
    page.getByText("5 reasoning tokens", { exact: false }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("chat-activity.png") });
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await settleTheme(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.screenshot({ path: info.outputPath("chat-activity-dark.png") });
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(activity).toBeVisible();
  await expect(
    actions.getByText("Reading README.md", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("chat-activity-mobile.png") });

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
      id: "compaction-6",
      kind: "compaction",
      step: 1,
      sequence: 6,
      removedMessages: 21,
      keptMessages: 16,
      summary: "Folded earlier exploration into this summary.",
      folding: "assistant → bash(ls)\ntool result: ok",
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
            conversation: { parts, sequence: 10, finished: true },
          },
        ],
      },
    }),
  );
  await page.reload();
  await expect(
    page.getByText("The README is complete.", { exact: true }),
  ).toHaveCount(1);
  await expect(activity).toHaveAttribute("aria-expanded", "false");
  await activity.click();
  await expect(
    actions.getByText("Reading README.md", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("# Worker service", { exact: true })).toHaveCount(
    0,
  );
  // The compaction handoff survives the refresh with its summary intact.
  const persistedCompaction = page.getByRole("button", {
    name: /Context compacted/,
  });
  await expect(persistedCompaction).toBeVisible();
  await persistedCompaction.click();
  await expect(
    page.getByText("Folded earlier exploration into this summary.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("latest message stays centered above the composer", async ({ page }) => {
  await mockWorkspace(page);
  await manualStream(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/threads/thread-1", (route) =>
    route.fulfill({
      json: {
        ...detail,
        runs: [
          {
            ...detail.runs[0],
            agentText: Array.from(
              { length: 35 },
              (_, i) =>
                `Paragraph ${i + 1}: The tests pass and the change is ready for review.`,
            ).join("\n\n"),
          },
        ],
      },
    }),
  );
  await page.goto("/threads/thread-1");
  const messages = page.getByRole("region", { name: "Conversation messages" });
  await expect(page.getByText("Paragraph 35:", { exact: false })).toBeVisible();
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await messages.evaluate((el) => {
      el.scrollTop = 0;
    });
    const jump = page.getByRole("button", {
      name: "Latest message",
      exact: true,
    });
    await expect(jump).toBeVisible();
    const container = (await messages.boundingBox())!;
    const button = (await jump.boundingBox())!;
    expect(
      Math.abs(
        button.x + button.width / 2 - (container.x + container.width / 2),
      ),
    ).toBeLessThan(2);
    await jump.click();
    await expect(jump).toHaveCount(0);
    expect(
      await messages.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      ),
    ).toBeLessThan(5);
  }
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
  const response = page.getByRole("article", { name: "Agent response" });
  await expect(response).toHaveAttribute("aria-busy", "true");
  completed = true; // No SSE frame is sent. The bounded reconciliation catches up.
  await expect(
    page.getByText("Recovered the completed reply.", { exact: true }),
  ).toBeVisible({ timeout: 6000 });
  await expect(response).toHaveAttribute("aria-busy", "false");
});
