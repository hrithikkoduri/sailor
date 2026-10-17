import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "../../src/github/signature.js";

const SECRET = "s3cret";
const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("verifyWebhookSignature", () => {
  it("accepts a correctly signed body", () => {
    const body = JSON.stringify({ hello: "world" });
    expect(verifyWebhookSignature(SECRET, body, sign(body))).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify({ hello: "world" });
    expect(verifyWebhookSignature(SECRET, `${body} `, sign(body))).toBe(false);
  });

  it("rejects a signature from the wrong secret", () => {
    const body = "{}";
    expect(verifyWebhookSignature(SECRET, body, sign(body, "other"))).toBe(false);
  });

  it("rejects missing/malformed headers and an empty secret", () => {
    expect(verifyWebhookSignature(SECRET, "{}", undefined)).toBe(false);
    expect(verifyWebhookSignature(SECRET, "{}", "sha1=deadbeef")).toBe(false);
    expect(verifyWebhookSignature(SECRET, "{}", "sha256=not-hex")).toBe(false);
    expect(verifyWebhookSignature("", "{}", sign("{}"))).toBe(false);
  });
});
