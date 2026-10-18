import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockWorkspace, trace } from "./fixtures";

test("trace: compaction spans show the folded transcript and the summary", async ({
  page,
}, info) => {
  const errors = await mockWorkspace(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const compactedSpan = {
    id: "e-compacted",
    runId: "run-1",
    seq: 10,
    type: "compacted",
    payload: {
      type: "compacted",
      removedMessages: 23,
      keptMessages: 15,
      summaryChars: 41,
      summary: "Folded: earlier README investigation notes.",
      folding:
        "user: fix the bug\nassistant → bash: cat README.md\ntool result: # Worker service",
    },
    ts: trace.thread.updatedAt,
  };
  await page.route("**/api/threads/thread-1/trace", (route) =>
    route.fulfill({
      json: { ...trace, spans: [...trace.spans, compactedSpan] },
    }),
  );
  await page.goto("/threads/thread-1?view=trace");
  await page.getByRole("button", { name: /conversation compacted/ }).click();
  await expect(
    page.getByRole("heading", { name: "conversation compacted" }),
  ).toBeVisible();
  await expect(
    page.getByText("Folded: earlier README investigation notes.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("user: fix the bug", { exact: false }).first(),
  ).toBeVisible();
  for (const panel of await page
    .locator('[data-slot="accordion-content"]')
    .all())
    await expect(panel).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: info.outputPath("trace-compacted-light.png"),
  });
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  expect(errors).toEqual([]);
});

test("trace: model spans expose provider reasoning text and token count", async ({
  page,
}, info) => {
  const errors = await mockWorkspace(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/threads/thread-1/trace", (route) =>
    route.fulfill({
      json: {
        ...trace,
        spans: trace.spans.map((span) =>
          span.type === "llm_call_finished" && span.payload.step === 2
            ? {
                ...span,
                payload: {
                  ...span.payload,
                  reasoning:
                    "Checked the guard covers the empty batch before concluding.",
                  usage: {
                    promptTokens: 1120,
                    completionTokens: 96,
                    reasoningTokens: 4096,
                  },
                },
              }
            : span,
        ),
      },
    }),
  );
  await page.goto("/threads/thread-1?view=trace");
  await page.getByRole("button", { name: "Model call 2" }).click();
  await expect(
    page.getByRole("heading", { name: "Model call 2" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Checked the guard covers the empty batch before concluding.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText("reasoningTokens")).toBeVisible();
  await expect(page.getByText("4096", { exact: true })).toBeVisible();
  for (const panel of await page
    .locator('[data-slot="accordion-content"]')
    .all())
    await expect(panel).toHaveCSS("opacity", "1");
  await page.screenshot({ path: info.outputPath("trace-reasoning-light.png") });
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  for (const panel of await page
    .locator('[data-slot="accordion-content"]')
    .all())
    await expect(panel).toHaveCSS("opacity", "1");
  await page.screenshot({ path: info.outputPath("trace-reasoning-dark.png") });
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  expect(errors).toEqual([]);
});
