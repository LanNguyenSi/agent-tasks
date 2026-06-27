import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "../../src/services/github-webhook.js";
import { createHmac } from "node:crypto";

const SECRET = "webhook-secret-test";

function makeSignature(payload: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

describe("verifyWebhookSignature", () => {
  it("returns true for a valid signature", () => {
    const payload = JSON.stringify({ action: "opened" });
    const sig = makeSignature(payload, SECRET);
    expect(verifyWebhookSignature(payload, sig, SECRET)).toBe(true);
  });

  it("returns false for an invalid signature", () => {
    const payload = JSON.stringify({ action: "opened" });
    expect(verifyWebhookSignature(payload, "sha256=invalid", SECRET)).toBe(false);
  });

  it("returns false for null signature", () => {
    expect(verifyWebhookSignature("payload", null, SECRET)).toBe(false);
  });

  it("returns false for wrong secret", () => {
    const payload = JSON.stringify({ test: true });
    const sig = makeSignature(payload, "wrong-secret");
    expect(verifyWebhookSignature(payload, sig, SECRET)).toBe(false);
  });

  it("returns false for tampered payload", () => {
    const sig = makeSignature('{"action":"opened"}', SECRET);
    expect(verifyWebhookSignature('{"action":"closed"}', sig, SECRET)).toBe(false);
  });

  it("requires sha256= prefix", () => {
    const payload = "test";
    const rawHash = createHmac("sha256", SECRET).update(payload).digest("hex");
    // Without prefix — should fail
    expect(verifyWebhookSignature(payload, rawHash, SECRET)).toBe(false);
  });

  // L1: the compare must not branch on length (no early length short-circuit).
  // These pin that a wrong-length candidate still resolves to false without
  // throwing, the same way an equal-length wrong candidate does.
  it("returns false for a too-short signature without throwing", () => {
    const payload = JSON.stringify({ action: "opened" });
    expect(verifyWebhookSignature(payload, "sha256=abc", SECRET)).toBe(false);
  });

  it("returns false for a too-long signature without throwing", () => {
    const payload = JSON.stringify({ action: "opened" });
    const valid = makeSignature(payload, SECRET);
    expect(verifyWebhookSignature(payload, valid + "extra", SECRET)).toBe(false);
  });

  it("returns false for an empty signature string", () => {
    expect(verifyWebhookSignature("payload", "", SECRET)).toBe(false);
  });
});
