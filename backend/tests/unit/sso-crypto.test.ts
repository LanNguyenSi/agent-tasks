/**
 * Unit tests for services/sso-crypto.ts
 *
 * AES-256-GCM encrypt/decrypt: round-trips, non-determinism, key formats,
 * and all guards (empty key, wrong-length key, tampered payload, short
 * payload, wrong key). No DB, no network.
 */
import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "../../src/services/sso-crypto.js";

// 64 hex chars = 32 bytes (the canonical key format)
const KEY = "0".repeat(64);
// Same 32 bytes expressed as base64
const KEY_B64 = Buffer.from(Buffer.from(KEY, "hex")).toString("base64");
// A different valid key, used for wrong-key tests
const OTHER_KEY = "f".repeat(64);

// ── round-trip ────────────────────────────────────────────────────────────────

describe("encryptSecret / decryptSecret — round-trip", () => {
  it("normal string", async () => {
    const s = "hello, world!";
    expect(await decryptSecret(await encryptSecret(s, KEY), KEY)).toBe(s);
  });

  it("empty string", async () => {
    expect(await decryptSecret(await encryptSecret("", KEY), KEY)).toBe("");
  });

  it("unicode / long string", async () => {
    const s = "こんにちは世界! 🎉 " + "x".repeat(1000);
    expect(await decryptSecret(await encryptSecret(s, KEY), KEY)).toBe(s);
  });
});

// ── non-determinism ───────────────────────────────────────────────────────────

describe("encryptSecret — non-determinism", () => {
  it("two encryptions of the same value differ (random IV) yet both decrypt correctly", async () => {
    const s = "determinism-test";
    const a = await encryptSecret(s, KEY);
    const b = await encryptSecret(s, KEY);
    expect(a).not.toBe(b);
    expect(await decryptSecret(a, KEY)).toBe(s);
    expect(await decryptSecret(b, KEY)).toBe(s);
  });
});

// ── key formats ───────────────────────────────────────────────────────────────

describe("key formats", () => {
  it("accepts a base64-encoded 32-byte key for a full round-trip", async () => {
    const s = "key-format test";
    expect(await decryptSecret(await encryptSecret(s, KEY_B64), KEY_B64)).toBe(s);
  });
});

// ── guard: empty key ──────────────────────────────────────────────────────────

describe("guard: empty key", () => {
  it("encryptSecret rejects with /not configured/", async () => {
    await expect(encryptSecret("x", "")).rejects.toThrow(/not configured/);
  });

  it("decryptSecret rejects with /not configured/", async () => {
    const enc = await encryptSecret("x", KEY);
    await expect(decryptSecret(enc, "")).rejects.toThrow(/not configured/);
  });
});

// ── guard: wrong-length key ───────────────────────────────────────────────────

describe("guard: wrong-length key", () => {
  it("31-byte hex string (62 chars) rejects with /32 bytes/", async () => {
    await expect(encryptSecret("x", "0".repeat(62))).rejects.toThrow(/32 bytes/);
  });

  it("33-byte hex string (66 chars) falls into base64 path and rejects with /32 bytes/", async () => {
    // 66 chars is not a valid 64-char hex string, so decodeKey tries base64.
    // base64("0".repeat(66)) decodes to 49 bytes, which is != 32.
    await expect(encryptSecret("x", "0".repeat(66))).rejects.toThrow(/32 bytes/);
  });
});

// ── guard: tampered ciphertext ────────────────────────────────────────────────

describe("guard: tampered ciphertext", () => {
  it("flipping a byte in the ciphertext/tag region causes decryption to reject (GCM auth)", async () => {
    const s = "tamper-test value";
    const enc = await encryptSecret(s, KEY);
    const buf = Buffer.from(enc, "base64");
    // Index 13 is past the 12-byte IV, inside the ciphertext.
    buf[13] = buf[13]! ^ 0xff;
    const tampered = buf.toString("base64");
    await expect(decryptSecret(tampered, KEY)).rejects.toThrow();
  });

  it("flipping the last byte (GCM tag region) also causes decryption to reject", async () => {
    const s = "tamper-tag-test";
    const enc = await encryptSecret(s, KEY);
    const buf = Buffer.from(enc, "base64");
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0x01;
    const tampered = buf.toString("base64");
    await expect(decryptSecret(tampered, KEY)).rejects.toThrow();
  });
});

// ── guard: short payload ──────────────────────────────────────────────────────

describe("guard: short payload (<= IV_LENGTH = 12 bytes)", () => {
  it("6-byte payload rejects with /Invalid encrypted secret payload/", async () => {
    // "shorty" = 6 ASCII chars = 6 bytes; 6 <= 12 → guard fires.
    const short = Buffer.from("shorty").toString("base64");
    await expect(decryptSecret(short, KEY)).rejects.toThrow(/Invalid encrypted secret payload/);
  });

  it("exactly 12-byte payload rejects with /Invalid encrypted secret payload/", async () => {
    // The guard is buf.length <= IV_LENGTH (12), so exactly 12 bytes must also reject.
    const exact12 = Buffer.alloc(12).toString("base64");
    await expect(decryptSecret(exact12, KEY)).rejects.toThrow(/Invalid encrypted secret payload/);
  });
});

// ── guard: wrong key ──────────────────────────────────────────────────────────

describe("guard: wrong key", () => {
  it("decrypting with a different valid key rejects (GCM auth failure)", async () => {
    const enc = await encryptSecret("secret value", KEY);
    await expect(decryptSecret(enc, OTHER_KEY)).rejects.toThrow();
  });
});
