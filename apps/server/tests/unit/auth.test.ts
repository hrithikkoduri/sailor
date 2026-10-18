/**
 * Auth primitives (decision #41): argon2id hashing and session-token hashing.
 */
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword, passwordProblem, normalizeEmail } from "../../src/auth/password.js";
import { hashToken } from "../../src/auth/session.js";

describe("passwords (argon2id)", () => {
  it("hashes and verifies; the wrong password fails", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("$argon2")).toBe(true); // argon2id-encoded hash
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(hash, "wrong")).toBe(false);
  }, 20_000);

  it("enforces the basic rules and email normalization", () => {
    expect(passwordProblem("short")).toBeTruthy();
    expect(passwordProblem("longenough")).toBeUndefined();
    expect(normalizeEmail(" Foo@Bar.COM ")).toBe("foo@bar.com");
    expect(normalizeEmail("nope")).toBeUndefined();
  });
});

describe("session tokens", () => {
  it("hashes deterministically — the DB never sees the raw token", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abc")).toHaveLength(64);
    expect(hashToken("abc")).not.toBe(hashToken("abd"));
  });
});
