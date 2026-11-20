/**
 * POST /teams/:id/sync and the legacy webhook repo filter against a real
 * Postgres. Prisma compiles `{ equals, mode: "insensitive" }` to ILIKE without
 * escaping, so the unit suites (which never evaluate a filter) cannot show that
 * `my_repo` stops matching `my-repo`. Every case here runs the real SQL.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";
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
import { logAuditEvent } from "../../src/services/audit.js";
import { githubRepoEqualsInsensitive } from "../../src/lib/github-repo-match.js";

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
beforeAll(async () => {
  store = await groundingPostgres();
  db = store.db;
  shared.db = db;
}, 60000);
afterAll(async () => {
  if (store) await store.close();
});
beforeEach(() => {
  gh.listUserRepos.mockReset();
  vi.mocked(logAuditEvent).mockClear();
});

const repo = (full_name: string) => ({
  id: 1,
  name: full_name.split("/")[1]!,
  full_name,
  description: null,
  archived: false,
  disabled: false,
});

async function seedTeam(role: "ADMIN" | "HUMAN_MEMBER" | "REVIEWER" = "ADMIN") {
  const userId = randomUUID();
  await db.user.create({ data: { id: userId, login: `u-${userId}`, name: "u", githubAccessToken: "gho_x" } });
  const team = await db.team.create({ data: { name: `t-${userId}`, slug: `t-${userId}` } });
  await db.teamMember.create({ data: { teamId: team.id, userId, role } });
  return { userId, teamId: team.id };
}
/** A second member of an existing team, with its own GitHub token. */
async function seedMember(teamId: string, role: "ADMIN" | "HUMAN_MEMBER" | "REVIEWER") {
  const userId = randomUUID();
  await db.user.create({ data: { id: userId, login: `m-${userId}`, name: "m", githubAccessToken: "gho_m" } });
  await db.teamMember.create({ data: { teamId, userId, role } });
  return userId;
}
async function seedProject(teamId: string, githubRepo: string | null, createdAt?: Date) {
  const slug = randomUUID();
  return db.project.create({ data: { teamId, name: slug, slug, githubRepo, ...(createdAt ? { createdAt } : {}) } });
}
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
const rows = (teamId: string) =>
  db.project.findMany({ where: { teamId }, select: { id: true, githubRepo: true }, orderBy: { createdAt: "asc" } });

