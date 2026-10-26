/**
 * Verifies that GET /projects expands the listing for humans to include
 * projects shared via per-project invite, and that each row carries an
 * accessSource marker. Agents stay team-only by design — their per-
 * project access is exercised via specific project IDs, not through
 * this listing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const prismaMocks = vi.hoisted(() => ({
  projectFindMany: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    project: { findMany: prismaMocks.projectFindMany, findUnique: vi.fn() },
    teamMember: { findUnique: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock("../../src/services/team-access.js", () => ({
  isProjectAdmin: vi.fn(),
  hasProjectAccess: vi.fn(),
  getProjectMembership: vi.fn(),
  resolveTeamId: vi.fn().mockResolvedValue({ ok: true, teamId: "team-A" }),
  resolveTeamIdErrorBody: vi.fn((r: { code: string; message: string; teamIds?: string[] }) => ({
    error: r.code,
    message: r.message,
    ...(r.teamIds ? { teamIds: r.teamIds } : {}),
  })),
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /projects (listing with sharing)", () => {
  it("for humans, returns team projects + shared projects, marked by accessSource", async () => {
    prismaMocks.projectFindMany.mockResolvedValue([
      { id: "p-team", teamId: "team-A", name: "Owned", slug: "owned", createdAt: new Date(), updatedAt: new Date() },
      { id: "p-shared", teamId: "team-B", name: "Shared", slug: "shared", createdAt: new Date(), updatedAt: new Date() },
    ]);

    const res = await makeApp(HUMAN).request("/projects?teamId=team-A");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: Array<{ id: string; accessSource: string }> };

    expect(body.projects).toHaveLength(2);
    const ownedRow = body.projects.find((p) => p.id === "p-team");
    const sharedRow = body.projects.find((p) => p.id === "p-shared");
    expect(ownedRow?.accessSource).toBe("team");
    expect(sharedRow?.accessSource).toBe("project");

    // Verify the OR clause is present in the query.
    const callArgs = prismaMocks.projectFindMany.mock.calls[0]?.[0] as {
      where: { OR?: unknown[]; teamId?: string };
    };
    expect(callArgs.where.OR).toBeDefined();
  });

  it("for agents, scopes to team only and marks accessSource: team", async () => {
    prismaMocks.projectFindMany.mockResolvedValue([
      { id: "p-team", teamId: "team-A", name: "Owned", slug: "owned", createdAt: new Date(), updatedAt: new Date() },
    ]);

    const res = await makeApp(AGENT).request("/projects?teamId=team-A");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: Array<{ accessSource: string }> };
    expect(body.projects[0]?.accessSource).toBe("team");

    // Agents must use the simple teamId filter, no OR expansion.
    const callArgs = prismaMocks.projectFindMany.mock.calls[0]?.[0] as {
      where: { OR?: unknown[]; teamId?: string };
    };
    expect(callArgs.where.OR).toBeUndefined();
    expect(callArgs.where.teamId).toBe("team-A");
  });

  // findMany here has no `select`, so
  // the raw project row — including enforcementMode — reaches the response
  // unfiltered. Pins the wire shape directly; a `select` added to this
  // query (mirroring GET /projects/available's) would drop the key
  // silently while leaving tsc and the rest of the suite green.
  it("carries enforcementMode on each listed project (no select drops it)", async () => {
    prismaMocks.projectFindMany.mockResolvedValue([
      {
        id: "p-team",
        teamId: "team-A",
        name: "Owned",
        slug: "owned",
        enforcementMode: "BLOCK",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await makeApp(HUMAN).request("/projects?teamId=team-A");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      projects: Array<{ enforcementMode: string }>;
    };
    expect(body.projects[0]?.enforcementMode).toBe("BLOCK");
  });
});

describe("GET /projects/available (listing with sharing)", () => {
  it("for humans, returns team projects + shared projects with accessSource", async () => {
    prismaMocks.projectFindMany.mockResolvedValue([
      {
        id: "p-team",
        teamId: "team-A",
        name: "Owned",
        slug: "owned",
        description: null,
        githubRepo: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "p-shared",
        teamId: "team-B",
        name: "Shared",
        slug: "shared",
        description: null,
        githubRepo: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await makeApp(HUMAN).request("/projects/available?teamId=team-A");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      projects: Array<{ id: string; accessSource: string; displayName: string }>;
    };
    const owned = body.projects.find((p) => p.id === "p-team");
    const shared = body.projects.find((p) => p.id === "p-shared");
    expect(owned?.accessSource).toBe("team");
    expect(shared?.accessSource).toBe("project");
    expect(owned?.displayName).toBe("Owned (owned)");
  });
});

// Humans with zero team memberships but a per-project grant get the shared
// projects instead of `400 no_teams`. The shared resolver keeps returning
// `no_teams`; only the two list handlers translate it for humans.
describe("GET /projects and /projects/available for a human with zero teams", () => {
  const NO_TEAMS = {
    ok: false,
    status: 400,
    code: "no_teams",
    message: "User is not a member of any team",
  } as const;
  const shared = (id: string) => ({
    id,
    teamId: "team-B",
    name: id,
    slug: id,
    description: null,
    githubRepo: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  beforeEach(() => {
    vi.mocked(resolveTeamId).mockReset();
    vi.mocked(resolveTeamId).mockResolvedValue({ ok: true, teamId: "team-A" });
  });

  for (const path of ["/projects", "/projects/available"]) {
    it(`${path}: returns exactly the shared projects with accessSource "project"`, async () => {
      vi.mocked(resolveTeamId).mockResolvedValueOnce(NO_TEAMS);
      prismaMocks.projectFindMany.mockResolvedValue([shared("p-1"), shared("p-2")]);

      const res = await makeApp(HUMAN).request(path);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { projects: Array<{ id: string; accessSource: string }> };
      expect(body.projects.map((p) => p.id)).toEqual(["p-1", "p-2"]);
      expect(body.projects.every((p) => p.accessSource === "project")).toBe(true);
    });

    it(`${path}: query is restricted to the user's own project grants (no team projects)`, async () => {
      vi.mocked(resolveTeamId).mockResolvedValueOnce(NO_TEAMS);
      prismaMocks.projectFindMany.mockResolvedValue([]);

      await makeApp(HUMAN).request(path);
      const callArgs = prismaMocks.projectFindMany.mock.calls[0]?.[0] as { where: unknown };
      // Exactly the grant filter: no OR with a team branch, no teamId key.
      expect(callArgs.where).toEqual({ projectMembers: { some: { userId: "u-1" } } });
    });

    it(`${path}: zero teams and zero shared projects is 200 with an empty list`, async () => {
      vi.mocked(resolveTeamId).mockResolvedValueOnce(NO_TEAMS);
      prismaMocks.projectFindMany.mockResolvedValue([]);

      const res = await makeApp(HUMAN).request(path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ projects: [] });
    });

    it(`${path}: a human with several teams and no teamId still gets 400 multiple_teams`, async () => {
      vi.mocked(resolveTeamId).mockResolvedValueOnce({
        ok: false,
        status: 400,
        code: "multiple_teams",
        message: "User is a member of multiple teams; specify teamId query parameter",
        teamIds: ["team-A", "team-B"],
      });

      const res = await makeApp(HUMAN).request(path);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "multiple_teams", teamIds: ["team-A", "team-B"] });
      expect(prismaMocks.projectFindMany).not.toHaveBeenCalled();
    });

    it(`${path}: an explicit teamId the human is not in is still 403`, async () => {
      vi.mocked(resolveTeamId).mockResolvedValueOnce({
        ok: false,
        status: 403,
        code: "forbidden",
        message: "Access denied to this team",
      });

      const res = await makeApp(HUMAN).request(`${path}?teamId=team-X`);
      expect(res.status).toBe(403);
      expect(prismaMocks.projectFindMany).not.toHaveBeenCalled();
    });

    it(`${path}: an agent never takes the zero-team path`, async () => {
      vi.mocked(resolveTeamId).mockResolvedValueOnce(NO_TEAMS);

      const res = await makeApp(AGENT).request(path);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "no_teams" });
      expect(prismaMocks.projectFindMany).not.toHaveBeenCalled();
    });
  }

  it("a human with one team still gets that team plus shared projects", async () => {
    prismaMocks.projectFindMany.mockResolvedValue([]);

    await makeApp(HUMAN).request("/projects");
    const callArgs = prismaMocks.projectFindMany.mock.calls[0]?.[0] as { where: unknown };
    expect(callArgs.where).toEqual({
      OR: [{ teamId: "team-A" }, { projectMembers: { some: { userId: "u-1" } } }],
    });
  });
});
