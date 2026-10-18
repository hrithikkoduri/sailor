/**
 * Repo + ref helpers — including the never-touch-main guard.
 */
import { describe, expect, it } from "vitest";
import { assertSafeHeadRef, githubRepoUrl, headRefFor, isGithubSlug } from "../../src/github/repo.js";

describe("github repo helpers", () => {
  it("isGithubSlug is a format check only — threads.source decides GitHub-ness", () => {
    expect(isGithubSlug("acme/demo")).toBe(true);
    expect(isGithubSlug("acme-corp/repo.js")).toBe(true);
    expect(isGithubSlug("https://github.com/acme/demo")).toBe(false);
    expect(isGithubSlug("fixtures/buggy-lib")).toBe(true); // path-shaped — but source='local' wins
    expect(isGithubSlug("")).toBe(false);
  });

  it("builds the clone URL and the canonical branch name", () => {
    expect(githubRepoUrl("acme/demo")).toBe("https://github.com/acme/demo.git");
    expect(headRefFor(42)).toBe("sailor/issue-42");
  });

  it("assertSafeHeadRef allows sailor/* off a different base", () => {
    expect(() => assertSafeHeadRef("sailor/issue-42", "main")).not.toThrow();
  });

  it("assertSafeHeadRef still allows a pre-rename harness/issue-* branch (babysitting)", () => {
    expect(() => assertSafeHeadRef("harness/issue-1", "main")).not.toThrow();
  });

  it("assertSafeHeadRef refuses the base branch and anything outside our branches", () => {
    expect(() => assertSafeHeadRef("main", "main")).toThrow(/refusing to push/);
    expect(() => assertSafeHeadRef("feature/x", "main")).toThrow(/sailor/);
    expect(() => assertSafeHeadRef("harness/main", "main")).toThrow(/refusing to push/);
    expect(() => assertSafeHeadRef("", "main")).toThrow(/refusing to push/);
  });
});