describe("POST /teams/:id/sync on real Postgres", () => {
  it("updates a mixed-case binding, normalises it, does not prune it and creates no duplicate", async () => {
    const { userId, teamId } = await seedTeam();
    const p = await seedProject(teamId, "lannguyensi/agent-tasks");
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/agent-tasks")]);

    const r = await sync(userId, teamId);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ created: 0, updated: 1, pruned: 0 });
    expect(await rows(teamId)).toEqual([{ id: p.id, githubRepo: "LanNguyenSi/agent-tasks" }]);
  });

  it("prunes an unlisted binding of the team and leaves unbound and other-team projects alone", async () => {
    const { userId, teamId } = await seedTeam();
    const other = await seedTeam();
    const keep = await seedProject(teamId, "LanNguyenSi/agent-tasks");
    await seedProject(teamId, "lannguyensi/retired");
    const unbound = await seedProject(teamId, null);
    const foreign = await seedProject(other.teamId, "lannguyensi/retired");
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/agent-tasks")]);

    const r = await sync(userId, teamId);

    expect(r.body).toMatchObject({ pruned: 1 });
    expect((await rows(teamId)).map((x) => x.id).sort()).toEqual([keep.id, unbound.id].sort());
    expect(await db.project.findUnique({ where: { id: foreign.id } })).not.toBeNull();
  });

  it("does not rebind acme/my-repo to acme/my_repo when both are listed", async () => {
    const { userId, teamId } = await seedTeam();
    const hyphen = await seedProject(teamId, "acme/my-repo");
    gh.listUserRepos.mockResolvedValue([repo("acme/my-repo"), repo("acme/my_repo")]);

    const r = await sync(userId, teamId);

    expect(r.body).toMatchObject({ created: 1, updated: 1, pruned: 0 });
    const after = await rows(teamId);
    expect(after.map((x) => x.githubRepo).sort()).toEqual(["acme/my-repo", "acme/my_repo"]);
    expect(after.find((x) => x.id === hyphen.id)!.githubRepo).toBe("acme/my-repo");
  });

  it("prunes a my_repo binding when only my-repo is listed (underscore is no wildcard in the DELETE)", async () => {
    const { userId, teamId } = await seedTeam();
    await seedProject(teamId, "acme/my-repo");
    await seedProject(teamId, "acme/my_repo");
    gh.listUserRepos.mockResolvedValue([repo("acme/my-repo")]);

    const r = await sync(userId, teamId);

    expect(r.body).toMatchObject({ pruned: 1 });
    expect((await rows(teamId)).map((x) => x.githubRepo)).toEqual(["acme/my-repo"]);
  });

  it("treats % in a listed name literally: it matches no other project", async () => {
    const { userId, teamId } = await seedTeam();
    const other = await seedProject(teamId, "acme/anything");
    gh.listUserRepos.mockResolvedValue([repo("acme/%")]);

    const r = await sync(userId, teamId);

    expect(r.body).toMatchObject({ created: 1, updated: 0, pruned: 1 });
    expect(await db.project.findUnique({ where: { id: other.id } })).toBeNull();
    expect((await rows(teamId)).map((x) => x.githubRepo)).toEqual(["acme/%"]);
  });

  it("prefers the exact-spelling row over an older differently-cased one", async () => {
    const { userId, teamId } = await seedTeam();
    const old = await seedProject(teamId, "lannguyensi/agent-tasks", new Date("2020-01-01"));
    const exact = await seedProject(teamId, "LanNguyenSi/agent-tasks", new Date("2021-01-01"));
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/agent-tasks")]);

    await sync(userId, teamId);

    const touched = await db.project.findMany({ where: { githubSyncAt: { not: null }, teamId }, select: { id: true } });
    expect(touched.map((x) => x.id)).toEqual([exact.id]);
    expect(old.id).not.toBe(exact.id);
  });

  it("picks the oldest row when two rows differ only in case and neither is exact", async () => {
    const { userId, teamId } = await seedTeam();
    const older = await seedProject(teamId, "lannguyensi/agent-tasks", new Date("2020-01-01"));
    await seedProject(teamId, "LANNGUYENSI/agent-tasks", new Date("2021-01-01"));
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/agent-tasks")]);

    await sync(userId, teamId);

    const touched = await db.project.findMany({ where: { githubSyncAt: { not: null }, teamId }, select: { id: true, githubRepo: true } });
    expect(touched).toEqual([{ id: older.id, githubRepo: "LanNguyenSi/agent-tasks" }]);
  });

  it("syncs an exact-spelling binding under an active fence without a skip", async () => {
    const { userId, teamId } = await seedTeam();
    await seedProject(teamId, "LanNguyenSi/fenced");
    const intentId = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO grounding_github_fence_intents (id, repo, kind, state) VALUES ('${intentId}', 'lannguyensi/fenced', 'MERGE', 'ACTIVE')`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO grounding_github_repository_fences (repo, version, "ownerId") VALUES ('lannguyensi/fenced', 1, '${intentId}') ON CONFLICT (repo) DO UPDATE SET "ownerId" = EXCLUDED."ownerId"`,
    );
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/fenced")]);

    const r = await sync(userId, teamId);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ updated: 1, fenced: 0 });
  });

  it("skips (not 500s) a repo whose case-normalising write hits an active fence and still syncs the rest", async () => {
    const { userId, teamId } = await seedTeam();
    await seedProject(teamId, "lannguyensi/fenced2");
    const intentId = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO grounding_github_fence_intents (id, repo, kind, state) VALUES ('${intentId}', 'lannguyensi/fenced2', 'MERGE', 'ACTIVE')`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO grounding_github_repository_fences (repo, version, "ownerId") VALUES ('lannguyensi/fenced2', 1, '${intentId}') ON CONFLICT (repo) DO UPDATE SET "ownerId" = EXCLUDED."ownerId"`,
    );
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/fenced2"), repo("LanNguyenSi/other2")]);

    const r = await sync(userId, teamId);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ created: 1, fenced: 1, pruned: 0 });
    expect((await rows(teamId)).map((x) => x.githubRepo).sort()).toEqual(["LanNguyenSi/other2", "lannguyensi/fenced2"]);
  });

  it("defers the whole prune (200, nothing removed) when a stale binding sits under an active fence, and a later sync prunes it", async () => {
    const { userId, teamId } = await seedTeam();
    const keep = await seedProject(teamId, "LanNguyenSi/keep3");
    const fencedStale = await seedProject(teamId, "lannguyensi/stale-fenced3");
    const freeStale = await seedProject(teamId, "lannguyensi/stale-free3");
    const intentId = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO grounding_github_fence_intents (id, repo, kind, state) VALUES ('${intentId}', 'lannguyensi/stale-fenced3', 'MERGE', 'ACTIVE')`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO grounding_github_repository_fences (repo, version, "ownerId") VALUES ('lannguyensi/stale-fenced3', 1, '${intentId}') ON CONFLICT (repo) DO UPDATE SET "ownerId" = EXCLUDED."ownerId"`,
    );
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/keep3")]);

    const r = await sync(userId, teamId);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ pruned: 0, pruneDeferred: true, skippedPrune: false });
    expect(String(r.body.message)).toContain("postponed");
    expect((await rows(teamId)).map((x) => x.id).sort()).toEqual([keep.id, fencedStale.id, freeStale.id].sort());

    await db.$executeRawUnsafe(`DELETE FROM grounding_github_repository_fences WHERE repo = 'lannguyensi/stale-fenced3'`);
    await db.$executeRawUnsafe(`UPDATE grounding_github_fence_intents SET state = 'DONE' WHERE id = '${intentId}'`);
    const again = await sync(userId, teamId);
    expect(again.body).toMatchObject({ pruned: 2, pruneDeferred: false });
    expect((await rows(teamId)).map((x) => x.id)).toEqual([keep.id]);
  });

  it("reports pruneDeferred false on a plain prune", async () => {
    const { userId, teamId } = await seedTeam();
    await seedProject(teamId, "lannguyensi/gone4");
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/here4")]);

    const r = await sync(userId, teamId);

    expect(r.body).toMatchObject({ created: 1, pruned: 1, pruneDeferred: false });
  });
});

