import { createCipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
vi.mock("../../src/lib/logger.js", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { logger } from "../../src/lib/logger.js";
import {
  GITHUB_TOKEN_SWEEP_BATCH_SIZE,
  decryptGithubToken,
  encryptGithubToken,
  isEncryptedGithubToken,
  readGithubToken,
  rewriteLegacyGithubToken,
  startLegacyGithubTokenSweep,
  sweepLegacyGithubTokens,
} from "../../src/services/github-token-crypto.js";

const TOKEN = "gho_exampleTokenValue0123456789";
const SESSION = "session-secret-for-tests-0123456789abcdef";
const DEDICATED = "dedicated-token-key-for-tests-0123456789";

const sessionOnly = { SESSION_SECRET: SESSION };
const dedicatedOnly = { GITHUB_TOKEN_ENCRYPTION_KEY: DEDICATED };
const both = { GITHUB_TOKEN_ENCRYPTION_KEY: DEDICATED, SESSION_SECRET: SESSION };

function parts(stored: string) {
  const [prefix, iv, tag, ct] = stored.split(":");
  return { prefix, iv: iv!, tag: tag!, ct: ct! };
}
function join(p: { iv: string; tag: string; ct: string }) {
  return `v1:${p.iv}:${p.tag}:${p.ct}`;
}
/** Flips the lowest bit of the first byte of a base64url part. */
function flip(part: string) {
  const buf = Buffer.from(part, "base64url");
  buf[0] = buf[0]! ^ 1;
  return buf.toString("base64url");
}

describe("encryptGithubToken / decryptGithubToken", () => {
  it("round-trips and stores a versioned value that does not contain the token", () => {
    const stored = encryptGithubToken(TOKEN, both);
    expect(isEncryptedGithubToken(stored)).toBe(true);
    expect(stored.startsWith("v1:")).toBe(true);
    expect(stored.split(":")).toHaveLength(4);
    expect(stored).not.toContain(TOKEN);
    expect(Buffer.from(parts(stored).iv, "base64url")).toHaveLength(12);
    expect(Buffer.from(parts(stored).tag, "base64url")).toHaveLength(16);
    expect(decryptGithubToken(stored, both)).toBe(TOKEN);
  });

  it("round-trips a token with non-ASCII characters", () => {
    const odd = "gho_äöü-\u{1F511}";
    expect(decryptGithubToken(encryptGithubToken(odd, both), both)).toBe(odd);
  });

  it("uses a fresh random IV per call", () => {
    const a = encryptGithubToken(TOKEN, both);
    const b = encryptGithubToken(TOKEN, both);
    expect(a).not.toBe(b);
    expect(parts(a).iv).not.toBe(parts(b).iv);
  });

  it("defaults to the backend config (SESSION_SECRET of the test environment)", () => {
    const stored = encryptGithubToken(TOKEN);
    expect(decryptGithubToken(stored)).toBe(TOKEN);
    expect(decryptGithubToken(stored, { SESSION_SECRET: process.env.SESSION_SECRET })).toBe(TOKEN);
  });

  it("returns null for a wrong key", () => {
    const stored = encryptGithubToken(TOKEN, both);
    expect(decryptGithubToken(stored, { SESSION_SECRET: "another-session-secret-0123456789abcdef" })).toBeNull();
    expect(decryptGithubToken(stored, { GITHUB_TOKEN_ENCRYPTION_KEY: "another-dedicated-key-0123456789" })).toBeNull();
  });

  describe("key derivation", () => {
    function sealWith(key: Buffer, plain: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
      const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return `v1:${[iv, cipher.getAuthTag(), ct].map((x) => x.toString("base64url")).join(":")}`;
    }

    it("reads a value sealed with HKDF-SHA256(material, empty salt, purpose info) as the AES key", () => {
      const key = Buffer.from(hkdfSync("sha256", SESSION, Buffer.alloc(0), "agent-tasks github-access-token aes-256-gcm v1", 32));
      expect(decryptGithubToken(sealWith(key, TOKEN), sessionOnly)).toBe(TOKEN);
    });

    it("does not read a value sealed with the secret itself, or its hash, as the AES key", () => {
      const raw = Buffer.from(SESSION.padEnd(32, "0").slice(0, 32));
      const hashed = createHash("sha256").update(SESSION).digest();
      expect(decryptGithubToken(sealWith(raw, TOKEN), sessionOnly)).toBeNull();
      expect(decryptGithubToken(sealWith(hashed, TOKEN), sessionOnly)).toBeNull();
    });

    it("derives the same key from the same material in either slot", () => {
      const stored = encryptGithubToken(TOKEN, { GITHUB_TOKEN_ENCRYPTION_KEY: SESSION });
      expect(decryptGithubToken(stored, sessionOnly)).toBe(TOKEN);
    });
  });

  it("an encrypted empty token reads as no token", () => {
    expect(decryptGithubToken(encryptGithubToken("", both), both)).toBeNull();
  });

  describe("key precedence", () => {
    it("dedicated key alone encrypts and decrypts", () => {
      const stored = encryptGithubToken(TOKEN, dedicatedOnly);
      expect(decryptGithubToken(stored, dedicatedOnly)).toBe(TOKEN);
      expect(decryptGithubToken(stored, sessionOnly)).toBeNull();
    });

    it("session secret alone encrypts and decrypts", () => {
      const stored = encryptGithubToken(TOKEN, sessionOnly);
      expect(decryptGithubToken(stored, sessionOnly)).toBe(TOKEN);
      expect(decryptGithubToken(stored, dedicatedOnly)).toBeNull();
    });

    it("both set: the dedicated key wins", () => {
      const stored = encryptGithubToken(TOKEN, both);
      // readable with the dedicated key alone, not with the session secret alone
      expect(decryptGithubToken(stored, dedicatedOnly)).toBe(TOKEN);
      expect(decryptGithubToken(stored, sessionOnly)).toBeNull();
    });

    it("both set: a value written under the session secret alone is unreadable", () => {
      const stored = encryptGithubToken(TOKEN, sessionOnly);
      expect(decryptGithubToken(stored, both)).toBeNull();
    });

    it("dedicated key set to the empty string: falls back to the session secret", () => {
      const stored = encryptGithubToken(TOKEN, { GITHUB_TOKEN_ENCRYPTION_KEY: "", SESSION_SECRET: SESSION });
      expect(decryptGithubToken(stored, sessionOnly)).toBe(TOKEN);
      expect(decryptGithubToken(stored, { GITHUB_TOKEN_ENCRYPTION_KEY: "", SESSION_SECRET: SESSION })).toBe(TOKEN);
      expect(decryptGithubToken(stored, dedicatedOnly)).toBeNull();
    });

    it("dedicated key absent (undefined): falls back to the session secret", () => {
      const stored = encryptGithubToken(TOKEN, { GITHUB_TOKEN_ENCRYPTION_KEY: undefined, SESSION_SECRET: SESSION });
      expect(decryptGithubToken(stored, sessionOnly)).toBe(TOKEN);
    });

    it("no key material at all: encrypt throws, decrypt of a v1 value returns null", () => {
      expect(() => encryptGithubToken(TOKEN, {})).toThrow(/GITHUB_TOKEN_ENCRYPTION_KEY/);
      expect(() => encryptGithubToken(TOKEN, { GITHUB_TOKEN_ENCRYPTION_KEY: "", SESSION_SECRET: "" })).toThrow();
      const stored = encryptGithubToken(TOKEN, both);
      expect(decryptGithubToken(stored, {})).toBeNull();
      expect(decryptGithubToken(stored, { GITHUB_TOKEN_ENCRYPTION_KEY: "", SESSION_SECRET: "" })).toBeNull();
    });
  });

  describe("unreadable values return null", () => {
    const stored = encryptGithubToken(TOKEN, both);
    const p = parts(stored);

    it("tampered ciphertext", () => {
      expect(decryptGithubToken(join({ ...p, ct: flip(p.ct) }), both)).toBeNull();
    });

    it("tampered tag", () => {
      expect(decryptGithubToken(join({ ...p, tag: flip(p.tag) }), both)).toBeNull();
    });

    it("tampered IV", () => {
      expect(decryptGithubToken(join({ ...p, iv: flip(p.iv) }), both)).toBeNull();
    });

    it("truncated tag, at every length a GCM implementation may accept", () => {
      // A valid tag cut to its first N bytes verifies under a decipher that
      // is told to accept N bytes, so only an exact 16-byte requirement in
      // this module rejects it.
      const tag = Buffer.from(p.tag, "base64url");
      for (const n of [1, 4, 8, 12, 15]) {
        expect(decryptGithubToken(join({ ...p, tag: tag.subarray(0, n).toString("base64url") }), both)).toBeNull();
      }
    });

    it("tag with extra bytes", () => {
      const tag = Buffer.concat([Buffer.from(p.tag, "base64url"), Buffer.from([0])]);
      expect(decryptGithubToken(join({ ...p, tag: tag.toString("base64url") }), both)).toBeNull();
    });

    it("empty tag", () => {
      expect(decryptGithubToken(join({ ...p, tag: "" }), both)).toBeNull();
    });

    it("short and long IV", () => {
      const iv = Buffer.from(p.iv, "base64url");
      expect(decryptGithubToken(join({ ...p, iv: iv.subarray(0, 11).toString("base64url") }), both)).toBeNull();
      expect(decryptGithubToken(join({ ...p, iv: Buffer.concat([iv, Buffer.from([0])]).toString("base64url") }), both)).toBeNull();
    });

    it("wrong number of parts", () => {
      expect(decryptGithubToken("v1:", both)).toBeNull();
      expect(decryptGithubToken(`v1:${p.iv}:${p.tag}`, both)).toBeNull();
      expect(decryptGithubToken(`${stored}:extra`, both)).toBeNull();
    });

    it("empty ciphertext part", () => {
      expect(decryptGithubToken(join({ ...p, ct: "" }), both)).toBeNull();
    });
  });

  describe("legacy plaintext and empty values", () => {
    it("a value without the prefix is plaintext and passes through unchanged", () => {
      expect(decryptGithubToken(TOKEN, both)).toBe(TOKEN);
      expect(decryptGithubToken("ghp_legacy", {})).toBe("ghp_legacy");
      expect(decryptGithubToken("github_pat_11AAAA", both)).toBe("github_pat_11AAAA");
    });

    it("null, undefined and the empty string are no token", () => {
      expect(decryptGithubToken(null, both)).toBeNull();
      expect(decryptGithubToken(undefined, both)).toBeNull();
      expect(decryptGithubToken("", both)).toBeNull();
    });
  });
});

describe("readGithubToken and rewriteLegacyGithubToken", () => {
  function fakeClient(result: unknown = { count: 1 }) {
    return { user: { updateMany: vi.fn().mockResolvedValue(result) } };
  }

  it("returns a legacy plaintext token and rewrites it encrypted with a compare-and-swap", async () => {
    const client = fakeClient();
    const token = await readGithubToken({ id: "u1", githubAccessToken: TOKEN }, client);
    expect(token).toBe(TOKEN);
    expect(client.user.updateMany).toHaveBeenCalledTimes(1);
    const args = client.user.updateMany.mock.calls[0]![0];
    expect(args.where).toEqual({ id: "u1", githubAccessToken: TOKEN });
    expect(isEncryptedGithubToken(args.data.githubAccessToken)).toBe(true);
    expect(args.data.githubAccessToken).not.toContain(TOKEN);
    expect(decryptGithubToken(args.data.githubAccessToken)).toBe(TOKEN);
  });

  it("returns an encrypted token without writing", async () => {
    const client = fakeClient();
    const stored = encryptGithubToken(TOKEN);
    expect(await readGithubToken({ id: "u1", githubAccessToken: stored }, client)).toBe(TOKEN);
    expect(client.user.updateMany).not.toHaveBeenCalled();
  });

  it("returns null for an unreadable value and writes nothing", async () => {
    const client = fakeClient();
    const stored = encryptGithubToken(TOKEN, dedicatedOnly);
    expect(await readGithubToken({ id: "u1", githubAccessToken: stored }, client)).toBeNull();
    expect(client.user.updateMany).not.toHaveBeenCalled();
  });

  it("returns null for no stored value and writes nothing", async () => {
    const client = fakeClient();
    expect(await readGithubToken({ id: "u1", githubAccessToken: null }, client)).toBeNull();
    expect(await readGithubToken({ id: "u1", githubAccessToken: "" }, client)).toBeNull();
    expect(client.user.updateMany).not.toHaveBeenCalled();
  });

  it("a failed rewrite does not fail the read and logs nothing about the value", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = { user: { updateMany: vi.fn().mockRejectedValue(new Error(`boom ${TOKEN}`)) } };
    await expect(readGithubToken({ id: "u1", githubAccessToken: TOKEN }, client)).resolves.toBe(TOKEN);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("a rewrite that lost the race (count 0) still returns the token", async () => {
    const client = fakeClient({ count: 0 });
    await expect(readGithubToken({ id: "u1", githubAccessToken: TOKEN }, client)).resolves.toBe(TOKEN);
  });

  it("rewriteLegacyGithubToken skips an encrypted, empty or missing value", async () => {
    const client = fakeClient();
    await rewriteLegacyGithubToken({ id: "u1" }, encryptGithubToken(TOKEN), client);
    await rewriteLegacyGithubToken({ id: "u1" }, "", client);
    await rewriteLegacyGithubToken({ id: "u1" }, null, client);
    await rewriteLegacyGithubToken({ id: "u1" }, undefined, client);
    expect(client.user.updateMany).not.toHaveBeenCalled();
  });
});

describe("sweepLegacyGithubTokens", () => {
  type Row = { id: string; githubAccessToken: string | null };
  function sweepClient(rows: Row[]) {
    let calls = 0;
    const findMany = vi.fn(async (args: { where: { id?: { gt: string } }; take: number }) => {
      // A sweep that does not advance its cursor would loop forever on this fake.
      if (++calls > 50) throw new Error("runaway sweep");
      const after = args.where.id?.gt;
      return rows
        .filter((r) => r.githubAccessToken && !r.githubAccessToken.startsWith("v1:"))
        .filter((r) => after === undefined || r.id > after)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, args.take);
    });
    const updateMany = vi.fn(async (args: { where: { id: string; githubAccessToken: string }; data: { githubAccessToken: string } }) => {
      const row = rows.find((r) => r.id === args.where.id && r.githubAccessToken === args.where.githubAccessToken);
      if (!row) return { count: 0 };
      row.githubAccessToken = args.data.githubAccessToken;
      return { count: 1 };
    });
    return { user: { findMany, updateMany } };
  }

  it("is skipped when no key material is configured", async () => {
    const client = sweepClient([{ id: "a", githubAccessToken: TOKEN }]);
    const result = await sweepLegacyGithubTokens(client, {});
    expect(result).toEqual({ skipped: true, rewritten: 0, failed: 0 });
    expect(client.user.findMany).not.toHaveBeenCalled();
  });

  it("selects only non-null rows that do not start with the prefix", async () => {
    const client = sweepClient([]);
    await sweepLegacyGithubTokens(client, both);
    expect(client.user.findMany.mock.calls[0]![0]).toMatchObject({
      where: { githubAccessToken: { not: null }, NOT: { githubAccessToken: { startsWith: "v1:" } } },
      orderBy: { id: "asc" },
      take: GITHUB_TOKEN_SWEEP_BATCH_SIZE,
    });
  });

  it("encrypts plaintext rows, leaves encrypted rows byte for byte, and is idempotent", async () => {
    const encrypted = encryptGithubToken("gho_already", both);
    const rows: Row[] = [
      { id: "a", githubAccessToken: "gho_one" },
      { id: "b", githubAccessToken: encrypted },
      { id: "c", githubAccessToken: "gho_two" },
      { id: "d", githubAccessToken: null },
    ];
    const client = sweepClient(rows);
    const first = await sweepLegacyGithubTokens(client, both);
    expect(first).toEqual({ skipped: false, rewritten: 2, failed: 0 });
    expect(decryptGithubToken(rows[0]!.githubAccessToken, both)).toBe("gho_one");
    expect(decryptGithubToken(rows[2]!.githubAccessToken, both)).toBe("gho_two");
    expect(rows[1]!.githubAccessToken).toBe(encrypted);
    expect(rows[3]!.githubAccessToken).toBeNull();

    const snapshot = rows.map((r) => r.githubAccessToken);
    client.user.updateMany.mockClear();
    const second = await sweepLegacyGithubTokens(client, both);
    expect(second).toEqual({ skipped: false, rewritten: 0, failed: 0 });
    expect(client.user.updateMany).not.toHaveBeenCalled();
    expect(rows.map((r) => r.githubAccessToken)).toEqual(snapshot);
  });

  it("walks every batch with an id cursor", async () => {
    const rows: Row[] = Array.from({ length: 5 }, (_, i) => ({ id: `u${i}`, githubAccessToken: `gho_${i}` }));
    const client = sweepClient(rows);
    const result = await sweepLegacyGithubTokens(client, both, 2);
    expect(result.rewritten).toBe(5);
    expect(rows.every((r) => isEncryptedGithubToken(r.githubAccessToken!))).toBe(true);
    expect(client.user.findMany).toHaveBeenCalledTimes(3);
    const second = client.user.findMany.mock.calls[1]![0] as { where: { id: { gt: string } } };
    expect(second.where.id).toEqual({ gt: "u1" });
  });

  it("does not stop at a row that stays as it is (empty string)", async () => {
    const rows: Row[] = [
      { id: "a", githubAccessToken: "" },
      { id: "b", githubAccessToken: "gho_b" },
      { id: "c", githubAccessToken: "gho_c" },
    ];
    const client = sweepClient(rows);
    let calls = 0;
    client.user.findMany.mockImplementation(async (args: { where: { id?: { gt: string } }; take: number }) => {
      if (++calls > 50) throw new Error("runaway sweep");
      const after = args.where.id?.gt;
      return rows.filter((r) => !r.githubAccessToken?.startsWith("v1:")).filter((r) => after === undefined || r.id > after).slice(0, args.take);
    });
    const result = await sweepLegacyGithubTokens(client, both, 1);
    expect(result.rewritten).toBe(2);
    expect(isEncryptedGithubToken(rows[2]!.githubAccessToken!)).toBe(true);
  });

  it("counts a failed row and keeps going; a lost compare-and-swap is neither counted nor overwritten", async () => {
    const rows: Row[] = [
      { id: "a", githubAccessToken: "gho_a" },
      { id: "b", githubAccessToken: "gho_b" },
      { id: "c", githubAccessToken: "gho_c" },
    ];
    const client = sweepClient(rows);
    const original = client.user.updateMany.getMockImplementation()!;
    client.user.updateMany.mockImplementation(async (args) => {
      if (args.where.id === "a") throw new Error(`db down ${TOKEN}`);
      if (args.where.id === "b") {
        rows[1]!.githubAccessToken = encryptGithubToken("gho_newer", both); // reconnect in between
      }
      return original(args);
    });
    const result = await sweepLegacyGithubTokens(client, both);
    expect(result).toEqual({ skipped: false, rewritten: 1, failed: 1 });
    expect(rows[0]!.githubAccessToken).toBe("gho_a");
    expect(decryptGithubToken(rows[1]!.githubAccessToken, both)).toBe("gho_newer");
    expect(isEncryptedGithubToken(rows[2]!.githubAccessToken!)).toBe(true);
  });
});

describe("startLegacyGithubTokenSweep", () => {
  beforeEach(() => {
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.error).mockClear();
  });

  it("logs the counts only and never a token", async () => {
    const rows = [{ id: "a", githubAccessToken: TOKEN }];
    const findMany = vi.fn().mockResolvedValueOnce(rows).mockResolvedValue([]);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    startLegacyGithubTokenSweep({ user: { findMany, updateMany } });
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalled());
    expect(vi.mocked(logger.info).mock.calls[0]).toEqual([{ rewritten: 1, failed: 0 }, "GitHub token sweep finished"]);
    expect(JSON.stringify([vi.mocked(logger.info).mock.calls, vi.mocked(logger.error).mock.calls])).not.toContain(TOKEN);
  });

  it("logs nothing when there was nothing to do", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    startLegacyGithubTokenSweep({ user: { findMany, updateMany: vi.fn() } });
    await vi.waitFor(() => expect(findMany).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("does not throw when the query fails and logs a fixed message without the error text", async () => {
    const findMany = vi.fn().mockRejectedValue(new Error(`connection refused ${TOKEN}`));
    expect(() => startLegacyGithubTokenSweep({ user: { findMany, updateMany: vi.fn() } })).not.toThrow();
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledTimes(1));
    const call = vi.mocked(logger.error).mock.calls[0]!;
    expect(call).toHaveLength(1);
    expect(JSON.stringify(call)).not.toContain(TOKEN);
    expect(JSON.stringify(call)).not.toContain("connection refused");
  });
});

describe("config: GITHUB_TOKEN_ENCRYPTION_KEY", () => {
  const origEnv = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    process.env = { ...origEnv };
  });

  async function configWith(value: string | undefined) {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.SESSION_SECRET = "a".repeat(32);
    if (value === undefined) delete process.env.GITHUB_TOKEN_ENCRYPTION_KEY;
    else process.env.GITHUB_TOKEN_ENCRYPTION_KEY = value;
    return (await import("../../src/config/index.js")).config;
  }

  it("absent is unset", async () => {
    expect((await configWith(undefined)).GITHUB_TOKEN_ENCRYPTION_KEY).toBeUndefined();
  });

  it("the empty string is unset", async () => {
    expect((await configWith("")).GITHUB_TOKEN_ENCRYPTION_KEY).toBeUndefined();
  });

  it("a value is passed through", async () => {
    expect((await configWith("k".repeat(40))).GITHUB_TOKEN_ENCRYPTION_KEY).toBe("k".repeat(40));
  });

  it("the default key source follows the config: dedicated beats session, empty falls back", async () => {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.SESSION_SECRET = SESSION;
    process.env.GITHUB_TOKEN_ENCRYPTION_KEY = DEDICATED;
    const crypto = await import("../../src/services/github-token-crypto.js");
    const stored = crypto.encryptGithubToken(TOKEN);
    expect(crypto.decryptGithubToken(stored, dedicatedOnly)).toBe(TOKEN);
    expect(crypto.decryptGithubToken(stored, sessionOnly)).toBeNull();

    vi.resetModules();
    process.env.GITHUB_TOKEN_ENCRYPTION_KEY = "";
    const crypto2 = await import("../../src/services/github-token-crypto.js");
    const stored2 = crypto2.encryptGithubToken(TOKEN);
    expect(crypto2.decryptGithubToken(stored2, sessionOnly)).toBe(TOKEN);
  });
});
