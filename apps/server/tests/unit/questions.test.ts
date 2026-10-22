import { describe, expect, it } from "vitest";
import { parseQuestions, validateAnswers } from "../../src/services/threads/questions.js";

const form = [{ id: "repo", type: "repository", label: "Which repository?", options: [{ value: "acme/web", label: "Web app" }], recommended: "acme/web" },
  { id: "behavior", type: "text", label: "What should happen?" },
  { id: "targets", type: "multi_select", label: "Targets?", required: false, options: [{ value: "desktop", label: "Desktop" }] }];
describe("structured questions", () => {
  it("validates supported forms and keeps a valid recommendation", () => {
    const questions = parseQuestions(form);
    expect(questions[0]?.recommended).toBe("acme/web");
    expect(questions[1]?.required).toBe(true);
    expect(validateAnswers(questions, { repo: "acme/web", behavior: " Show a receipt ", targets: ["desktop", "desktop"] }))
      .toEqual({ repo: "acme/web", behavior: "Show a receipt", targets: ["desktop"] });
  });
  it("rejects missing required answers and unknown choices", () => {
    const questions = parseQuestions(form);
    expect(() => validateAnswers(questions, {})).toThrow(/Please answer/);
    expect(() => validateAnswers(questions, { repo: "other/private", behavior: "yes" })).toThrow(/Invalid selection/);
    expect(() => validateAnswers(questions, { repo: "acme/web", behavior: "yes", extra: "bad" })).toThrow(/Unknown/);
    expect(() => validateAnswers(questions, { repo: [], behavior: "yes" })).toThrow(/Invalid answer type/);
  });
  it("supports a secret question without accepting a value through the answer", () => {
    const [secret] = parseQuestions([{
      id: "secret", type: "secret", label: "Add the Daytona key",
      secretName: "daytona", secretEnvVar: "DAYTONA_API_KEY",
    }]);
    expect(secret).toMatchObject({ secretName: "daytona", secretEnvVar: "DAYTONA_API_KEY" });
    expect(validateAnswers([secret!], { secret: "daytona" })).toEqual({ secret: "daytona" });
    expect(() => parseQuestions([{ id: "bad", type: "secret", label: "Bad", secretName: "Daytona", secretEnvVar: "KEY" }])).toThrow(/secretName/);
    expect(() => parseQuestions([{ id: "bad", type: "secret", label: "Bad", secretName: "daytona", secretEnvVar: "bad" }])).toThrow(/secretEnvVar/);
  });

  it("rejects duplicate identifiers, invalid types and duplicate repository questions", () => {
    expect(() => parseQuestions([])).toThrow();
    expect(() => parseQuestions([form[0], form[0]])).toThrow(/unique/);
    expect(() => parseQuestions([{ id: "a", type: "html", label: "bad" }])).toThrow(/Unsupported/);
    expect(() => parseQuestions([form[0], { ...form[0], id: "repo2" }])).toThrow(/only one/);
  });
  it("always accepts one free-text 'something else' answer for a choice, never for a repository", () => {
    const questions = parseQuestions([
      ...form,
      { id: "scope", type: "single_select", label: "Scope?", options: [{ value: "a", label: "A" }] },
    ]);
    // The form's final "Something else" option submits plain text instead of a preset value.
    expect(validateAnswers(questions, {
      repo: "acme/web", behavior: "yes", targets: ["desktop", "custom target"], scope: "vendor the adapter in Sailor",
    })).toMatchObject({ targets: ["desktop", "custom target"], scope: "vendor the adapter in Sailor" });
    // A repository answer cannot be invented.
    expect(() => validateAnswers(questions, { repo: "acme/typo", behavior: "yes" })).toThrow(/Invalid selection/);
    // At most one custom value per question, and it must be non-empty and bounded.
    expect(() => validateAnswers(questions, { repo: "acme/web", behavior: "yes", targets: ["one", "two"] })).toThrow(/one other/i);
    expect(() => validateAnswers(questions, { repo: "acme/web", behavior: "yes", scope: "x".repeat(2001) })).toThrow(/2000/);
    // A blank "something else" is simply an unanswered required question.
    expect(() => validateAnswers(questions, { repo: "acme/web", behavior: "yes", scope: "   " })).toThrow(/Please answer/);
  });
});
