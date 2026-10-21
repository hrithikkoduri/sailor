import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, encryptionKey } from "../../src/secrets/store.js";

const key = Buffer.alloc(32, 7);

describe("secret encryption", () => {
  it("round-trips a value bound to its owner and name", () => {
    const parts = encryptSecret(key, "user-1", "daytona", "sk-live-123");
    expect(parts.ciphertext).not.toContain("sk-live-123");
    expect(decryptSecret(key, "user-1", "daytona", parts)).toBe("sk-live-123");
  });

  it("refuses a ciphertext moved to another owner or name", () => {
    const parts = encryptSecret(key, "user-1", "daytona", "sk-live-123");
    expect(() => decryptSecret(key, "user-2", "daytona", parts)).toThrow();
    expect(() => decryptSecret(key, "user-1", "other", parts)).toThrow();
  });

  it("refuses a different key and produces a distinct iv each time", () => {
    const parts = encryptSecret(key, "u", "n", "value");
    expect(() => decryptSecret(Buffer.alloc(32, 9), "u", "n", parts)).toThrow();
    expect(encryptSecret(key, "u", "n", "value").iv).not.toBe(parts.iv);
  });

  it("requires a 32-byte base64 deployment key", () => {
    expect(() => encryptionKey({} as NodeJS.ProcessEnv)).toThrow(/SAILOR_SECRET_KEY/);
    expect(() => encryptionKey({ SAILOR_SECRET_KEY: Buffer.alloc(16).toString("base64") } as NodeJS.ProcessEnv))
      .toThrow(/32 bytes/);
    expect(encryptionKey({ SAILOR_SECRET_KEY: key.toString("base64") } as NodeJS.ProcessEnv)).toHaveLength(32);
  });
});