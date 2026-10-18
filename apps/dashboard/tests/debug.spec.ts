import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  detail,
  mockWorkspace,
  manualStream,
  emitLive,
  settleTheme,
} from "./fixtures";

test("debug shortcut reveals expandable input/output, red failures, and persists until disabled", async ({
  page,
}, info) => {
  const errors = await mockWorkspace(page);
  await manualStream(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/threads/thread-1", (route) =>
    route.fulfill({
      json: {
        ...detail,
        runs: [
          {
            ...detail.runs[0],
            conversation: {
              sequence: 6,
              finished: true,
              parts: [
                {
                  id: "tool-1-a",
                  kind: "tool",
                  step: 1,
                  sequence: 2,
                  name: "read_file",
                  verb: "Reading repository file README.md",
                  input: { path: "README.md" },
                  content: "# Project overview",
                  ok: true,
                  complete: true,
                },
                {
                  id: "tool-1-b",
                  kind: "tool",
                  step: 1,
                  sequence: 4,
                  name: "bash",
                  verb: "Reviewing the repository code diff",
                  input: { command: "git diff --stat" },
                  content:
                    "Execution request failed; command completion is unknown.",
                  ok: false,
                  complete: true,
                },
                {
                  id: "text-2",
                  kind: "text",
                  step: 2,
                  sequence: 5,
                  text: "I could inspect the README, but could not confirm the command result.",
                  complete: true,
                },
              ],
            },
          },
        ],
      },
    }),
  );
  await page.goto("/threads/thread-1");
  const summary = page.getByRole("button", {
    name: "2 actions performed · 1 failed",
    exact: true,
  });
  await expect(summary).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("region", { name: "Input for bash" }),
  ).toHaveCount(0);
  const composer = page.getByRole("textbox", { name: "Message the agent" });
  await composer.fill("Keep my draft intact");
  await composer.press("Meta+Shift+D");
  await expect(
    page.getByRole("button", { name: "Disable debug mode", exact: true }),
  ).toBeVisible();
  await expect(summary).toHaveAttribute("aria-expanded", "true");
  const fileDetails = page.getByRole("button", {
    name: "read_file details",
    exact: true,
  });
  const failedDetails = page.getByRole("button", {
    name: "bash details — failed",
    exact: true,
  });
  await expect(fileDetails).toHaveAttribute("aria-expanded", "true");
  await expect(failedDetails).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("region", { name: "Input for bash" }),
  ).toContainText("git diff --stat");
  const failedOutput = page
    .getByRole("region", { name: "Output for bash" })
    .locator("pre");
  await expect(failedOutput).toContainText("command completion is unknown");
  await expect(failedOutput).toHaveCSS("color", "rgb(191, 70, 70)");
  await expect(composer).toHaveValue("Keep my draft intact");
  // Tool cards remain independently keyboard-expandable.
  await fileDetails.focus();
  await page.keyboard.press("Enter");
  await expect(fileDetails).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(fileDetails).toHaveAttribute("aria-expanded", "true");
  for (const panel of await page
    .locator('[data-slot="accordion-content"]')
    .all())
    await expect(panel).toHaveCSS("opacity", "1");
  await page.screenshot({ path: info.outputPath("debug-light.png") });
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await settleTheme(page);
  await expect(failedOutput).toHaveCSS("color", "rgb(225, 149, 149)");
  await page.screenshot({ path: info.outputPath("debug-dark.png") });
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  // Key repeat must not immediately switch the mode back off.
  await page.evaluate(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "D",
        code: "KeyD",
        metaKey: true,
        shiftKey: true,
        repeat: true,
        cancelable: true,
      }),
    ),
  );
  await expect(summary).toHaveAttribute("aria-expanded", "true");
  await page.reload();
  await expect(failedDetails).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Control+Shift+D");
  await expect(summary).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("region", { name: "Input for bash" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Disable debug mode", exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("debug keeps live tool details open across assistant steps and works on mobile", async ({
  page,
}) => {
  await mockWorkspace(page, { active: true });
  await manualStream(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/threads/thread-1");
  await expect(
    page.getByRole("article", { name: "Agent response" }),
  ).toBeVisible();
  await page.keyboard.press("Meta+Shift+D");
  await emitLive(page, {
    kind: "tool_call",
    sequence: 1,
    step: 1,
    callId: "a",
    name: "bash",
    verb: "Reviewing the repository code diff",
    input: { command: "git diff --stat" },
  });
  await expect(
    page.getByRole("button", { name: "bash details", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("region", { name: "Output for bash" }),
  ).toContainText("Waiting for output");
  await emitLive(page, {
    kind: "tool_result",
    sequence: 2,
    step: 1,
    callId: "a",
    name: "bash",
    ok: false,
    content: "Execution request failed; completion unknown.",
  });
  await emitLive(page, {
    kind: "llm_started",
    sequence: 3,
    step: 2,
    phase: "respond",
  });
  await emitLive(page, {
    kind: "delta",
    sequence: 4,
    step: 2,
    text: "The operation could not be confirmed.",
  });
  const summary = page.getByRole("button", {
    name: "1 action performed · 1 failed",
    exact: true,
  });
  await expect(summary).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("button", { name: "bash details — failed", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("region", { name: "Input for bash" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Disable debug mode", exact: true })
    .click();
  await expect(summary).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("region", { name: "Input for bash" }),
  ).toHaveCount(0);
});
