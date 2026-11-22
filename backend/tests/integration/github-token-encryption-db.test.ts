/**
 * GitHub OAuth tokens encrypted at rest, against a real Postgres: what a login
 * writes, what the read seams return, the lazy rewrite of legacy plaintext, the
 * start-up sweep, and the unreadable-value path. Raw rows are read with
 * `$queryRaw`, so a test sees the column and not Prisma's view of it.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor, AgentActor } from "../../src/types/auth.js";
import type { AppVariables } from "../../src/types/hono.js";
import { groundingPostgres } from "../helpers/grounding-postgres.js";

const shared = vi.hoisted(() => ({ db: undefined as PrismaClient | undefined }));
const gh = vi.hoisted(() => ({ listUserRepos: vi.fn() }));
vi.mock("../../src/lib/prisma.js", () => ({
  prisma: new Proxy(
    {},
    {
      get: (_t, key) => {
        const v = Reflect.get(shared.db!, key);
        return typeof v === "function" ? v.bind(shared.db) : v;
      },
    },
  ),
}));
vi.mock("../../src/services/github-sync.js", () => ({ listUserRepos: gh.listUserRepos }));
vi.mock("../../src/services/audit.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/audit.js")>()),
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import { teamRouter } from "../../src/routes/teams.js";
import { findDelegationUser } from "../../src/services/github-delegation.js";
import { countInvalidTokenUsers, getTokenHealth } from "../../src/services/github-health.js";
import { GroundingGithubCreateService } from "../../src/services/grounding-github-create.js";
import {
  decryptGithubToken,
  encryptGithubToken,
  isEncryptedGithubToken,
  sweepLegacyGithubTokens,
} from "../../src/services/github-token-crypto.js";
import { connectGitHubToExistingUser, upsertUserFromGitHub } from "../../src/services/user.js";

const TOKEN = "gho_realisticLookingToken0123456789";

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
beforeAll(async () => {
  store = await groundingPostgres();
  // A pool larger than one, so a statement the code under test sends on the
  // shared client does not queue behind a transaction a test holds open.
  db = store.connect(5);
  shared.db = db;
}, 60000);
afterAll(async () => {
  if (store) await store.close();
});
beforeEach(() => {
  gh.listUserRepos.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function rawToken(userId: string): Promise<string | null> {
  const rows = await db.$queryRaw<{ token: string | null }[]>`SELECT "githubAccessToken" AS token FROM users WHERE id = ${userId}`;
  return rows[0]!.token;
}
async function seedUser(token: string | null, extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  await db.user.create({
    data: { id, login: `u-${id}`, githubAccessToken: token, githubConnectedAt: token ? new Date() : null, allowAgentPrCreate: true, ...extra },
  });
  return id;
}
async function seedTeam(members: { userId: string; role?: "ADMIN" | "HUMAN_MEMBER" }[]) {
  const id = randomUUID();
  await db.team.create({ data: { id, name: `t-${id}`, slug: `t-${id}` } });
  for (const m of members) await db.teamMember.create({ data: { teamId: id, userId: m.userId, role: m.role ?? "ADMIN" } });
  return id;
}
const githubUser = (id: number, login = `gh-${id}`) => ({ id, login, name: "Name", avatar_url: "https://example.test/a.png", email: null });

describe("writes store ciphertext", () => {
  it("a first login creates the user with an encrypted token that does not contain the token", async () => {
    const user = await upsertUserFromGitHub(githubUser(910001), TOKEN);
    const raw = await rawToken(user.id);
    expect(raw).not.toBeNull();
    expect(raw!.startsWith("v1:")).toBe(true);
    expect(raw).not.toContain(TOKEN);
    expect(decryptGithubToken(raw)).toBe(TOKEN);
  });

  it("a repeat login for the same GitHub id replaces the token with a new ciphertext", async () => {
    const first = await upsertUserFromGitHub(githubUser(910002), TOKEN);
    const rawFirst = await rawToken(first.id);
    const second = await upsertUserFromGitHub(githubUser(910002), "gho_second");
    expect(second.id).toBe(first.id);
    const rawSecond = await rawToken(first.id);
    expect(rawSecond!.startsWith("v1:")).toBe(true);
    expect(rawSecond).not.toBe(rawFirst);
    expect(rawSecond).not.toContain("gho_second");
    expect(decryptGithubToken(rawSecond)).toBe("gho_second");
  });

  it("a login that matches an existing user by email encrypts the token", async () => {
    const id = randomUUID();
    const email = `${id}@example.test`;
    await db.user.create({ data: { id, login: `u-${id}`, email } });
    const user = await upsertUserFromGitHub({ ...githubUser(910003), email }, TOKEN);
    expect(user.id).toBe(id);
    const raw = await rawToken(id);
    expect(raw!.startsWith("v1:")).toBe(true);
    expect(raw).not.toContain(TOKEN);
  });

  it("connecting GitHub to an existing user encrypts the token", async () => {
    const id = await seedUser(null);
    await connectGitHubToExistingUser(id, githubUser(910004), TOKEN);
    const raw = await rawToken(id);
    expect(raw!.startsWith("v1:")).toBe(true);
    expect(raw).not.toContain(TOKEN);
    expect(decryptGithubToken(raw)).toBe(TOKEN);
  });
});

describe("findDelegationUser", () => {
  it("returns the decrypted token of an encrypted row and leaves the row as it is", async () => {
    const stored = encryptGithubToken(TOKEN);
    const userId = await seedUser(stored);
    const teamId = await seedTeam([{ userId }]);
    const result = await findDelegationUser(teamId, "allowAgentPrCreate", { preferUserId: userId });
    expect(result).toEqual({ userId, login: `u-${userId}`, githubAccessToken: TOKEN });
    expect(await rawToken(userId)).toBe(stored);
  });

  it("uses a legacy plaintext token as it is and rewrites the row encrypted (preferred user)", async () => {
    const userId = await seedUser(TOKEN);
    const teamId = await seedTeam([{ userId }]);
    const result = await findDelegationUser(teamId, "allowAgentPrCreate", { preferUserId: userId });
    expect(result?.githubAccessToken).toBe(TOKEN);
    const raw = await rawToken(userId);
    expect(raw!.startsWith("v1:")).toBe(true);
    expect(raw).not.toContain(TOKEN);
    expect(decryptGithubToken(raw)).toBe(TOKEN);
    // a second read returns the same token and keeps the ciphertext stable
    const again = await findDelegationUser(teamId, "allowAgentPrCreate", { preferUserId: userId });
    expect(again?.githubAccessToken).toBe(TOKEN);
    expect(await rawToken(userId)).toBe(raw);
  });

  it("rewrites a legacy plaintext row picked through the team pool", async () => {
    const userId = await seedUser(TOKEN);
    const teamId = await seedTeam([{ userId }]);
    const result = await findDelegationUser(teamId, "allowAgentPrCreate");
    expect(result?.githubAccessToken).toBe(TOKEN);
    expect(isEncryptedGithubToken((await rawToken(userId))!)).toBe(true);
  });

  it("does not rewrite when the caller reads inside its own transaction", async () => {
    const userId = await seedUser(TOKEN);
    const teamId = await seedTeam([{ userId }]);
    const result = await db.$transaction((tx) => findDelegationUser(teamId, "allowAgentPrCreate", { preferUserId: userId, db: tx }));
    expect(result?.githubAccessToken).toBe(TOKEN);
    expect(await rawToken(userId)).toBe(TOKEN);
  });

  it("returns null for a row encrypted under another key (unreadable counts as not connected)", async () => {
    const userId = await seedUser(encryptGithubToken(TOKEN, { GITHUB_TOKEN_ENCRYPTION_KEY: "some-other-key-0123456789abcdef" }));
    const teamId = await seedTeam([{ userId }]);
    expect(await findDelegationUser(teamId, "allowAgentPrCreate", { preferUserId: userId })).toBeNull();
    expect(await findDelegationUser(teamId, "allowAgentPrCreate")).toBeNull();
  });

  it("returns null for a tampered ciphertext and leaves the row untouched", async () => {
    const stored = encryptGithubToken(TOKEN);
    const tampered = `${stored.slice(0, -2)}${stored.endsWith("AA") ? "BB" : "AA"}`;
    const userId = await seedUser(tampered);
    const teamId = await seedTeam([{ userId }]);
    expect(await findDelegationUser(teamId, "allowAgentPrCreate", { preferUserId: userId })).toBeNull();
    expect(await rawToken(userId)).toBe(tampered);
  });

  it("falls through to a teammate with a readable token when the preferred user's is unreadable", async () => {
    const broken = await seedUser("v1:not:a:token");
    const goodToken = "gho_teammate";
    const good = await seedUser(encryptGithubToken(goodToken));
    const teamId = await seedTeam([{ userId: broken }, { userId: good }]);
    const result = await findDelegationUser(teamId, "allowAgentPrCreate", { preferUserId: broken });
    expect(result).toMatchObject({ userId: good, githubAccessToken: goodToken });
  });
});

describe("getTokenHealth", () => {
  function stubProbe(status = 200) {
    const fetchMock = vi.fn(async (_url: string, _init?: { headers?: Record<string, string> }) => new Response("{}", { status }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("probes GitHub with the decrypted token", async () => {
    const fetchMock = stubProbe(200);
    const userId = await seedUser(encryptGithubToken(TOKEN));
    expect((await getTokenHealth(userId)).state).toBe("healthy");
    expect(fetchMock.mock.calls[0]![1]!.headers!.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("probes with a legacy plaintext token and rewrites the row encrypted", async () => {
    const fetchMock = stubProbe(200);
    const userId = await seedUser(TOKEN);
    expect((await getTokenHealth(userId)).state).toBe("healthy");
    expect(fetchMock.mock.calls[0]![1]!.headers!.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(isEncryptedGithubToken((await rawToken(userId))!)).toBe(true);
  });

  it("reports not_connected without a probe or a write for an unreadable value", async () => {
    const fetchMock = stubProbe(200);
    const userId = await seedUser(encryptGithubToken(TOKEN, { GITHUB_TOKEN_ENCRYPTION_KEY: "some-other-key-0123456789abcdef" }));
    expect(await getTokenHealth(userId)).toEqual({ state: "not_connected", lastCheckedAt: null });
    expect(fetchMock).not.toHaveBeenCalled();
    const row = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { githubTokenHealthy: true, githubTokenLastCheckedAt: true } });
    expect(row).toEqual({ githubTokenHealthy: null, githubTokenLastCheckedAt: null });
  });

  it("reports not_connected for a tampered value", async () => {
    const fetchMock = stubProbe(200);
    const stored = encryptGithubToken(TOKEN);
    const userId = await seedUser(`${stored.slice(0, -2)}${stored.endsWith("AA") ? "BB" : "AA"}`);
    expect((await getTokenHealth(userId)).state).toBe("not_connected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports not_connected for a user without a token", async () => {
    const userId = await seedUser(null);
    expect((await getTokenHealth(userId)).state).toBe("not_connected");
  });
});

describe("countInvalidTokenUsers", () => {
  it("counts a probed-invalid row and a connected unreadable row, not a readable one", async () => {
    const before = await countInvalidTokenUsers();
    await seedUser(encryptGithubToken(TOKEN), { githubTokenHealthy: false });
    await seedUser(encryptGithubToken(TOKEN, { GITHUB_TOKEN_ENCRYPTION_KEY: "some-other-key-0123456789abcdef" }));
    await seedUser(encryptGithubToken(TOKEN, { GITHUB_TOKEN_ENCRYPTION_KEY: "some-other-key-0123456789abcdef" }), { githubTokenHealthy: false });
    await seedUser(encryptGithubToken(TOKEN), { githubTokenHealthy: true });
    await seedUser(TOKEN);
    await seedUser(null);
    expect((await countInvalidTokenUsers()) - before).toBe(3);
  });
});

describe("POST /teams/:id/sync", () => {
  async function sync(userId: string, teamId: string) {
    const app = new Hono<{ Variables: AppVariables }>();
    const actor: Actor = { type: "human", userId };
    app.use("*", async (c, next) => {
      c.set("actor", actor);
      await next();
    });
    app.route("/", teamRouter);
    const res = await app.request(`/teams/${teamId}/sync`, { method: "POST" });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("lists repositories with the decrypted token", async () => {
    gh.listUserRepos.mockResolvedValue([]);
    const userId = await seedUser(encryptGithubToken(TOKEN));
    const teamId = await seedTeam([{ userId }]);
    const r = await sync(userId, teamId);
    expect(r.status).toBe(200);
    expect(gh.listUserRepos).toHaveBeenCalledWith(TOKEN);
  });

  it("refuses with the connect hint when the stored value is unreadable", async () => {
    const userId = await seedUser(encryptGithubToken(TOKEN, { GITHUB_TOKEN_ENCRYPTION_KEY: "some-other-key-0123456789abcdef" }));
    const teamId = await seedTeam([{ userId }]);
    const r = await sync(userId, teamId);
    expect(r.status).toBe(403);
    expect(gh.listUserRepos).not.toHaveBeenCalled();
  });

  it("uses a legacy plaintext token and rewrites it encrypted", async () => {
    gh.listUserRepos.mockResolvedValue([]);
    const userId = await seedUser(TOKEN);
    const teamId = await seedTeam([{ userId }]);
    expect((await sync(userId, teamId)).status).toBe(200);
    expect(gh.listUserRepos).toHaveBeenCalledWith(TOKEN);
    expect(isEncryptedGithubToken((await rawToken(userId))!)).toBe(true);
  });
});

describe("sweepLegacyGithubTokens", () => {
  it("encrypts plaintext rows, skips encrypted ones, leaves the rest, and is idempotent", async () => {
    const plainA = await seedUser("gho_sweep_a");
    const plainB = await seedUser("gho_sweep_b");
    const encryptedValue = encryptGithubToken("gho_sweep_c");
    const encrypted = await seedUser(encryptedValue);
    const unreadableValue = "v1:not:a:token";
    const unreadable = await seedUser(unreadableValue);
    const empty = await seedUser("");
    const none = await seedUser(null);

    // other tests in this schema leave plaintext rows too; the sweep must take every one
    const [{ n: plaintextBefore }] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM users WHERE "githubAccessToken" IS NOT NULL AND "githubAccessToken" <> '' AND "githubAccessToken" NOT LIKE 'v1:%'`;
    expect(plaintextBefore).toBeGreaterThanOrEqual(2n);
    const first = await sweepLegacyGithubTokens(db);
    expect(first).toEqual({ skipped: false, rewritten: Number(plaintextBefore), failed: 0 });
    const [{ n: plaintextAfter }] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM users WHERE "githubAccessToken" IS NOT NULL AND "githubAccessToken" <> '' AND "githubAccessToken" NOT LIKE 'v1:%'`;
    expect(plaintextAfter).toBe(0n);

    expect(decryptGithubToken(await rawToken(plainA))).toBe("gho_sweep_a");
    expect(decryptGithubToken(await rawToken(plainB))).toBe("gho_sweep_b");
    expect((await rawToken(plainA))!.startsWith("v1:")).toBe(true);
    expect(await rawToken(encrypted)).toBe(encryptedValue);
    expect(await rawToken(unreadable)).toBe(unreadableValue);
    expect(await rawToken(empty)).toBe("");
    expect(await rawToken(none)).toBeNull();

    const snapshot = await db.$queryRaw<{ id: string; token: string | null }[]>`SELECT id, "githubAccessToken" AS token FROM users ORDER BY id`;
    const second = await sweepLegacyGithubTokens(db);
    expect(second).toEqual({ skipped: false, rewritten: 0, failed: 0 });
    expect(await db.$queryRaw`SELECT id, "githubAccessToken" AS token FROM users ORDER BY id`).toEqual(snapshot);
  });

  it("covers more rows than one batch", async () => {
    const ids = [] as string[];
    for (let i = 0; i < 5; i++) ids.push(await seedUser(`gho_batch_${i}`));
    const result = await sweepLegacyGithubTokens(db, undefined, 2);
    expect(result.failed).toBe(0);
    for (const [i, id] of ids.entries()) expect(decryptGithubToken(await rawToken(id))).toBe(`gho_batch_${i}`);
    expect((await sweepLegacyGithubTokens(db)).rewritten).toBe(0);
  });

  it("never overwrites a token a reconnect wrote in between (compare-and-swap)", async () => {
    const userId = await seedUser("gho_old");
    const racing = {
      user: {
        findMany: db.user.findMany.bind(db.user),
        updateMany: async (args: Parameters<PrismaClient["user"]["updateMany"]>[0]) => {
          // the reconnect lands after the sweep read the plaintext row
          await db.user.update({ where: { id: userId }, data: { githubAccessToken: encryptGithubToken("gho_reconnected") } });
          return db.user.updateMany(args);
        },
      },
    } as unknown as Parameters<typeof sweepLegacyGithubTokens>[0];
    await sweepLegacyGithubTokens(racing);
    expect(decryptGithubToken(await rawToken(userId))).toBe("gho_reconnected");
  });
});

describe("grounding PR create reads the delegate's token through the decrypt seam", () => {
  async function createFixture(storedToken: string) {
    const userId = randomUUID();
    const teamId = randomUUID();
    const tokenId = randomUUID();
    const projectId = randomUUID();
    const taskId = randomUUID();
    const repo = randomUUID();
    const actor: AgentActor = { type: "agent", tokenId, userId, teamId, scopes: ["tasks:update", "github:pr_create"] };
    await db.user.create({ data: { id: userId, login: userId, githubAccessToken: storedToken, githubConnectedAt: new Date(), allowAgentPrCreate: true } });
    await db.team.create({ data: { id: teamId, name: "Create", slug: teamId } });
    await db.teamMember.create({ data: { teamId, userId, role: "ADMIN" } });
    await db.agentToken.create({ data: { id: tokenId, teamId, createdById: userId, name: "Create", tokenHash: tokenId, scopes: actor.scopes } });
    await db.project.create({ data: { id: projectId, teamId, name: "Create", slug: projectId, githubRepo: `acme/${repo}` } });
    await db.task.create({ data: { id: taskId, projectId, title: "Create", status: "in_progress", claimedByAgentId: tokenId, claimedAt: new Date(), branchName: "old" } });
    const request = { owner: "acme", repo, head: "work/feature", base: "main", title: "Create PR", body: "Body" };
    const create = vi.fn(async (_request: unknown, _token: string, _operationId: string): Promise<never> => {
      throw new Error("uncertain");
    });
    const read = vi.fn();
    const service = new GroundingGithubCreateService({ db, provider: { create, read } as never });
    return { actor, taskId, request, create, service, userId };
  }

  it("hands the provider the decrypted token of an encrypted row", async () => {
    const f = await createFixture(encryptGithubToken(TOKEN));
    const result = await f.service.createOrResume(f.taskId, f.actor, "k1", f.request);
    expect(result.status).toBe(202);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.create.mock.calls[0]![1]).toBe(TOKEN);
  });

  it("hands the provider a legacy plaintext token as it is", async () => {
    const f = await createFixture(TOKEN);
    await f.service.createOrResume(f.taskId, f.actor, "k2", f.request);
    expect(f.create.mock.calls[0]![1]).toBe(TOKEN);
  });

  it("a resumed operation refuses when its recorded delegate's token has become unreadable", async () => {
    const f = await createFixture(encryptGithubToken(TOKEN));
    expect((await f.service.createOrResume(f.taskId, f.actor, "k4", f.request)).status).toBe(202);
    await db.user.update({ where: { id: f.userId }, data: { githubAccessToken: encryptGithubToken(TOKEN, { GITHUB_TOKEN_ENCRYPTION_KEY: "some-other-key-0123456789abcdef" }) } });
    await expect(f.service.createOrResume(f.taskId, f.actor, "k4", f.request)).rejects.toMatchObject({ code: "forbidden", status: 403 });
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it("refuses, with no remote call, when the stored value is unreadable", async () => {
    const f = await createFixture(encryptGithubToken(TOKEN, { GITHUB_TOKEN_ENCRYPTION_KEY: "some-other-key-0123456789abcdef" }));
    await expect(f.service.createOrResume(f.taskId, f.actor, "k3", f.request)).rejects.toMatchObject({ code: "forbidden", status: 403 });
    expect(f.create).not.toHaveBeenCalled();
  });
});
