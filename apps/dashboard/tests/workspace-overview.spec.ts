import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockWorkspace, detail, thread, settleTheme } from "./fixtures";
import { gate } from "./fixtures";

test("settings refreshes GitHub repositories, preserves saved toggles, and explains missing access", async ({ page }) => {
  await mockWorkspace(page);
  let refreshed = false;
  await page.route("**/api/onboarding", (route) => route.fulfill({ json: {
    ...gate, installations: gate.installations.map((i) => ({ ...i, repos: refreshed
      ? [...i.repos, { fullName: "acme/new-project", enabled: false, defaultBranch: "main" }] : i.repos })),
  } }));
  await page.route("**/api/onboarding/repos/refresh", (route) => {
    expect(route.request().method()).toBe("POST");
    refreshed = true; return route.fulfill({ json: { ok: true, repositories: 2, installations: 1 } });
  });
  await page.goto("/settings");
  const refresh = page.getByRole("button", { name: "Refresh from GitHub", exact: true });
  const enabled = page.getByRole("switch", { name: "Enable acme/worker-service" });
  await enabled.click();
  await expect(refresh).toBeDisabled();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await refresh.click();
  await expect(page.getByRole("switch", { name: "Enable acme/new-project" })).not.toBeChecked();
  await expect(enabled).toBeChecked();
  await expect(page.getByRole("status").filter({ hasText: "Repository list refreshed" })).toContainText("Existing choices were kept");
  await expect(page.getByRole("link", { name: "Manage GitHub App access" })).toHaveAttribute("href", "https://github.com/settings/installations");
  await expect(page.getByText("Still missing a repository after refreshing?", { exact: false })).toBeVisible();
});

for (const modifier of ["Meta", "Control"]) {
  test(`new thread: Enter submits and ${modifier}+Enter inserts a newline`, async ({ page }) => {
    await mockWorkspace(page);
    const submissions: unknown[] = [];
    await page.route("**/api/threads", (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      submissions.push(route.request().postDataJSON());
      return route.fulfill({ status: 201, json: { thread, runId: "run-1" } });
    });
    await page.goto("/");
    const composer = page.getByLabel("What would you like to work on?");
    await composer.press("Enter");
    expect(submissions).toHaveLength(0);
    await composer.fill("FirstSecond");
    await composer.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(5, 5));
    await composer.press(`${modifier}+Enter`);
    await expect(composer).toHaveValue("First\nSecond");
    expect(submissions).toHaveLength(0);
    await composer.press("Enter");
    await expect(page).toHaveURL(/\/threads\/thread-1$/);
    expect(submissions).toEqual([{ text: "First\nSecond" }]);
  });
}

test("home creates a thread with an explicit repository and exposes all sections", async ({ page }, info) => {
  const errors = await mockWorkspace(page);
  let input: unknown;
  await page.route("**/api/threads", (route) => route.request().method() === "POST"
    ? (input = route.request().postDataJSON(), route.fulfill({ status: 201, json: { thread, runId: "run-1" } })) : route.fallback());
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "What’s next, Alex?" })).toBeVisible();
  for (const name of ["Home", "Threads", "Issues", "Pull requests", "Traces", "Settings"])
    await expect(page.getByRole("link", { name, exact: true }).first()).toBeVisible();
  await page.getByLabel("What would you like to work on?").fill("Fix the checkout validation");
  await page.getByRole("combobox", { name: "Repository (optional)" }).click();
  await page.getByRole("option", { name: "acme/worker-service" }).click();
  await page.screenshot({ path: info.outputPath("home-light.png") });
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Start thread", exact: true }).click();
  await expect(page).toHaveURL(/\/threads\/thread-1$/);
  expect(input).toEqual({ text: "Fix the checkout validation", repo: "acme/worker-service" });
  expect(errors).toEqual([]);
});

test("questions survive refresh, submit one form, and render read-only after answers", async ({ page }, info) => {
  const errors = await mockWorkspace(page);
  let answered = false;
  const questions = [{ id: "repo", label: "Which repository?", type: "repository", required: true,
    recommended: "acme/worker-service", options: [{ value: "acme/worker-service", label: "Worker service" }] },
    { id: "behavior", label: "What should happen?", type: "text", required: true }];
  await page.route("**/api/threads/thread-1", (route) => route.fulfill({ json: {
    ...detail, thread: { ...detail.thread, source: "workspace", title: "Fix checkout", repo: "workspace:thread-1" },
    runs: [{ ...detail.runs[0], status: "paused" }], questions: [{ id: "q1", title: "A couple of details", questions,
      status: answered ? "answered" : "pending", answers: answered ? { repo: "acme/worker-service", behavior: "Show the error inline" } : null, createdAt: new Date().toISOString() }],
  } }));
  await page.route("**/api/questions/q1/answers", (route) => {
    expect(route.request().postDataJSON()).toEqual({ answers: { repo: "acme/worker-service", behavior: "Show the error inline" } });
    answered = true; return route.fulfill({ json: { ok: true, runId: "next-run" } });
  });
  await page.goto("/threads/thread-1");
  await page.reload();
  const form = page.getByRole("form", { name: "A couple of details" });
  await expect(form).toBeVisible();
  // The form floats above the composer, not inside the transcript.
  await expect(page.getByRole("region", { name: "Conversation messages" }).getByRole("form")).toHaveCount(0);
  // Multiple questions are a swipeable carousel: one slide at a time.
  await expect(form).toContainText("Question 1 of 2");
  // The second slide is mounted but inert until you move to it.
  await expect(form.locator('[aria-label="Question 2 of 2"]')).toHaveAttribute("aria-hidden", "true");
  await form.getByRole("button", { name: "Next question" }).click();
  await expect(form).toContainText("Question 2 of 2");
  await expect(form.locator('[aria-label="Question 1 of 2"]')).toHaveAttribute("aria-hidden", "true");
  await form.getByLabel("What should happen?").fill("Show the error inline");
  await form.getByRole("button", { name: "Previous question" }).click();
  // Every choice offers a free-text escape hatch after the real options.
  await form.getByRole("radio", { name: /Worker service/ }).check();
  await page.screenshot({ path: info.outputPath("questions-light.png") });
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  await form.getByRole("button", { name: "Submit answers" }).click();
  await expect(form).toContainText("Answers sent");
  await expect(form.getByRole("radio").first()).toBeDisabled();
  await page.reload();
  await expect(form).toContainText("Answers sent");
  expect(errors).toEqual([]);
});

