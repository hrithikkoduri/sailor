/**
 * Keep the git-kind image-build secret fresh.
 *
 * The host-side image build (a deployment with a git build spec) runs on
 * Heyo's infrastructure and reads its git credential from the namespace
 * secret store — it has no route back to us. And a GitHub App installation
 * token only lives an hour, so a value stored once goes stale.
 *
 * The worker mints on the way in: whenever a run might create a fresh VM, the
 * just-minted installation token is upserted into the store, so every build
 * sees a valid credential. No Redis hop — the consumer is Heyo's build job,
 * and it can only read the value from Heyo, so the fresh value has to land
 * there anyway (and runs already mint these tokens per turn).
 *
 * Best-effort at the call site: an older secret is better than a failed run.
 */

export async function refreshBuildSecret(args: {
  server: string;
  token: string;
  namespace: string;
  secret: string;
  key: string;
  value: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<void> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const res = await fetchImpl(`${args.server.replace(/\/+$/, "")}/secrets`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      id: args.secret,
      namespace: args.namespace,
      data: { [args.key]: args.value },
    }),
    signal: AbortSignal.timeout(args.timeoutMs ?? 10_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `build-secret refresh failed: ${res.status}${detail ? ` ${detail.trim()}` : ""}`,
    );
  }
}
