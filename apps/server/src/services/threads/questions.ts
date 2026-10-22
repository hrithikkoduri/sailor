/** Product-owned questions, validated before they reach either SQL or the UI. */
export interface QuestionOption { value: string; label: string }
export interface Question {
  id: string;
  label: string;
  description?: string;
  type: "text" | "single_select" | "multi_select" | "repository" | "secret";
  options?: QuestionOption[];
  required: boolean;
  recommended?: string;
  /** type=secret: name/env var the form stores; the answer is the name only. */
  secretName?: string;
  secretEnvVar?: string;
}
export function parseQuestions(value: unknown): Question[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8)
    throw new Error("Ask between 1 and 8 questions.");
  const ids = new Set<string>();
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid question.");
    const q = raw as Record<string, unknown>;
    if (typeof q.id !== "string" || !/^[a-z][a-z0-9_]{0,39}$/.test(q.id) || ids.has(q.id))
      throw new Error("Question ids must be unique, short identifiers.");
    ids.add(q.id);
    if (typeof q.label !== "string" || !q.label.trim() || q.label.length > 300)
      throw new Error("Each question needs a label (300 characters max).");
    if (!["text", "single_select", "multi_select", "repository", "secret"].includes(String(q.type)))
      throw new Error("Unsupported question type.");
    let options: QuestionOption[] | undefined;
    if (q.type !== "text" && q.type !== "secret") {
      if (!Array.isArray(q.options) || q.options.length < 1 || q.options.length > 30)
        throw new Error("Choice questions need 1 to 30 options.");
      options = q.options.map((o: unknown) => {
        if (!o || typeof o !== "object") throw new Error("Invalid option.");
        const option = o as Record<string, unknown>;
        if (typeof option.value !== "string" || !option.value.trim() || option.value.length > 200 ||
            typeof option.label !== "string" || !option.label.trim() || option.label.length > 200)
          throw new Error("Each option needs a value and label.");
        return { value: option.value, label: option.label };
      });
      if (new Set(options.map((o) => o.value)).size !== options.length) throw new Error("Duplicate option values.");
    }
    if (q.type === "repository" && ids.has("__repository")) throw new Error("Ask for only one repository.");
    if (q.type === "repository") ids.add("__repository");
    let secretName: string | undefined;
    let secretEnvVar: string | undefined;
    if (q.type === "secret") {
      if (typeof q.secretName !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/.test(q.secretName))
        throw new Error("Secret questions need a lowercase secretName.");
      if (typeof q.secretEnvVar !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(q.secretEnvVar))
        throw new Error("Secret questions need an uppercase secretEnvVar.");
      secretName = q.secretName;
      secretEnvVar = q.secretEnvVar;
      if (options) throw new Error("Secret questions do not take options.");
    }
    return {
      id: q.id, label: q.label.trim(), type: q.type as Question["type"], required: q.required !== false,
      ...(typeof q.description === "string" ? { description: q.description.slice(0, 1000) } : {}),
      ...(options ? { options } : {}),
      ...(typeof q.recommended === "string" && options?.some((o) => o.value === q.recommended)
        ? { recommended: q.recommended } : {}),
      ...(secretName ? { secretName } : {}),
      ...(secretEnvVar ? { secretEnvVar } : {}),
    };
  });
}
export function validateAnswers(questions: Question[], value: unknown): Record<string, string | string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Answers must be an object.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((id) => !questions.some((q) => q.id === id))) throw new Error("Unknown question id.");
  const answers: Record<string, string | string[]> = {};
  for (const q of questions) {
    const raw = input[q.id];
    if (raw !== undefined && (q.type === "multi_select"
      ? !Array.isArray(raw) || !raw.every((s) => typeof s === "string")
      : typeof raw !== "string")) throw new Error(`Invalid answer type: ${q.label}`);
    const answer = q.type === "multi_select"
      ? Array.isArray(raw) && raw.every((s) => typeof s === "string") ? [...new Set(raw as string[])] : []
      : typeof raw === "string" ? raw.trim() : "";
    if (q.required && answer.length === 0) throw new Error(`Please answer: ${q.label}`);
    if (typeof answer === "string" && answer.length > 8000) throw new Error("Answer too long.");
    if (q.options) {
      const chosen = Array.isArray(answer) ? answer : answer ? [answer] : [];
      const allowed = new Set(q.options.map((o) => o.value));
      const custom = chosen.filter((a) => !allowed.has(a));
      // Choice questions always accept one "something else" free-text answer.
      // A repository, by contrast, must be an enabled repository full name.
      if (q.type === "repository" && custom.length)
        throw new Error(`Invalid selection: ${q.label}`);
      if (custom.length > 1) throw new Error(`Only one other answer is allowed: ${q.label}`);
      if (custom.some((a) => !a.trim() || a.length > 2000))
        throw new Error(`The other answer must be 1–2000 characters: ${q.label}`);
    }
    answers[q.id] = answer;
  }
  return answers;
}
