/** Reading event payloads — the shapes come from the server's renderers. */

export const payloadStr = (payload: Record<string, unknown>, key: string): string | undefined =>
  typeof payload[key] === "string" ? (payload[key] as string) : undefined;

export const payloadNum = (payload: Record<string, unknown>, key: string): number | undefined =>
  typeof payload[key] === "number" ? (payload[key] as number) : undefined;

/** The human who authored a GitHub-ish event (review, comment, sender). */
export function eventAuthor(payload: Record<string, unknown>): string | undefined {
  const direct = payloadStr(payload, "author");
  if (direct) return direct;
  const sender = payload.sender as { login?: unknown } | undefined;
  if (sender && typeof sender.login === "string") return sender.login;
  const user = payload.user as { login?: unknown } | undefined;
  return user && typeof user.login === "string" ? user.login : undefined;
}

/** One-line summary of an event for rails and previews. */
export function eventPreview(kind: string, payload: Record<string, unknown>): string {
  const body = payloadStr(payload, "body");
  if (body) return body.slice(0, 220);
  const title = payloadStr(payload, "title");
  if (title) return title;
  const ref = payloadStr(payload, "ref");
  if (ref) return `push to ${ref}`;
  const checks = Array.isArray(payload.checks) ? (payload.checks as string[]).join(", ") : undefined;
  if (checks) return `CI: ${checks}`;
  return kind.replace(/_/g, " ");
}
