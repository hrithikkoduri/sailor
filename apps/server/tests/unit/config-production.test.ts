import { describe, expect, it } from "vitest";
import { assertProductionEnv, loadConfig } from "../../src/config.js";

const good = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://sailor@db:5432/sailor",
  REDIS_URL: "redis://cache:6379",
  SAILOR_PUBLIC_URL: "https://sailor.example.com",
  GITHUB_APP_ID: "1",
  GITHUB_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
  GITHUB_WEBHOOK_SECRET: "secret",
  SAILOR_SECRET_KEY: Buffer.alloc(32, 1).toString("base64"),
  SAILOR_SANDBOX: "e2b",
  E2B_API_KEY: "e2b-key",
} as NodeJS.ProcessEnv;

describe("production config", () => {
  it("accepts a complete production environment", () => {
    expect(() => assertProductionEnv(good)).not.toThrow();
    expect(loadConfig(good).auth.secureCookies).toBe(true);
  });

  it("refuses to boot on an http public URL — cookies would lose Secure", () => {
    expect(() => assertProductionEnv({ ...good, SAILOR_PUBLIC_URL: "http://sailor.example.com" }))
      .toThrow(/https/);
  });

  it("names every missing or invalid setting at once", () => {
    let message = "";
    try { assertProductionEnv({ NODE_ENV: "production" }); } catch (err) { message = String(err); }
    for (const key of ["DATABASE_URL", "REDIS_URL", "SAILOR_PUBLIC_URL", "GITHUB_WEBHOOK_SECRET", "SAILOR_SECRET_KEY"])
      expect(message).toContain(key);
  });

  it("requires the credential for the selected sandbox backend", () => {
    expect(() => assertProductionEnv({ ...good, SAILOR_SANDBOX: "heyo" })).toThrow(/HEYO_TOKEN/);
  });

  it("stays permissive outside production", () => {
    expect(() => assertProductionEnv({ NODE_ENV: "development" })).not.toThrow();
  });
});