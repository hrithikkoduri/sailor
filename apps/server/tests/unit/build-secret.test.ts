/**
 * The git-kind build-secret refresh — mocked fetch, no network. It must be
 * exactly the upsert heyctl performs (`POST /secrets` with {id, namespace,
 * data}), because the host-side build reads the value straight from the store.
 */
import { describe, expect, it } from "vitest";
import { refreshBuildSecret } from "../../src/heyo/build-secret.js";

describe("refreshBuildSecret", () => {
  it("upserts the namespace secret with the fresh value", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    await refreshBuildSecret({
      server: "https://admin.us5.heyo.work/",
      token: "applb_test",
      namespace: "harness",
      secret: "heyo-build-git",
      key: "git-token",
      value: "ghs_fresh",
      fetchImpl: async (url, init) => {
        seen = { url: String(url), init: init ?? {} };
        return new Response(JSON.stringify({ id: "heyo-build-git" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    expect(seen!.url).toBe("https://admin.us5.heyo.work/secrets");
    expect(seen!.init.method).toBe("POST");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe(
      "Bearer applb_test",
    );
    expect(JSON.parse(String(seen!.init.body))).toEqual({
      id: "heyo-build-git",
      namespace: "harness",
      data: { "git-token": "ghs_fresh" },
    });
  });

  it("throws on a non-ok response so the caller keeps the stored value", async () => {
    await expect(
      refreshBuildSecret({
        server: "https://admin.us5.heyo.work",
        token: "t",
        namespace: "harness",
        secret: "s",
        key: "k",
        value: "v",
        fetchImpl: async () => new Response("denied", { status: 403 }),
      }),
    ).rejects.toThrow(/403/);
  });
});