describe("POST /teams/:id/sync prune is limited to team admins (real Postgres)", () => {
  for (const role of ["HUMAN_MEMBER", "REVIEWER"] as const) {
    it(`${role}: a stale binding keeps its project and its tasks, the response says why, no audit event`, async () => {
      const { teamId } = await seedTeam("ADMIN");
      const userId = await seedMember(teamId, role);
      const stale = await seedProject(teamId, "lannguyensi/retired-na");
      const task = await db.task.create({
        data: { projectId: stale.id, title: "kept", createdByUserId: userId },
      });
      gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/here-na")]);

      const r = await sync(userId, teamId);

      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        synced: 1,
        created: 1,
        updated: 0,
        pruned: 0,
        pruneDeferred: false,
        skippedPrune: false,
        pruneSkipped: "not_admin",
      });
      expect(String(r.body.message)).toContain("Stale projects are only removed by a team admin.");
      expect((await rows(teamId)).map((x) => x.githubRepo).sort()).toEqual(["LanNguyenSi/here-na", "lannguyensi/retired-na"]);
      expect(await db.project.findUnique({ where: { id: stale.id } })).not.toBeNull();
      expect(await db.task.findUnique({ where: { id: task.id } })).not.toBeNull();
      expect(logAuditEvent).not.toHaveBeenCalled();
    });
  }

  it("a non-admin still updates an existing binding (create and update branches unchanged)", async () => {
    const { teamId } = await seedTeam("ADMIN");
    const userId = await seedMember(teamId, "HUMAN_MEMBER");
    const bound = await seedProject(teamId, "lannguyensi/agent-tasks-na");
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/agent-tasks-na"), repo("LanNguyenSi/new-na")]);

    const r = await sync(userId, teamId);

    expect(r.body).toMatchObject({ created: 1, updated: 1, pruned: 0, pruneSkipped: "not_admin" });
    const after = await rows(teamId);
    expect(after.find((x) => x.id === bound.id)!.githubRepo).toBe("LanNguyenSi/agent-tasks-na");
    expect(after).toHaveLength(2);
  });

  it("a non-admin with an empty repository list gets both flags and loses nothing", async () => {
    const { teamId } = await seedTeam("ADMIN");
    const userId = await seedMember(teamId, "HUMAN_MEMBER");
    const stale = await seedProject(teamId, "lannguyensi/retired-empty");
    gh.listUserRepos.mockResolvedValue([]);

    const r = await sync(userId, teamId);

    expect(r.body).toMatchObject({ pruned: 0, skippedPrune: true, pruneSkipped: "not_admin", pruneDeferred: false });
    expect(String(r.body.message)).toBe(
      "GitHub sync returned 0 repositories; prune was skipped for safety. Stale projects are only removed by a team admin.",
    );
    expect(await db.project.findUnique({ where: { id: stale.id } })).not.toBeNull();
  });

  it("an admin with an empty repository list keeps skippedPrune and pruneSkipped null", async () => {
    const { userId, teamId } = await seedTeam("ADMIN");
    const stale = await seedProject(teamId, "lannguyensi/retired-empty-admin");
    gh.listUserRepos.mockResolvedValue([]);

    const r = await sync(userId, teamId);

    expect(r.body).toMatchObject({ pruned: 0, skippedPrune: true, pruneSkipped: null, pruneDeferred: false });
    expect(String(r.body.message)).toBe("GitHub sync returned 0 repositories; prune was skipped for safety.");
    expect(await db.project.findUnique({ where: { id: stale.id } })).not.toBeNull();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it("a non-admin does not reach a fenced stale binding: no deferral, 200, nothing removed", async () => {
    const { teamId } = await seedTeam("ADMIN");
    const userId = await seedMember(teamId, "REVIEWER");
    const fencedStale = await seedProject(teamId, "lannguyensi/stale-fenced-na");
    const intentId = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO grounding_github_fence_intents (id, repo, kind, state) VALUES ('${intentId}', 'lannguyensi/stale-fenced-na', 'MERGE', 'ACTIVE')`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO grounding_github_repository_fences (repo, version, "ownerId") VALUES ('lannguyensi/stale-fenced-na', 1, '${intentId}') ON CONFLICT (repo) DO UPDATE SET "ownerId" = EXCLUDED."ownerId"`,
    );
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/keep-na")]);

    const r = await sync(userId, teamId);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ pruned: 0, pruneDeferred: false, pruneSkipped: "not_admin" });
    expect(await db.project.findUnique({ where: { id: fencedStale.id } })).not.toBeNull();
  });

  it("an admin removes the stale projects and the audit event names the team, the actor and every deleted id", async () => {
    const { teamId } = await seedTeam("ADMIN");
    const userId = await seedMember(teamId, "ADMIN");
    const keep = await seedProject(teamId, "LanNguyenSi/keep-adm");
    const goneA = await seedProject(teamId, "lannguyensi/gone-adm-a");
    const goneB = await seedProject(teamId, "lannguyensi/gone-adm-b");
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/keep-adm")]);

    const r = await sync(userId, teamId);

    expect(r.body).toMatchObject({ pruned: 2, pruneSkipped: null, pruneDeferred: false, skippedPrune: false });
    expect(String(r.body.message)).not.toContain("team admin");
    expect((await rows(teamId)).map((x) => x.id)).toEqual([keep.id]);
    expect(logAuditEvent).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(logAuditEvent).mock.calls[0]![0];
    expect(arg).toMatchObject({
      action: "project.synced",
      actorId: userId,
      payload: { teamId, via: "team_sync_prune", deletedCount: 2 },
    });
    expect([...(arg.payload as { projectIds: string[] }).projectIds].sort()).toEqual([goneA.id, goneB.id].sort());
  });

  it("an admin with nothing stale emits no audit event", async () => {
    const { userId, teamId } = await seedTeam("ADMIN");
    await seedProject(teamId, "LanNguyenSi/all-here");
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/all-here")]);

    const r = await sync(userId, teamId);

    expect(r.body).toMatchObject({ pruned: 0, pruneSkipped: null });
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it("an admin whose prune is deferred by a fence emits no audit event", async () => {
    const { userId, teamId } = await seedTeam("ADMIN");
    await seedProject(teamId, "lannguyensi/stale-fenced-adm");
    const intentId = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO grounding_github_fence_intents (id, repo, kind, state) VALUES ('${intentId}', 'lannguyensi/stale-fenced-adm', 'MERGE', 'ACTIVE')`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO grounding_github_repository_fences (repo, version, "ownerId") VALUES ('lannguyensi/stale-fenced-adm', 1, '${intentId}') ON CONFLICT (repo) DO UPDATE SET "ownerId" = EXCLUDED."ownerId"`,
    );
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/keep-fenced-adm")]);

    const r = await sync(userId, teamId);

    expect(r.body).toMatchObject({ pruned: 0, pruneDeferred: true, pruneSkipped: null });
    expect(logAuditEvent).not.toHaveBeenCalled();
  });
});

