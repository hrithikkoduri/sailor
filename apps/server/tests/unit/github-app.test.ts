/**
 * The GitHub App service (decision #42): RS256 JWTs and installation-token
 * caching. Pure unit tests — no network (injected fetch), no real clock.
 */
import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGitHubApp, signAppJwt } from "../../src/github/app.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

describe("github app service", () => {
  it("signs a valid RS256 app JWT", () => {
    const now = () => 1_700_000_000_000;
    const jwt = signAppJwt("123", privatePem, now);
    const [header, payload, signature] = jwt.split(".");

    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as {
      iss: string;
      iat: number;
      exp: number;
    };
    expect(claims.iss).toBe("123");
    expect(claims.exp - claims.iat).toBe(600); // well under the 10-minute cap

    const signatureOk = verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature!, "base64url"),
    );
    expect(signatureOk).toBe(true);
  });

  it("mints per installation and caches until the refresh window", async () => {
    let nowMs = 1_700_000_000_000;
    const calls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({ token: `tok-${calls.length}`, expires_at: new Date(nowMs + 60 * 60_000).toISOString() }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const app = createGitHubApp({ appId: "1", privateKey: privatePem, fetchFn, now: () => nowMs });

    expect(await app.tokenFor(5)).toBe("tok-1");
    expect(await app.tokenFor(5)).toBe("tok-1"); // cached
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/app/installations/5/access_tokens");

    nowMs += 56 * 60_000; // inside the 5-minute refresh window → mint again
    expect(await app.tokenFor(5)).toBe("tok-2");
    expect(calls).toHaveLength(2);
  });
});
