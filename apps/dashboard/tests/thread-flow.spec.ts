import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockWorkspace, detail, thread } from "./fixtures";

test("thread dock switches with the keyboard and restores drafts and reading position", async ({ page }) => {
  await mockWorkspace(page);
  const other = { ...thread, id: "thread-2", title: "Investigate pipeline", repo: "acme/pipeline" };
  let cancels = 0;
  await page.route("**/api/runs/*/cancel", (route) => { cancels++; return route.fulfill({ json: { ok: true } }); });
  await page.route("**/api/threads", (route) => route.fulfill({ json: { threads: [
    { ...thread, title: "Fix empty batches", latestRun: detail.runs[0], pendingEvents: 0 },
    { ...other, latestRun: { ...detail.runs[0], id: "run-2" }, pendingEvents: 0 },
  ] } }));
  await page.route("**/api/threads/thread-1", (route) => route.fulfill({ json: {
    ...detail, thread: { ...detail.thread, title: "Fix empty batches" }, runs: [{ ...detail.runs[0],
      agentText: Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}. Here is the implementation and evidence.`).join("\n\n") }],
  } }));
  await page.route("**/api/threads/thread-2", (route) => route.fulfill({ json: { ...detail, thread: other, runs: [{ ...detail.runs[0], id: "run-2" }] } }));
  await page.goto("/threads/thread-1");
  const dock = page.getByRole("navigation", { name: "Open threads" });
  await expect(dock.getByRole("link", { name: /Fix empty batches/ })).toBeVisible();
  const composer = page.getByRole("textbox", { name: "Message the agent" });
  await composer.fill("Don't lose this draft");
  const messages = page.getByRole("region", { name: "Conversation messages" });
  await messages.evaluate((el) => { el.scrollTop = 80; el.dispatchEvent(new Event("scroll")); });
  await expect(messages).toHaveJSProperty("scrollTop", 80);
  await page.keyboard.press("Control+k");
  const switcher = page.getByRole("dialog", { name: "Switch threads" });
  await switcher.getByRole("combobox").fill("pipeline");
  await switcher.getByRole("combobox").press("Enter");
  await expect(page).toHaveURL(/threads\/thread-2$/);
  await expect(composer).toHaveValue("");
  await composer.fill("Second thread draft");
  await dock.getByRole("link", { name: /Fix empty batches/ }).click();
  await expect(composer).toHaveValue("Don't lose this draft");
  await expect(messages).toHaveJSProperty("scrollTop", 80);
  await dock.getByRole("button", { name: "Close thread tab: Investigate pipeline" }).click();
  expect(cancels).toBe(0);
  await expect(page).toHaveURL(/threads\/thread-1$/);
  await expect(dock.getByRole("link", { name: /Investigate pipeline/ })).toHaveCount(0);
});

test("thread title renames inline and the thread uses one header row", async ({ page }) => {
  await mockWorkspace(page);
  let title = "Fix empty batches";
  await page.route("**/api/threads/thread-1", (route) => {
    if (route.request().method() === "PATCH") {
      title = route.request().postDataJSON().title;
      return route.fulfill({ json: { ok: true, title } });
    }
    return route.fulfill({ json: { ...detail, thread: { ...detail.thread, title } } });
  });
  await page.route("**/api/threads", (route) => route.fulfill({ json: { threads: [{ ...thread, title, latestRun: detail.runs[0], pendingEvents: 0 }] } }));
  await page.goto("/threads/thread-1");
  await page.getByRole("button", { name: "Rename thread", exact: true }).click();
  await page.getByRole("textbox", { name: "Thread title", exact: true }).fill("Checkout retry rules");
  await page.getByRole("textbox", { name: "Thread title", exact: true }).press("Enter");
  const dock = page.getByRole("navigation", { name: "Open threads" });
  await expect(dock.getByRole("link", { name: /Checkout retry rules/ })).toBeVisible();
  await page.reload();
  await expect(dock.getByRole("link", { name: /Checkout retry rules/ })).toBeVisible();
  const header = await page.locator("header").boundingBox();
  const conversationTab = await page.getByRole("tab", { name: "Conversation", exact: true }).boundingBox();
  const openTab = await dock.boundingBox();
  expect(header!.height).toBeLessThanOrEqual(56);
  expect(conversationTab!.y).toBeLessThan(header!.y + header!.height);
  expect(openTab!.y).toBeLessThan(header!.y + header!.height);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
});

test("working threads show Stop in the composer instead of Send", async ({ page }) => {
  await mockWorkspace(page, { active: true });
  let stopped = false;
  await page.route("**/api/runs/run-1/cancel", (route) => { stopped = true; return route.fulfill({ json: { ok: true, action: "cancel-requested" } }); });
  await page.goto("/threads/thread-1");
  const composer = page.getByRole("textbox", { name: "Message the agent" });
  await composer.fill("My unsent message");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toHaveCount(0);
  const stop = page.getByRole("button", { name: "Stop current run", exact: true });
  await expect(stop).toHaveCount(1);
  const stopRect = await stop.boundingBox(); const composerRect = await composer.boundingBox();
  expect(stopRect!.y).toBeGreaterThan(composerRect!.y);
  await stop.click();
  expect(stopped).toBe(true);
  await expect(composer).toHaveValue("My unsent message");
});

test("a repository can be attached from an existing thread's composer", async ({ page }) => {
  await mockWorkspace(page);
  await page.route("**/api/threads/thread-1", (route) => route.fulfill({ json: { ...detail,
    thread: { ...detail.thread, source: "workspace", repo: "workspace:thread-1", prNumber: null, prUrl: null, issueUrl: null, state: "queued", title: "New task" },
  } }));
  let selected = "";
  await page.route("**/api/threads/thread-1/repository", (route) => {
    selected = route.request().postDataJSON().repository;
    return route.fulfill({ json: { ok: true, queued: false, runId: "attach-run" } });
  });
  await page.goto("/threads/thread-1");
  await page.getByRole("button", { name: "Attach repository", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Attach a repository" });
  await dialog.getByRole("combobox", { name: "Repository" }).click();
  await page.getByRole("option", { name: "acme/worker-service" }).click();
  await dialog.getByRole("button", { name: "Attach and continue" }).click();
  expect(selected).toBe("acme/worker-service");
  await expect(page.getByRole("button", { name: "Repository attachment queued" })).toBeDisabled();
});

test("the composer shows a repository the agent checked out beside the thread", async ({ page }) => {
  await mockWorkspace(page);
  await page.route("**/api/threads/thread-1", (route) => route.fulfill({ json: {
    ...detail,
    thread: { ...detail.thread, source: "manual", repo: "hrithikkoduri/sailor" },
    events: [...detail.events, {
      id: "ev-checkout-1", kind: "repository_checkout",
      payload: { repositories: [{ repository: "acme/anchor-ai-sdk", path: "/home/user/anchor-ai-sdk" }] },
      status: "consumed", receivedAt: new Date().toISOString(), consumedAt: new Date().toISOString(),
    }],
  } }));
  await page.goto("/threads/thread-1");
  // Sailor's own repository stays visible; the sibling clone is flagged, not hidden.
  await expect(page.getByTitle("hrithikkoduri/sailor", { exact: true })).toBeVisible();
  await expect(page.getByTitle(/also checked out acme\/anchor-ai-sdk/)).toBeVisible();
  // It is composer context, not a transcript message.
  await expect(page.getByRole("region", { name: "Conversation messages" })).not.toContainText("repository checkout");
});

test("a repo-backed thread can change repository explicitly", async ({ page }) => {
  await mockWorkspace(page);
  await page.route("**/api/threads/thread-1", (route) => route.fulfill({ json: {
    ...detail,
    thread: { ...detail.thread, source: "manual", repo: "acme/old", prNumber: 3,
      prUrl: "https://github.com/acme/old/pull/3", state: "pr_open", headRef: "sailor/thread-1" },
  } }));
  let switched = "";
  await page.route("**/api/threads/thread-1/repository/switch", (route) => {
    switched = route.request().postDataJSON().repository;
    return route.fulfill({ json: { ok: true, runId: "run-2" } });
  });
  await page.goto("/threads/thread-1");
  await page.getByRole("button", { name: "Change", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Change repository" });
  // The consequence is stated before the switch happens.
  await expect(dialog).toContainText("starts a fresh workspace");
  await expect(dialog).toContainText("stays there");
  await dialog.getByRole("combobox", { name: "Repository" }).click();
  await page.getByRole("option", { name: "acme/worker-service" }).click();
  await dialog.getByRole("button", { name: "Switch and continue" }).click();
  expect(switched).toBe("acme/worker-service");
});

test("deleting a thread confirms first, then returns to the list", async ({ page }) => {
  await mockWorkspace(page);
  let deleted = false;
  await page.route("**/api/threads/thread-1", (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    deleted = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/threads/thread-1");
  await page.getByRole("button", { name: "Delete thread", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete this thread?" });
  await expect(dialog).toContainText("cannot be undone");
  await expect(dialog).toContainText("pull request already opened stays on GitHub");
  await dialog.getByRole("button", { name: "Delete thread" }).click();
  await expect(page).toHaveURL(/\/threads$/);
  expect(deleted).toBe(true);
});

test("switcher and panels settle without blur and honor reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockWorkspace(page);
  await page.goto("/threads/thread-1");
  await page.getByRole("button", { name: "Switch threads", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Switch threads" });
  await expect(dialog).toHaveCSS("filter", "none");
  await expect(dialog).toHaveCSS("transform", "none");
  await expect(dialog.locator('[data-slot="motion-highlight"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByRole("tab", { name: "Trace", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toHaveCSS("filter", "none");
  await expect(page.getByRole("tabpanel")).toHaveCSS("transform", "none");
  await page.getByRole("tab", { name: "Conversation", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message the agent" })).toBeVisible();
  await expect(page.getByRole("tabpanel")).toHaveCount(1);
});