describe("githubRepoEqualsInsensitive (the legacy webhook project filter) on real Postgres", () => {
  const select = (name: string) =>
    db.project.findMany({ where: { githubRepo: githubRepoEqualsInsensitive(name) }, select: { id: true } });

  it("a delivery for acme/my_repo does not select a project bound to acme/my-repo", async () => {
    const { teamId } = await seedTeam();
    const tag = randomUUID().slice(0, 8);
    const hyphen = await seedProject(teamId, `acme-${tag}/my-repo`);
    const under = await seedProject(teamId, `acme-${tag}/my_repo`);

    expect((await select(`acme-${tag}/my_repo`)).map((x) => x.id)).toEqual([under.id]);
    expect((await select(`acme-${tag}/my-repo`)).map((x) => x.id)).toEqual([hyphen.id]);
  });

  it("a % in the delivery name selects nothing extra", async () => {
    const { teamId } = await seedTeam();
    const tag = randomUUID().slice(0, 8);
    await seedProject(teamId, `acme-${tag}/anything`);

    expect(await select(`acme-${tag}/%`)).toEqual([]);
  });

  it("mixed case still selects the project", async () => {
    const { teamId } = await seedTeam();
    const tag = randomUUID().slice(0, 8);
    const p = await seedProject(teamId, `Acme-${tag}/My_Repo`);

    expect((await select(`acme-${tag}/my_repo`)).map((x) => x.id)).toEqual([p.id]);
  });
});