test("a question collapses to a slim bar above the composer and reopens", async ({ page }) => {
  await mockWorkspace(page);
  const questions = [
    { id: "scope", label: "Where should it live?", type: "single_select", required: true,
      options: [{ value: "sdk", label: "In the SDK" }, { value: "vendored", label: "Vendored in Sailor" }] },
    { id: "notes", label: "Anything else?", type: "text", required: false },
  ];
  await page.route("**/api/threads/thread-1", (route) => route.fulfill({ json: {
    ...detail, thread: { ...detail.thread, source: "workspace", title: "Daytona wiring", repo: "workspace:thread-1" },
    runs: [{ ...detail.runs[0], status: "paused" }],
    questions: [{ id: "q1", title: "Pick a home", questions, status: "pending", answers: null, createdAt: new Date().toISOString() }],
  } }));
  await page.goto("/threads/thread-1");
  const form = page.getByRole("form", { name: "Pick a home" });
  await expect(form).toBeVisible();
  // Choosing "Something else" reveals a free-text answer.
  await form.getByRole("radio", { name: "Something else…" }).check();
  await expect(form.getByLabel("Your answer for Where should it live?")).toBeVisible();
  await form.getByRole("button", { name: "Collapse questions" }).click();
  const bar = page.getByRole("button", { name: /Needs answers for 2 questions/ });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("0/2 answered");
  await expect(form).toHaveCount(0);
  // The bar keeps the blocked state visible while the composer stays put.
  await expect(page.getByRole("textbox", { name: "Message the agent" })).toBeDisabled();
  await bar.click();
  await expect(page.getByRole("form", { name: "Pick a home" })).toBeVisible();
});

test("settings lists secrets as metadata and never shows a value", async ({ page }) => {
  await mockWorkspace(page);
  let posted: Record<string, unknown> = {};
  let deleted = "";
  let secrets = [{ id: "s1", name: "daytona", envVar: "DAYTONA_API_KEY",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastUsedAt: null }];
  await page.route("**/api/secrets", async (route) => {
    if (route.request().method() === "POST") {
      posted = route.request().postDataJSON() as Record<string, unknown>;
      secrets = [...secrets, { id: "s2", name: String(posted.name), envVar: String(posted.envVar),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastUsedAt: null }];
      return route.fulfill({ json: { secret: secrets.at(-1) } });
    }
    return route.fulfill({ json: { secrets } });
  });
  await page.route("**/api/secrets/*", (route) => {
    deleted = route.request().url().split("/").pop() ?? "";
    if (route.request().method() === "DELETE") {
      secrets = secrets.filter((s) => s.id !== deleted);
      return route.fulfill({ json: { ok: true } });
    }
    return route.fallback();
  });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Secrets" })).toBeVisible();
  await expect(page.getByText("DAYTONA_API_KEY ·")).toBeVisible();
  // No reveal control exists anywhere in the section.
  await expect(page.getByRole("button", { name: /reveal|show value/i })).toHaveCount(0);

  await page.getByRole("button", { name: "Add secret" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a secret" });
  await dialog.getByLabel("Name the agent asks for").fill("e2b");
  await dialog.getByLabel("Environment variable for the command").fill("E2B_API_KEY");
  await dialog.getByLabel("Value").fill("sk-test-value");
  await dialog.getByRole("button", { name: "Store secret" }).click();
  expect(posted).toMatchObject({ name: "e2b", envVar: "E2B_API_KEY", value: "sk-test-value" });
  await expect(page.getByText("E2B_API_KEY ·")).toBeVisible();

  await page.getByRole("button", { name: "Delete secret daytona" }).click();
  expect(deleted).toBe("s1");
  await expect(page.getByText("daytona", { exact: true })).toHaveCount(0);
});

test("trace table deep links into the explorer and home fits on mobile", async ({ page }, info) => {
  await mockWorkspace(page);
  await page.route("**/api/traces?*", (route) => route.fulfill({ json: { traces: [{ id: "run-1", threadId: "thread-1", title: "Fix empty batches", repo: "acme/worker-service", status: "succeeded", task: "fix", steps: 12, tokensIn: 1200, tokensOut: 300, usd: "0.02", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null }], hasMore: false, page: 0 } }));
  await page.goto("/traces");
  await expect(page.getByRole("table")).toContainText("Fix empty batches");
  await page.getByRole("link", { name: /Fix empty batches/ }).click();
  await expect(page).toHaveURL(/run=run-1/);
  await expect(page.getByRole("button", { name: /Entire thread/ })).toBeVisible();
  await page.goto("/");
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await settleTheme(page);
  await page.screenshot({ path: info.outputPath("home-dark.png") });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.getByLabel("What would you like to work on?")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("home-mobile.png") });
});
