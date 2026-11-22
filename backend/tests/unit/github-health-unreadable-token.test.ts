/**
 * An unreadable stored GitHub token (the encryption key changed, or the value
 * was tampered with) is "not connected" for the health check, like it is for
 * `/auth/me`, and the ops count includes such rows. Prisma is mocked: the
 * count suite evaluates the `where` shapes the function sends against an
 * in-memory table, so a row left out of a query is observable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const SESSION_SECRET = "test-session-secret-must-be-32chars!!";

const prismaMocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  userUpdateMany: vi.fn(),
  userCount: vi.fn(),
  userFindMany: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    user: {
      findUnique: prismaMocks.userFindUnique,
      update: prismaMocks.userUpdate,
      updateMany: prismaMocks.userUpdateMany,
      count: prismaMocks.userCount,
      findMany: prismaMocks.userFindMany,
    },
  },
}));

vi.mock("../../src/config/index.js", async (orig) => {
  const actual = await orig<typeof import("../../src/config/index.js")>();
  return { ...actual, config: { ...actual.config, SESSION_SECRET: "test-session-secret-must-be-32chars!!", GITHUB_TOKEN_ENCRYPTION_KEY: undefined } };
});

import { INVALID_TOKEN_SCAN_BATCH_SIZE, countInvalidTokenUsers, getTokenHealth } from "../../src/services/github-health.js";
import { encryptGithubToken } from "../../src/services/github-token-crypto.js";

const TOKEN = "gho_realisticLookingToken0123456789";
const READABLE = encryptGithubToken(TOKEN, { SESSION_SECRET });
const UNREADABLE = "v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AAAA";
const WRONG_KEY = encryptGithubToken(TOKEN, { GITHUB_TOKEN_ENCRYPTION_KEY: "some-other-key-0123456789abcdef" });
const CONNECTED_AT = new Date("2026-01-01T00:00:00.000Z");

describe("getTokenHealth for an unreadable stored token", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function userRow(githubAccessToken: string | null, extra: Record<string, unknown> = {}) {
    return {
      id: "user-1",
      githubAccessToken,
      githubConnectedAt: CONNECTED_AT,
      githubTokenHealthy: null,
      githubTokenLastCheckedAt: null,
      ...extra,
    };
  }

  it.each([
    ["a value that does not decrypt", UNREADABLE],
    ["a value encrypted under another key", WRONG_KEY],
  ])("returns not_connected for %s, sends no probe and writes nothing", async (_label, stored) => {
    prismaMocks.userFindUnique.mockResolvedValue(userRow(stored));
    expect(await getTokenHealth("user-1")).toEqual({ state: "not_connected", lastCheckedAt: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prismaMocks.userUpdate).not.toHaveBeenCalled();
    expect(prismaMocks.userUpdateMany).not.toHaveBeenCalled();
  });

  it("ignores a stale healthy flag left by the old token", async () => {
    prismaMocks.userFindUnique.mockResolvedValue(
      userRow(UNREADABLE, { githubTokenHealthy: true, githubTokenLastCheckedAt: new Date() }),
    );
    expect((await getTokenHealth("user-1")).state).toBe("not_connected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still probes a readable token", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    prismaMocks.userFindUnique.mockResolvedValue(userRow(READABLE));
    prismaMocks.userUpdate.mockResolvedValue({});
    expect((await getTokenHealth("user-1")).state).toBe("healthy");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns not_connected for a null token column and for a null connection time", async () => {
    prismaMocks.userFindUnique.mockResolvedValue(userRow(null));
    expect((await getTokenHealth("user-1")).state).toBe("not_connected");
    prismaMocks.userFindUnique.mockResolvedValue(userRow(READABLE, { githubConnectedAt: null }));
    expect((await getTokenHealth("user-1")).state).toBe("not_connected");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("countInvalidTokenUsers", () => {
  type Row = { id: string; githubAccessToken: string | null; githubConnectedAt: Date | null; githubTokenHealthy: boolean | null };
  let table: Row[];

  /** The where shapes the function sends, evaluated over `table`. */
  function matches(row: Row, where: Record<string, unknown>): boolean {
    // Evaluated only when the query asks for it, so dropping a clause from the
    // function's `where` lets the extra rows through and a test sees it.
    if ("githubAccessToken" in where && row.githubAccessToken === null) return false;
    if ("githubConnectedAt" in where && row.githubConnectedAt === null) return false;
    if ("githubTokenHealthy" in where && row.githubTokenHealthy !== where.githubTokenHealthy) return false;
    const or = where.OR as Array<{ githubTokenHealthy: boolean | null }> | undefined;
    if (or && !or.some((o) => row.githubTokenHealthy === o.githubTokenHealthy)) return false;
    const id = where.id as { gt: string } | undefined;
    if (id && !(row.id > id.gt)) return false;
    return true;
  }

  const row = (id: string, token: string | null, healthy: boolean | null, connected = true): Row => ({
    id,
    githubAccessToken: token,
    githubConnectedAt: connected ? CONNECTED_AT : null,
    githubTokenHealthy: healthy,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    table = [];
    prismaMocks.userCount.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      table.filter((r) => matches(r, where)).length,
    );
    prismaMocks.userFindMany.mockImplementation(
      async ({ where, take }: { where: Record<string, unknown>; take: number }) =>
        table
          .filter((r) => matches(r, where))
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, take)
          .map((r) => ({ id: r.id, githubAccessToken: r.githubAccessToken })),
    );
  });

  it("is 0 for an empty table", async () => {
    expect(await countInvalidTokenUsers()).toBe(0);
  });

  it("counts a row a probe marked invalid (healthy=false)", async () => {
    table = [row("a", READABLE, false)];
    expect(await countInvalidTokenUsers()).toBe(1);
  });

  it("counts a connected row whose value is unreadable and was never probed (healthy=null)", async () => {
    table = [row("a", UNREADABLE, null)];
    expect(await countInvalidTokenUsers()).toBe(1);
  });

  it("counts an unreadable row whose stale flag says healthy=true", async () => {
    table = [row("a", WRONG_KEY, true)];
    expect(await countInvalidTokenUsers()).toBe(1);
  });

  it("does not count readable rows (encrypted or legacy plaintext, healthy or never probed)", async () => {
    table = [row("a", READABLE, true), row("b", READABLE, null), row("c", TOKEN, null), row("d", TOKEN, true)];
    expect(await countInvalidTokenUsers()).toBe(0);
  });

  it("does not count rows that are not connected, whatever the stored value", async () => {
    table = [row("a", UNREADABLE, null, false), row("b", null, null)];
    expect(await countInvalidTokenUsers()).toBe(0);
  });

  it("does not count a row with no token column even when it has a connection time", async () => {
    table = [row("a", null, null, true)];
    expect(await countInvalidTokenUsers()).toBe(0);
  });

  it("does not count an unreadable row that has no connection time", async () => {
    table = [row("a", UNREADABLE, null, false)];
    expect(await countInvalidTokenUsers()).toBe(0);
  });

  it("does not count a healthy=false row without a token or without a connection time", async () => {
    table = [row("a", null, false, true), row("b", READABLE, false, false)];
    expect(await countInvalidTokenUsers()).toBe(0);
  });

  it("counts a row that is both healthy=false and unreadable once", async () => {
    table = [row("a", UNREADABLE, false)];
    expect(await countInvalidTokenUsers()).toBe(1);
  });

  it("adds both groups together", async () => {
    table = [
      row("a", READABLE, false),
      row("b", UNREADABLE, null),
      row("c", UNREADABLE, false),
      row("d", READABLE, true),
      row("e", WRONG_KEY, true),
    ];
    expect(await countInvalidTokenUsers()).toBe(4);
  });

  it("scans in id order across batches and finds an unreadable row on a later page", async () => {
    table = [
      row("a", READABLE, null),
      row("b", READABLE, null),
      row("c", UNREADABLE, null),
      row("d", READABLE, null),
      row("e", UNREADABLE, true),
    ];
    expect(await countInvalidTokenUsers(2)).toBe(2);
    // 5 candidate rows at 2 per page: pages of 2, 2 and 1.
    expect(prismaMocks.userFindMany).toHaveBeenCalledTimes(3);
  });

  describe("batch size", () => {
    const take = () => (prismaMocks.userFindMany.mock.calls[0]![0] as { take: number }).take;
    const sample = () => [row("a", READABLE, null), row("b", UNREADABLE, null), row("c", READABLE, null)];

    it("uses a valid size as given", async () => {
      table = sample();
      expect(await countInvalidTokenUsers(2)).toBe(1);
      expect(take()).toBe(2);
    });

    it("falls back to the default for 0 (no TypeError on an empty page)", async () => {
      table = sample();
      expect(await countInvalidTokenUsers(0)).toBe(1);
      expect(take()).toBe(INVALID_TOKEN_SCAN_BATCH_SIZE);
    });

    it("falls back to the default for a negative size", async () => {
      table = sample();
      expect(await countInvalidTokenUsers(-3)).toBe(1);
      expect(take()).toBe(INVALID_TOKEN_SCAN_BATCH_SIZE);
    });

    it("falls back to the default for a non-integer size", async () => {
      table = sample();
      expect(await countInvalidTokenUsers(2.5)).toBe(1);
      expect(take()).toBe(INVALID_TOKEN_SCAN_BATCH_SIZE);
    });

    it("falls back to the default for NaN", async () => {
      table = sample();
      expect(await countInvalidTokenUsers(Number.NaN)).toBe(1);
      expect(take()).toBe(INVALID_TOKEN_SCAN_BATCH_SIZE);
    });
  });

  it("selects only the id and the stored value, never a probe field", async () => {
    table = [row("a", READABLE, null)];
    await countInvalidTokenUsers();
    expect(prismaMocks.userFindMany.mock.calls[0]![0]).toMatchObject({
      orderBy: { id: "asc" },
      select: { id: true, githubAccessToken: true },
    });
  });
});
