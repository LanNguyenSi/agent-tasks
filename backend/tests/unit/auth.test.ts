import { describe, expect, it } from "vitest";
import { hashToken } from "../../src/middleware/auth.js";

describe("hashToken", () => {
  it("produces a consistent hash for the same input", () => {
    const hash1 = hashToken("test-token");
    const hash2 = hashToken("test-token");
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different inputs", () => {
    expect(hashToken("token-a")).not.toBe(hashToken("token-b"));
  });

  it("returns a 64-char hex string (SHA-256)", () => {
    const hash = hashToken("at_abc123");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
