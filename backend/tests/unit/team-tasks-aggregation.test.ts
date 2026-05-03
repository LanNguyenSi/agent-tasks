/**
 * Coverage for `GET /teams/:teamId/tasks` — the aggregation endpoint that
 * collapsed the home-page fan-out (one HTTP per project) into a single
 * server-resolved query. Mock-Prisma based; verifies project resolution,
 * filter translation, default + max limit, and the projects metadata
 * returned alongside the tasks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { AgentActor, HumanActor } from "../../src/types/auth.js";

const prismaMocks = vi.hoisted(() => ({
  taskFindMany: vi.fn(),
  projectFindMany: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: { findMany: prismaMocks.taskFindMany },
    project: { findMany: prismaMocks.projectFindMany },
  },
}));

const accessMocks = vi.hoisted(() => ({
  hasProjectAccess: vi.fn().mockResolvedValue(true),
  hasProjectRole: vi.fn().mockResolvedValue(true),
  isProjectAdmin: vi.fn().mockResolvedValue(true),
  resolveTeamId: vi.fn().mockResolvedValue({ ok: true, teamId: "team-A" }),
  resolveTeamIdErrorBody: vi.fn().mockReturnValue({ error: "x" }),
}));

vi.mock("../../src/services/team-access.js", () => accessMocks);

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/review-signal.js", () => ({
  emitReviewSignal: vi.fn().mockResolvedValue(undefined),
  emitChangesRequestedSignal: vi.fn().mockResolvedValue(undefined),
  emitTaskApprovedSignal: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/task-signal.js", () => ({
  emitTaskAvailableSignal: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/force-transition-signal.js", () => ({
  emitForceTransitionedSignal: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/self-merge-notice.js", () => ({
  emitSelfMergeNoticeIfApplicable: vi.fn().mockResolvedValue(0),
}));
vi.mock("../../src/services/grounding-client.js", () => ({
  getGroundingClient: () => ({
    start: vi.fn().mockResolvedValue(null),
    getLedgerSummary: vi.fn().mockResolvedValue({ entryCount: 0 }),
  }),
  RealGroundingClient: class {},
  NullGroundingClient: class {},
  __resetGroundingClientCacheForTests: () => {},
}));

import { taskRouter } from "../../src/routes/tasks.js";

const AGENT: AgentActor = {
  type: "agent",
  tokenId: "agent-tok",
  teamId: "team-A",
  scopes: ["tasks:read"],
  userId: "agent-owner",
};

const HUMAN: HumanActor = {
  type: "human",
  userId: "u-1",
};

function makeApp(actor: AgentActor | HumanActor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", taskRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  accessMocks.resolveTeamId.mockResolvedValue({ ok: true, teamId: "team-A" });
  prismaMocks.projectFindMany.mockResolvedValue([
    { id: "p-1", teamId: "team-A", name: "Owned", slug: "owned" },
    { id: "p-2", teamId: "team-A", name: "Owned 2", slug: "owned-2" },
  ]);
  prismaMocks.taskFindMany.mockResolvedValue([
    { id: "t-1", projectId: "p-1", title: "Task 1", status: "open", priority: "HIGH", labels: [], updatedAt: new Date() },
    { id: "t-2", projectId: "p-2", title: "Task 2", status: "review", priority: "LOW", labels: [], updatedAt: new Date() },
  ]);
});

describe("GET /teams/:teamId/tasks (aggregation)", () => {
  it("returns the union of tasks across team-accessible projects in one roundtrip", async () => {
    const res = await makeApp(HUMAN).request("/teams/team-A/tasks");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: { id: string }[]; projects: { id: string }[] };
    expect(body.tasks.map((t) => t.id).sort()).toEqual(["t-1", "t-2"]);
    expect(body.projects.map((p) => p.id).sort()).toEqual(["p-1", "p-2"]);
  });

  it("for humans, projectFindMany expands to OR(team-owned, projectMembers.some)", async () => {
    await makeApp(HUMAN).request("/teams/team-A/tasks");
    const where = prismaMocks.projectFindMany.mock.calls[0]![0]!.where;
    expect(where).toEqual({
      OR: [
        { teamId: "team-A" },
        { projectMembers: { some: { userId: "u-1" } } },
      ],
    });
  });

  it("for agents, projectFindMany stays team-only", async () => {
    await makeApp(AGENT).request("/teams/team-A/tasks");
    const where = prismaMocks.projectFindMany.mock.calls[0]![0]!.where;
    expect(where).toEqual({ teamId: "team-A" });
  });

  it("scopes the task query to projectId IN (resolvedProjectIds)", async () => {
    await makeApp(HUMAN).request("/teams/team-A/tasks");
    const where = prismaMocks.taskFindMany.mock.calls[0]![0]!.where;
    expect(where.projectId).toEqual({ in: ["p-1", "p-2"] });
  });

  it("translates ?status=open,in_progress into a status IN clause", async () => {
    await makeApp(HUMAN).request("/teams/team-A/tasks?status=open,in_progress");
    const where = prismaMocks.taskFindMany.mock.calls[0]![0]!.where;
    expect(where.status).toEqual({ in: ["open", "in_progress"] });
  });

  it("translates ?priority=HIGH,CRITICAL into a priority IN clause (case-normalised)", async () => {
    await makeApp(HUMAN).request("/teams/team-A/tasks?priority=high,critical");
    const where = prismaMocks.taskFindMany.mock.calls[0]![0]!.where;
    expect(where.priority).toEqual({ in: ["HIGH", "CRITICAL"] });
  });

  it("translates ?labels=foo,bar into a labels hasSome clause", async () => {
    await makeApp(HUMAN).request("/teams/team-A/tasks?labels=foo,bar");
    const where = prismaMocks.taskFindMany.mock.calls[0]![0]!.where;
    expect(where.labels).toEqual({ hasSome: ["foo", "bar"] });
  });

  it("defaults limit to 500 when not specified", async () => {
    await makeApp(HUMAN).request("/teams/team-A/tasks");
    const args = prismaMocks.taskFindMany.mock.calls[0]![0]!;
    expect(args.take).toBe(500);
  });

  it("respects ?limit=N up to a hard cap of 1000", async () => {
    await makeApp(HUMAN).request("/teams/team-A/tasks?limit=50");
    expect(prismaMocks.taskFindMany.mock.calls[0]![0]!.take).toBe(50);
    prismaMocks.taskFindMany.mockClear();
    await makeApp(HUMAN).request("/teams/team-A/tasks?limit=99999");
    expect(prismaMocks.taskFindMany.mock.calls[0]![0]!.take).toBe(1000);
  });

  it("returns empty arrays without hitting Task.findMany when the user has no projects", async () => {
    prismaMocks.projectFindMany.mockResolvedValueOnce([]);
    const res = await makeApp(HUMAN).request("/teams/team-A/tasks");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: unknown[]; projects: unknown[] };
    expect(body.tasks).toEqual([]);
    expect(body.projects).toEqual([]);
    expect(prismaMocks.taskFindMany).not.toHaveBeenCalled();
  });

  it("annotates shared projects with accessSource:'project' for humans", async () => {
    prismaMocks.projectFindMany.mockResolvedValueOnce([
      { id: "p-team", teamId: "team-A", name: "Owned", slug: "owned" },
      { id: "p-shared", teamId: "team-OTHER", name: "Shared", slug: "shared" },
    ]);
    const res = await makeApp(HUMAN).request("/teams/team-A/tasks");
    const body = (await res.json()) as { projects: Array<{ id: string; accessSource: string }> };
    expect(body.projects.find((p) => p.id === "p-team")?.accessSource).toBe("team");
    expect(body.projects.find((p) => p.id === "p-shared")?.accessSource).toBe("project");
  });

  it("propagates 403 from resolveTeamId when the actor cannot access the team", async () => {
    accessMocks.resolveTeamId.mockResolvedValueOnce({
      ok: false,
      status: 403,
      code: "forbidden",
      message: "Access denied",
    });
    accessMocks.resolveTeamIdErrorBody.mockReturnValueOnce({
      error: "forbidden",
      message: "Access denied",
    });
    const res = await makeApp(HUMAN).request("/teams/team-X/tasks");
    expect(res.status).toBe(403);
    expect(prismaMocks.projectFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.taskFindMany).not.toHaveBeenCalled();
  });

  it("orders tasks by updatedAt desc", async () => {
    await makeApp(HUMAN).request("/teams/team-A/tasks");
    const args = prismaMocks.taskFindMany.mock.calls[0]![0]!;
    expect(args.orderBy).toEqual({ updatedAt: "desc" });
  });
});
