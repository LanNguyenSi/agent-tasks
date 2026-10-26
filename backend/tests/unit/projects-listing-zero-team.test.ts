/**
 * End-to-end through the real `resolveTeamId` (only Prisma is mocked): a
 * human with no TeamMember row but ProjectMember grants lists exactly the
 * shared projects from GET /projects and GET /projects/available, while
 * every other caller of the shared resolver keeps its strict `no_teams`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const prismaMocks = vi.hoisted(() => ({
  projectFindMany: vi.fn(),
  teamMemberFindMany: vi.fn(),
  teamMemberFindUnique: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    project: { findMany: prismaMocks.projectFindMany, findUnique: vi.fn() },
    teamMember: {
      findUnique: prismaMocks.teamMemberFindUnique,
      findMany: prismaMocks.teamMemberFindMany,
    },
  },
}));

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/board-default.js", () => ({
  ensureDefaultBoardForProject: vi.fn().mockResolvedValue(undefined),
}));

import { projectRouter } from "../../src/routes/projects.js";
import { resolveTeamId } from "../../src/services/team-access.js";

const HUMAN: Actor = { type: "human", userId: "u-1" };
const AGENT: Actor = {
  type: "agent",
  tokenId: "tok-1",
  teamId: "team-A",
  scopes: [],
  userId: "agent-owner",
};

function makeApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", projectRouter);
  return app;
}

const row = (id: string, teamId: string) => ({
  id,
  teamId,
  name: id,
  slug: id,
  description: null,
  githubRepo: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.teamMemberFindMany.mockResolvedValue([]);
  prismaMocks.teamMemberFindUnique.mockResolvedValue(null);
  prismaMocks.projectFindMany.mockResolvedValue([]);
});

describe("zero-team human listing (real resolver)", () => {
  for (const path of ["/projects", "/projects/available"]) {
    it(`${path}: zero teams + shared projects -> 200 with accessSource project, grant-only query`, async () => {
      prismaMocks.projectFindMany.mockResolvedValue([row("p-1", "team-B"), row("p-2", "team-C")]);

      const res = await makeApp(HUMAN).request(path);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { projects: Array<{ id: string; accessSource: string }> };
      expect(body.projects).toHaveLength(2);
      expect(body.projects.every((p) => p.accessSource === "project")).toBe(true);
      const where = (prismaMocks.projectFindMany.mock.calls[0]?.[0] as { where: unknown }).where;
      expect(where).toEqual({ projectMembers: { some: { userId: "u-1" } } });
    });

    it(`${path}: zero teams + nothing shared -> 200 {projects: []}`, async () => {
      const res = await makeApp(HUMAN).request(path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ projects: [] });
    });

    it(`${path}: one team -> that team plus shared, team rows marked team`, async () => {
      prismaMocks.teamMemberFindMany.mockResolvedValue([{ teamId: "team-A" }]);
      prismaMocks.projectFindMany.mockResolvedValue([row("p-own", "team-A"), row("p-sh", "team-B")]);

      const res = await makeApp(HUMAN).request(path);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { projects: Array<{ id: string; accessSource: string }> };
      expect(body.projects.find((p) => p.id === "p-own")?.accessSource).toBe("team");
      expect(body.projects.find((p) => p.id === "p-sh")?.accessSource).toBe("project");
      const where = (prismaMocks.projectFindMany.mock.calls[0]?.[0] as { where: unknown }).where;
      expect(where).toEqual({
        OR: [{ teamId: "team-A" }, { projectMembers: { some: { userId: "u-1" } } }],
      });
    });

    it(`${path}: two teams and no teamId -> 400 multiple_teams with teamIds`, async () => {
      prismaMocks.teamMemberFindMany.mockResolvedValue([{ teamId: "team-A" }, { teamId: "team-B" }]);

      const res = await makeApp(HUMAN).request(path);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "multiple_teams", teamIds: ["team-A", "team-B"] });
      expect(prismaMocks.projectFindMany).not.toHaveBeenCalled();
    });

    it(`${path}: explicit teamId the human is not in -> 403, even with zero teams`, async () => {
      const res = await makeApp(HUMAN).request(`${path}?teamId=team-X`);
      expect(res.status).toBe(403);
      expect(prismaMocks.projectFindMany).not.toHaveBeenCalled();
    });

    it(`${path}: explicit teamId the human is in -> team plus shared`, async () => {
      prismaMocks.teamMemberFindUnique.mockResolvedValue({ teamId: "team-A" });

      const res = await makeApp(HUMAN).request(`${path}?teamId=team-A`);
      expect(res.status).toBe(200);
      const where = (prismaMocks.projectFindMany.mock.calls[0]?.[0] as { where: unknown }).where;
      expect(where).toEqual({
        OR: [{ teamId: "team-A" }, { projectMembers: { some: { userId: "u-1" } } }],
      });
    });

    it(`${path}: agent stays team-only and never reads memberships`, async () => {
      const res = await makeApp(AGENT).request(path);
      expect(res.status).toBe(200);
      const where = (prismaMocks.projectFindMany.mock.calls[0]?.[0] as { where: unknown }).where;
      expect(where).toEqual({ teamId: "team-A" });
      expect(prismaMocks.teamMemberFindMany).not.toHaveBeenCalled();
    });

    it(`${path}: agent with a foreign teamId -> 403`, async () => {
      const res = await makeApp(AGENT).request(`${path}?teamId=team-X`);
      expect(res.status).toBe(403);
    });
  }
});

describe("resolveTeamId keeps its strict contract for other routes", () => {
  it("a human with zero teams still resolves to no_teams", async () => {
    const r = await resolveTeamId(HUMAN, undefined);
    expect(r).toMatchObject({ ok: false, status: 400, code: "no_teams" });
  });
});
