/**
 * Route tests for `GET /projects/:id/eligible-actors`: the project-scoped
 * candidate list for the admin claim reassignment.
 *
 * The prisma mock is a small in-memory store that evaluates the where shapes
 * the service produces (team scoping, the PROJECT_VIEWER exclusion, the
 * revoked and expiry filters), so excluding a row is observable rather than
 * assumed from a canned result.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const TEAM_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_TEAM_ID = "33333333-3333-3333-3333-333333333333";

type Where = Record<string, unknown>;

const store = vi.hoisted(() => ({
  projects: [] as Array<{ id: string; teamId: string }>,
  teamMembers: [] as Array<{ teamId: string; userId: string; role: string; user: { name: string | null; login: string } }>,
  projectMembers: [] as Array<{ projectId: string; userId: string; role: string; user: { name: string | null; login: string } }>,
  tokens: [] as Array<{ id: string; teamId: string; name: string; revokedAt: Date | null; expiresAt: Date | null }>,
}));

const prismaMocks = vi.hoisted(() => ({
  projectFindUnique: vi.fn(),
  teamMemberFindMany: vi.fn(),
  projectMemberFindMany: vi.fn(),
  agentTokenFindMany: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: prismaMocks.projectFindUnique },
    teamMember: { findMany: prismaMocks.teamMemberFindMany },
    projectMember: { findMany: prismaMocks.projectMemberFindMany },
    agentToken: { findMany: prismaMocks.agentTokenFindMany },
  },
}));

const accessMocks = vi.hoisted(() => ({
  isProjectAdmin: vi.fn(),
}));
vi.mock("../../src/services/team-access.js", () => ({
  isProjectAdmin: accessMocks.isProjectAdmin,
  hasProjectAccess: vi.fn().mockResolvedValue(true),
  hasProjectRole: vi.fn().mockResolvedValue(true),
  getProjectMembership: vi.fn(),
  resolveTeamId: vi.fn(),
  resolveTeamIdErrorBody: vi.fn(),
}));

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/board-default.js", () => ({
  ensureDefaultBoardForProject: vi.fn().mockResolvedValue(undefined),
}));

import { projectRouter } from "../../src/routes/projects.js";

const ADMIN: Actor = { type: "human", userId: "admin-1" };
const AGENT: Actor = { type: "agent", tokenId: "tok-1", teamId: TEAM_ID, userId: "owner", scopes: ["tasks:read"] };

function makeApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", projectRouter);
  return app;
}

const get = (actor: Actor, id = PROJECT_ID) => makeApp(actor).request(`/projects/${id}/eligible-actors`);

const named = (name: string | null, login: string) => ({ name, login });
const days = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

function seed() {
  store.projects = [{ id: PROJECT_ID, teamId: TEAM_ID }];
  store.teamMembers = [];
  store.projectMembers = [];
  store.tokens = [];
}

beforeEach(() => {
  seed();
  accessMocks.isProjectAdmin.mockReset();
  accessMocks.isProjectAdmin.mockResolvedValue(true);
  prismaMocks.projectFindUnique.mockReset();
  prismaMocks.projectFindUnique.mockImplementation(async ({ where }: { where: Where }) =>
    store.projects.find((p) => p.id === where.id) ?? null,
  );
  prismaMocks.teamMemberFindMany.mockReset();
  prismaMocks.teamMemberFindMany.mockImplementation(async ({ where }: { where: Where }) =>
    store.teamMembers.filter((m) => m.teamId === where.teamId),
  );
  prismaMocks.projectMemberFindMany.mockReset();
  prismaMocks.projectMemberFindMany.mockImplementation(async ({ where }: { where: { projectId: string; role: { not: string } } }) =>
    store.projectMembers.filter((m) => m.projectId === where.projectId && m.role !== where.role.not),
  );
  prismaMocks.agentTokenFindMany.mockReset();
  prismaMocks.agentTokenFindMany.mockImplementation(
    async ({ where }: { where: { teamId: string; revokedAt: null; OR: Array<{ expiresAt: null | { gt: Date } }> } }) =>
      store.tokens.filter(
        (t) =>
          t.teamId === where.teamId &&
          t.revokedAt === where.revokedAt &&
          where.OR.some((clause) => (clause.expiresAt === null ? t.expiresAt === null : t.expiresAt !== null && t.expiresAt > clause.expiresAt.gt)),
      ),
  );
});

describe("GET /projects/:id/eligible-actors: authorization", () => {
  it("403s an agent token caller and reads no member or token rows", async () => {
    const res = await get(AGENT);
    expect(res.status).toBe(403);
    expect(accessMocks.isProjectAdmin).not.toHaveBeenCalled();
    expect(prismaMocks.teamMemberFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.agentTokenFindMany).not.toHaveBeenCalled();
  });

  it("403s a non-admin human and reads no member or token rows", async () => {
    accessMocks.isProjectAdmin.mockResolvedValue(false);
    const res = await get({ type: "human", userId: "member-1" });
    expect(res.status).toBe(403);
    expect(accessMocks.isProjectAdmin).toHaveBeenCalledWith({ type: "human", userId: "member-1" }, PROJECT_ID);
    expect(prismaMocks.teamMemberFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.projectMemberFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.agentTokenFindMany).not.toHaveBeenCalled();
  });

  it("404s an unknown project", async () => {
    const res = await get(ADMIN, "99999999-9999-9999-9999-999999999999");
    expect(res.status).toBe(404);
    expect(prismaMocks.teamMemberFindMany).not.toHaveBeenCalled();
  });

  it("answers 200 to a project admin", async () => {
    const res = await get(ADMIN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ humans: [], agents: [] });
  });
});

describe("GET /projects/:id/eligible-actors: humans", () => {
  it("lists a project-only member with source project and the project role", async () => {
    store.projectMembers.push({ projectId: PROJECT_ID, userId: "u-proj", role: "PROJECT_CONTRIBUTOR", user: named("Pia Project", "pia") });
    const body = (await (await get(ADMIN)).json()) as { humans: unknown[] };
    expect(body.humans).toEqual([{ userId: "u-proj", name: "Pia Project", source: "project", role: "PROJECT_CONTRIBUTOR" }]);
  });

  it("lists a team member with source team and the team role, falling back to the login without a name", async () => {
    store.teamMembers.push({ teamId: TEAM_ID, userId: "u-team", role: "REVIEWER", user: named(null, "tessa") });
    const body = (await (await get(ADMIN)).json()) as { humans: unknown[] };
    expect(body.humans).toEqual([{ userId: "u-team", name: "tessa", source: "team", role: "REVIEWER" }]);
  });

  it("excludes PROJECT_VIEWER members (read-only tier) but keeps a viewer who is also a team member", async () => {
    store.projectMembers.push(
      { projectId: PROJECT_ID, userId: "u-viewer", role: "PROJECT_VIEWER", user: named("Vic Viewer", "vic") },
      { projectId: PROJECT_ID, userId: "u-both", role: "PROJECT_VIEWER", user: named("Bo Both", "bo") },
    );
    store.teamMembers.push({ teamId: TEAM_ID, userId: "u-both", role: "HUMAN_MEMBER", user: named("Bo Both", "bo") });
    const body = (await (await get(ADMIN)).json()) as { humans: Array<{ userId: string; source: string }> };
    expect(body.humans.map((h) => h.userId)).toEqual(["u-both"]);
    expect(body.humans[0]!.source).toBe("team");
  });

  it("dedupes a user present as team member and project member, reporting the team entry", async () => {
    store.teamMembers.push({ teamId: TEAM_ID, userId: "u-dup", role: "ADMIN", user: named("Dee Dup", "dee") });
    store.projectMembers.push({ projectId: PROJECT_ID, userId: "u-dup", role: "PROJECT_ADMIN", user: named("Dee Dup", "dee") });
    const body = (await (await get(ADMIN)).json()) as { humans: unknown[] };
    expect(body.humans).toEqual([{ userId: "u-dup", name: "Dee Dup", source: "team", role: "ADMIN" }]);
  });

  it("does not list members of another team or another project", async () => {
    store.teamMembers.push({ teamId: OTHER_TEAM_ID, userId: "u-foreign-team", role: "ADMIN", user: named("Fay", "fay") });
    store.projectMembers.push({ projectId: "other-project", userId: "u-foreign-proj", role: "PROJECT_ADMIN", user: named("Fox", "fox") });
    const body = (await (await get(ADMIN)).json()) as { humans: unknown[] };
    expect(body.humans).toEqual([]);
  });
});

describe("GET /projects/:id/eligible-actors: agents", () => {
  it("lists a live team token as { tokenId, name } and nothing else about it", async () => {
    store.tokens.push({ id: "tok-a", teamId: TEAM_ID, name: "ci-bot", revokedAt: null, expiresAt: null });
    const body = (await (await get(ADMIN)).json()) as { agents: unknown[] };
    expect(body.agents).toEqual([{ tokenId: "tok-a", name: "ci-bot" }]);
  });

  it("keeps a token whose expiry is still in the future", async () => {
    store.tokens.push({ id: "tok-future", teamId: TEAM_ID, name: "later", revokedAt: null, expiresAt: days(3) });
    const body = (await (await get(ADMIN)).json()) as { agents: Array<{ tokenId: string }> };
    expect(body.agents.map((a) => a.tokenId)).toEqual(["tok-future"]);
  });

  it("excludes revoked and expired tokens and tokens of another team", async () => {
    store.tokens.push(
      { id: "tok-live", teamId: TEAM_ID, name: "live", revokedAt: null, expiresAt: null },
      { id: "tok-revoked", teamId: TEAM_ID, name: "revoked", revokedAt: new Date(), expiresAt: null },
      { id: "tok-expired", teamId: TEAM_ID, name: "expired", revokedAt: null, expiresAt: days(-1) },
      { id: "tok-foreign", teamId: OTHER_TEAM_ID, name: "foreign", revokedAt: null, expiresAt: null },
    );
    const body = (await (await get(ADMIN)).json()) as { agents: Array<{ tokenId: string }> };
    expect(body.agents.map((a) => a.tokenId)).toEqual(["tok-live"]);
  });
});
