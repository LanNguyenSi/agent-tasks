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
  resolveTeamIdErrorBody: vi.fn(),
}));

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/board-default.js", () => ({
  ensureDefaultBoardForProject: vi.fn().mockResolvedValue(undefined),
}));

import { projectRouter } from "../../src/routes/projects.js";

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
