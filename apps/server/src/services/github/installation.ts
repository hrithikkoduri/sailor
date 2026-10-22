/** Installation lifecycle: the repo gate's own plumbing. */
import { and, eq } from "drizzle-orm";
type InstallationEvent = {
  action?: string;
  installation?: { id?: number; account?: { login?: string; type?: string } };
  repositories?: Array<{ full_name?: string; default_branch?: string }>;
  repositories_removed?: Array<{ full_name?: string }>;
  sender?: { login?: string; type?: string };
};
import { schema } from "../../db/index.js";
import { upsertInstallation } from "./installations.js";
import { ignored, reply, type WebhookResult } from "./webhook-support.js";
import type { WebhookDeps } from "./webhook-support.js";

export async function handleInstallationEvent(
  deps: WebhookDeps,
  eventName: string,
  payload: Record<string, unknown>,
  log: (line: string) => void,
): Promise<WebhookResult> {
  const event = payload as InstallationEvent;
  const id = event.installation?.id;
  if (typeof id !== "number") return ignored("no installation id");

  if (eventName === "installation_repositories") {
    const [row] = await deps.db
      .select()
      .from(schema.installations)
      .where(eq(schema.installations.installationId, id));
    if (!row) return ignored("unknown installation");
    for (const repo of event.repositories ?? []) {
      if (!repo.full_name) continue;
      await deps.db
        .insert(schema.repositories)
        .values({
          installationRef: row.id,
          fullName: repo.full_name,
          defaultBranch: repo.default_branch ?? null,
        })
        .onConflictDoNothing();
    }
    for (const repo of event.repositories_removed ?? []) {
      if (!repo.full_name) continue;
      await deps.db
        .delete(schema.repositories)
        .where(
          and(
            eq(schema.repositories.installationRef, row.id),
            eq(schema.repositories.fullName, repo.full_name),
          ),
        );
    }
    log(
      `webhook: installation_repositories for ${id} (+${event.repositories?.length ?? 0} / -${event.repositories_removed?.length ?? 0})`,
    );
    return reply({ ok: true }, 200);
  }

  switch (event.action) {
    case "created": {
      // Fallback binder (decision #43): the sender is the installer — link the
      // installation when we already know that user (the state param is primary).
      const senderLogin = event.sender?.login;
      let userId: string | undefined;
      if (senderLogin) {
        const [user] = await deps.db
          .select()
          .from(schema.users)
          .where(eq(schema.users.login, senderLogin));
        userId = user?.id;
      }
      await upsertInstallation(deps.db, {
        installationId: id,
        accountLogin: event.installation?.account?.login ?? "unknown",
        accountType: event.installation?.account?.type ?? "User",
        ...(userId !== undefined ? { userId } : {}),
      });
      log(
        `webhook: installation ${id} created (${event.installation?.account?.login ?? "?"})${userId ? " — linked by sender" : ""}`,
      );
      return reply({ ok: true }, 200);
    }
    case "deleted": {
      await deps.db
        .delete(schema.installations)
        .where(eq(schema.installations.installationId, id));
      log(`webhook: installation ${id} deleted`);
      return reply({ ok: true }, 200);
    }
    case "suspend":
    case "unsuspend": {
      await deps.db
        .update(schema.installations)
        .set({ suspended: event.action === "suspend", updatedAt: new Date() })
        .where(eq(schema.installations.installationId, id));
      log(`webhook: installation ${id} ${event.action}`);
      return reply({ ok: true }, 200);
    }
    default:
      return ignored(`installation action ${event.action ?? "?"}`);
  }
}
