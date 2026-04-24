/**
 * Integration tests for the effective-gates discovery surface.
 *
 * Covers the two customer-facing endpoints that expose the registry:
 *   - `GET /api/projects/:id` now returns `{ project, effectiveGates }`
 *   - `GET /api/projects/:id/effective-gates` returns just `{ effectiveGates }`
 *
 * These are the endpoints backing the `projects_get` / `projects_get_effective_gates`
 * MCP verbs. The backend test alone is the canonical check — the MCP surfaces
 * simply relay, so if this passes the verb surface is wired correctly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";
import { GovernanceMode } from "../../src/lib/governance-mode.js";
import { GateCode } from "../../src/services/gates/index.js";

const prismaMocks = vi.hoisted(() => ({
  projectFindUnique: vi.fn(),
  teamMemberFindUnique: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: prismaMocks.projectFindUnique },
    teamMember: { findUnique: prismaMocks.teamMemberFindUnique },
  },
}));

vi.mock("../../src/services/team-access.js", () => ({
  isProjectAdmin: vi.fn().mockResolvedValue(true),
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

const HUMAN_ACTOR: Actor = {
  type: "human",
  userId: "u1",
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

const PROJECT_ID = "00000000-0000-0000-0000-000000000001";

const BASE_PROJECT = {
  id: PROJECT_ID,
  teamId: "team-1",
  name: "Test",
  slug: "test",
  description: null,
  githubRepo: "LanNguyenSi/agent-tasks",
  confidenceThreshold: 60,
  taskTemplate: null,
  soloMode: false,
  requireDistinctReviewer: false,
  governanceMode: null,
  githubSyncAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.teamMemberFindUnique.mockResolvedValue({
    id: "tm-1",
    teamId: "team-1",
    userId: "u1",
    role: "HUMAN_MEMBER",
  });
});

describe("GET /api/projects/:id returns effectiveGates", () => {
  it("attaches the gate map next to the project payload", async () => {
    prismaMocks.projectFindUnique.mockResolvedValue({
      ...BASE_PROJECT,
      governanceMode: GovernanceMode.REQUIRES_DISTINCT_REVIEWER,
    });

    const res = await makeApp(HUMAN_ACTOR).request(`/projects/${PROJECT_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      project: { id: string };
      effectiveGates: Record<string, { active: boolean; because: string }>;
    };

    expect(body.project.id).toBe(PROJECT_ID);
    expect(body.effectiveGates).toBeDefined();
    expect(body.effectiveGates[GateCode.DistinctReviewer].active).toBe(true);
    expect(body.effectiveGates[GateCode.PrRepoMatchesProject].active).toBe(
      true,
    );
    expect(body.effectiveGates[GateCode.TaskStatusForMerge].active).toBe(true);
  });

  it("reflects governance mode — AUTONOMOUS disables the reviewer gates", async () => {
    prismaMocks.projectFindUnique.mockResolvedValue({
      ...BASE_PROJECT,
      governanceMode: GovernanceMode.AUTONOMOUS,
    });

    const res = await makeApp(HUMAN_ACTOR).request(`/projects/${PROJECT_ID}`);
    const body = (await res.json()) as {
      effectiveGates: Record<string, { active: boolean }>;
    };
    expect(body.effectiveGates[GateCode.DistinctReviewer].active).toBe(false);
    expect(body.effectiveGates[GateCode.SelfMerge].active).toBe(false);
    // Task-status is always on; pr-repo stays on (repo is bound).
    expect(body.effectiveGates[GateCode.TaskStatusForMerge].active).toBe(true);
    expect(body.effectiveGates[GateCode.PrRepoMatchesProject].active).toBe(
      true,
    );
  });
});

describe("GET /api/projects/:id/effective-gates", () => {
  it("returns just the gate map, no project payload", async () => {
    prismaMocks.projectFindUnique.mockResolvedValue({
      teamId: "team-1",
      githubRepo: "owner/repo",
      governanceMode: GovernanceMode.REQUIRES_DISTINCT_REVIEWER,
      soloMode: false,
      requireDistinctReviewer: true,
    });

    const res = await makeApp(HUMAN_ACTOR).request(
      `/projects/${PROJECT_ID}/effective-gates`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      effectiveGates: Record<
        string,
        {
          code: string;
          name: string;
          active: boolean;
          because: string;
          appliesTo: string[];
        }
      >;
      project?: unknown;
    };

    expect(body.project).toBeUndefined();
    expect(Object.keys(body.effectiveGates).sort()).toEqual(
      [
        GateCode.DistinctReviewer,
        GateCode.SelfMerge,
        GateCode.TaskStatusForMerge,
        GateCode.PrRepoMatchesProject,
      ].sort(),
    );

    const distinct = body.effectiveGates[GateCode.DistinctReviewer];
    expect(distinct.active).toBe(true);
    expect(distinct.code).toBe(GateCode.DistinctReviewer);
    expect(distinct.name).toMatch(/review/i);
    expect(distinct.appliesTo).toContain("task_finish");
    expect(distinct.because).toMatch(/REQUIRES_DISTINCT_REVIEWER/);
  });

  it("404s when the project is missing", async () => {
    prismaMocks.projectFindUnique.mockResolvedValue(
      null,
    );
    const res = await makeApp(HUMAN_ACTOR).request(
      `/projects/${PROJECT_ID}/effective-gates`,
    );
    expect(res.status).toBe(404);
  });

  it("403s when the actor is not a team member", async () => {
    prismaMocks.projectFindUnique.mockResolvedValue({
      teamId: "team-1",
      githubRepo: null,
      governanceMode: GovernanceMode.AUTONOMOUS,
      soloMode: true,
      requireDistinctReviewer: false,
    });
    prismaMocks.teamMemberFindUnique.mockResolvedValue(
      null,
    );

    const res = await makeApp(HUMAN_ACTOR).request(
      `/projects/${PROJECT_ID}/effective-gates`,
    );
    expect(res.status).toBe(403);
  });

  it("accepts an agent actor whose teamId matches, without hitting teamMember", async () => {
    // Agent actors skip the DB lookup — assertMembership compares
    // actor.teamId to project.teamId directly. Verify this path still
    // works for the new endpoint.
    prismaMocks.projectFindUnique.mockResolvedValue({
      teamId: "team-1",
      githubRepo: null,
      governanceMode: GovernanceMode.AUTONOMOUS,
      soloMode: true,
      requireDistinctReviewer: false,
    });

    const agent: Actor = {
      type: "agent",
      tokenId: "agent-1",
      teamId: "team-1",
      scopes: [],
    };
    const res = await makeApp(agent).request(
      `/projects/${PROJECT_ID}/effective-gates`,
    );
    expect(res.status).toBe(200);
    expect(prismaMocks.teamMemberFindUnique).not.toHaveBeenCalled();
  });

  it("403s an agent actor whose teamId does NOT match the project", async () => {
    prismaMocks.projectFindUnique.mockResolvedValue({
      teamId: "team-1",
      githubRepo: null,
      governanceMode: GovernanceMode.AUTONOMOUS,
      soloMode: true,
      requireDistinctReviewer: false,
    });

    const wrongTeamAgent: Actor = {
      type: "agent",
      tokenId: "agent-1",
      teamId: "team-other",
      scopes: [],
    };
    const res = await makeApp(wrongTeamAgent).request(
      `/projects/${PROJECT_ID}/effective-gates`,
    );
    expect(res.status).toBe(403);
  });
});
