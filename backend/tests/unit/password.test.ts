import { describe, expect, it } from "vitest";

import {
  DUMMY_PASSWORD_HASH,
  fakeVerifyPassword,
  hashPassword,
  verifyPassword,
} from "../../src/services/password.js";

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });
});

describe("login timing equalizer (M4)", () => {
  it("DUMMY_PASSWORD_HASH is a well-formed salt:digest so the full KDF runs", () => {
    // 32-hex-char salt : 128-hex-char (64-byte) scrypt digest — same shape as a
    // real hash, so verifyPassword takes the scrypt + timing-safe-compare path,
    // not its malformed-input early return. That equal work IS the timing
    // guarantee that closes the user-enumeration oracle.
    expect(DUMMY_PASSWORD_HASH).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
  });

  it("fakeVerifyPassword resolves and never validates an arbitrary password", async () => {
    await expect(fakeVerifyPassword("anything")).resolves.toBeUndefined();
    // The dummy hash must not coincidentally accept arbitrary input — proof the
    // compare actually ran against a real digest.
    expect(await verifyPassword("anything", DUMMY_PASSWORD_HASH)).toBe(false);
  });

  it("fakeVerifyPassword actually pays the scrypt cost (a no-op would reopen the oracle)", async () => {
    // scrypt (N=16384) always takes several milliseconds; a no-op stub would be
    // sub-millisecond. Floor at 1ms so gutting fakeVerifyPassword to
    // `async () => {}` fails this test and the enumeration oracle cannot
    // silently return.
    const start = performance.now();
    await fakeVerifyPassword("some-password");
    expect(performance.now() - start).toBeGreaterThan(1);
  });
});
