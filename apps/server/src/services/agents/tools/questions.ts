import { defineTool, type Sandbox, shq } from "anchor-ai-sdk";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "../../../db/index.js";
import { enabledRepositories } from "../../threads/repositories.js";
import { parseQuestions } from "../../threads/questions.js";

/** Clone only into an otherwise empty workspace; never reset existing work. */
export async function attachRepository(args: {
  sandbox: Sandbox; repo: string; branch: string; token?: string;
}) {
  const { sandbox, repo, branch, token } = args;
  const current = await sandbox.exec("git remote get-url origin", { timeoutSecs: 30 });
  if (current.exitCode === 0) {
    if (current.stdout.trim().replace(/\.git$/, "") === `https://github.com/${repo}`) return;
    throw new Error("This sandbox already has a repository. Start a new thread to switch repositories.");
  }
  const files = await sandbox.exec("git ls-files -- . ':!.anchor' && git ls-files --others --exclude-standard", { timeoutSecs: 30 });
  if (files.exitCode !== 0 || files.stdout.trim())
    throw new Error("The workspace contains work. Start a new thread with the repository attached to preserve these files.");
  // The token is passed via environment, never in the model's arguments or
  // command text. No token is persisted to .git/config.
  const credential = token ? "-c 'credential.helper=!f() { echo username=x-access-token; printf \"password=%s\\n\" \"$GIT_TOKEN\"; }; f'" : "";
  const result = await sandbox.exec(
    `git remote add origin ${shq(`https://github.com/${repo}.git`)} && ` +
    `git ${credential} fetch --depth=1 origin ${shq(branch)} && git checkout -B ${shq(branch)} FETCH_HEAD`,
    { timeoutSecs: 900, ...(token ? { env: { GIT_TOKEN: token } } : {}) },
  );
  if (result.exitCode !== 0) {
    await sandbox.exec("git remote remove origin", { timeoutSecs: 30 });
    throw new Error("Repository checkout failed. Access may have changed; reconnect the repository in Settings.");
  }
}

export function questionTools(args: {
  db: Db; threadId: string; userId: string | null; sandbox: Sandbox;
  hasRepository: boolean;
  tokenFor?: (installationId: number, repository: string) => Promise<string>;
  onQuestions: (requestId: string) => void;
  notify?: () => void;
}) {
  let attached = args.hasRepository;
  let asked = false;
  return [
    defineTool({
      name: "ask_questions",
      description: "Use this tool whenever you have a question for the user or need their decision, clarification, permission, or missing information. Never ask questions in a normal chat response. Send one form with up to 8 questions, then pause immediately until answers arrive. Clear tasks should proceed without unnecessary questions. A repository question must use enabled repository full names as values.",
      parameters: { type: "object", properties: {
        title: { type: "string" },
        questions: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", properties: {
          id: { type: "string" }, label: { type: "string" }, description: { type: "string" },
          type: { type: "string", enum: ["text", "single_select", "multi_select", "repository"] },
          required: { type: "boolean" }, recommended: { type: "string" },
          options: { type: "array", items: { type: "object", properties: { value: { type: "string" }, label: { type: "string" } }, required: ["value", "label"], additionalProperties: false } },
        }, required: ["id", "label", "type"], additionalProperties: false } },
      }, required: ["title", "questions"], additionalProperties: false },
    }, async (input) => {
      if (asked) throw new Error("Questions have already been submitted for this turn.");
      const title = typeof input.title === "string" ? input.title.trim() : "";
      if (!title || title.length > 200) throw new Error("Provide a short title (200 characters max).");
      const questions = parseQuestions(input.questions);
      const repos = await enabledRepositories(args.db, args.userId);
      for (const q of questions.filter((q) => q.type === "repository")) {
        if (attached) throw new Error("A repository is already attached. Do not ask to switch it.");
        if (q.options!.some((o) => !repos.some((r) => r.fullName === o.value)))
          throw new Error("Choose only repositories enabled for this account.");
      }
      const [request] = await args.db.insert(schema.questionRequests).values({ threadId: args.threadId, title, questions }).returning();
      asked = true;
      args.onQuestions(request!.id); // caller aborts the loop: no later tools execute
      args.notify?.();
      return { ok: true, content: "Questions sent. Work is paused until the user submits the form.", meta: { requestId: request!.id, title, questions } };
    }),
    defineTool({
      name: "attach_repository",
      description: "Attach an enabled repository to an empty thread workspace. If the user's request clearly identifies it, proceed; if ambiguous, first use ask_questions with type=repository. Never switch repositories after work exists.",
      parameters: { type: "object", properties: { repository: { type: "string", description: "Enabled owner/name." } }, required: ["repository"], additionalProperties: false },
    }, async (input) => {
      if (attached) throw new Error("A repository is already attached.");
      const repo = (await enabledRepositories(args.db, args.userId)).find((r) => r.fullName === input.repository);
      if (!repo) throw new Error("Repository is not enabled for this user.");
      await attachRepository({ sandbox: args.sandbox, repo: repo.fullName, branch: repo.defaultBranch ?? "main",
        ...(args.tokenFor ? { token: await args.tokenFor(repo.installationId, repo.fullName) } : {}) });
      await args.db.update(schema.threads).set({ source: "manual", repo: repo.fullName, installationId: repo.installationId,
        baseRef: repo.defaultBranch ?? "main", updatedAt: new Date() }).where(and(eq(schema.threads.id, args.threadId), eq(schema.threads.source, "workspace")));
      attached = true;
      args.notify?.();
      return { ok: true, content: `Attached ${repo.fullName} in ${args.sandbox.workspace}. Read the repository and continue the original task.` };
    }),
  ];
}
