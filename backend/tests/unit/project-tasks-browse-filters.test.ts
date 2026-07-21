/**
 * Filter coverage for `GET /projects/:projectId/tasks` — the browse endpoint
 * the CLI `tasks list --project <slug>` and (future) MCP `project_tasks` verb
 * dispatch to. Mock-Prisma based: every test inspects the `where` / `take`
 * args to confirm query-string params translate into the expected database
 * query, mirroring `tasks-claimable-filters.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor, AgentActor } from "../../src/types/auth.js";

const prismaMocks = vi.hoisted(() => ({
  taskFindMany: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: {
      findMany: prismaMocks.taskFindMany,
    },
  },
}));

const accessMocks = vi.hoisted(() => ({
  hasProjectAccess: vi.fn().mockResolvedValue(true),
  hasProjectRole: vi.fn().mockResolvedValue(true),
  isProjectAdmin: vi.fn().mockResolvedValue(true),
  requireProjectWrite: vi.fn().mockResolvedValue(true),
  resolveTeamId: vi.fn().mockResolvedValue({ ok: true, teamId: "team-1" }),
  resolveTeamIdErrorBody: vi.fn(),
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
  tokenId: "agent-token-1",
  teamId: "team-1",
  scopes: ["tasks:read"],
  userId: "user-1",
};

const PROJECT_ID = "00000000-0000-0000-0000-000000000001";

function makeApp(actor: Actor = AGENT) {
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
  accessMocks.hasProjectAccess.mockResolvedValue(true);
  prismaMocks.taskFindMany.mockResolvedValue([]);
});

function lastFindManyArgs() {
  const calls = prismaMocks.taskFindMany.mock.calls;
  if (calls.length === 0) {
    throw new Error("expected prisma.task.findMany to have been called");
  }
  return calls[calls.length - 1]![0] as {
    where: Record<string, unknown>;
    take?: number;
    include?: Record<string, unknown>;
    orderBy: unknown;
    cursor?: { id: string };
    skip?: number;
  };
}

describe("GET /projects/:projectId/tasks — defaults", () => {
  it("returns unbounded (no take) and projectId-only where clause when no query params are passed", async () => {
    // The frontend dashboard hits this endpoint without query params and
    // expects every task in the project; a silent default cap would amount
    // to a backward-compat break. New browse callers (CLI, MCP) opt into
    // their own cap by passing `?limit=`.
    const res = await makeApp().request(`/projects/${PROJECT_ID}/tasks`);
    expect(res.status).toBe(200);

    const args = lastFindManyArgs();
    expect(args.take).toBeUndefined();
    expect(args.where).toEqual({ projectId: PROJECT_ID });
    // Default projection is the list include (no `select`).
    expect(args.include).toBeDefined();
  });

  it("denies access when hasProjectAccess returns false", async () => {
    accessMocks.hasProjectAccess.mockResolvedValueOnce(false);
    const res = await makeApp().request(`/projects/${PROJECT_ID}/tasks`);
    expect(res.status).toBe(403);
  });
});

describe("GET /projects/:projectId/tasks — status filter", () => {
  it("parses a CSV status list into a Prisma `in` clause", async () => {
    await makeApp().request(`/projects/${PROJECT_ID}/tasks?status=open,in_progress`);
    expect(lastFindManyArgs().where).toMatchObject({
      status: { in: ["open", "in_progress"] },
    });
  });

  it("rejects an unknown status with 400", async () => {
    const res = await makeApp().request(`/projects/${PROJECT_ID}/tasks?status=banana`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/Invalid status/);
  });

  it("ignores empty CSV segments", async () => {
    await makeApp().request(`/projects/${PROJECT_ID}/tasks?status=,open,,`);
    expect(lastFindManyArgs().where).toMatchObject({
      status: { in: ["open"] },
    });
  });
});

describe("GET /projects/:projectId/tasks — priority filter", () => {
  it("parses a CSV priority list into a Prisma `in` clause", async () => {
    await makeApp().request(`/projects/${PROJECT_ID}/tasks?priority=HIGH,CRITICAL`);
    expect(lastFindManyArgs().where).toMatchObject({
      priority: { in: ["HIGH", "CRITICAL"] },
    });
  });

  it("rejects an unknown priority with 400", async () => {
    const res = await makeApp().request(`/projects/${PROJECT_ID}/tasks?priority=urgent`);
    expect(res.status).toBe(400);
  });

  it("rejects lowercase priority — schema is uppercase-only", async () => {
    const res = await makeApp().request(`/projects/${PROJECT_ID}/tasks?priority=high`);
    expect(res.status).toBe(400);
  });
});

describe("GET /projects/:projectId/tasks — labels filter", () => {
  it("maps labels to a Prisma `hasSome` clause", async () => {
    await makeApp().request(`/projects/${PROJECT_ID}/tasks?labels=mcp,dx`);
    expect(lastFindManyArgs().where).toMatchObject({
      labels: { hasSome: ["mcp", "dx"] },
    });
  });
});

describe("GET /projects/:projectId/tasks — unclaimed filter", () => {
  it("adds null claim guards when unclaimed=true", async () => {
    await makeApp().request(`/projects/${PROJECT_ID}/tasks?unclaimed=true`);
    expect(lastFindManyArgs().where).toMatchObject({
      claimedByAgentId: null,
      claimedByUserId: null,
    });
  });

  it("does not add claim guards when unclaimed is omitted or anything other than 'true'", async () => {
    await makeApp().request(`/projects/${PROJECT_ID}/tasks?unclaimed=1`);
    const where = lastFindManyArgs().where;
    expect(where.claimedByAgentId).toBeUndefined();
    expect(where.claimedByUserId).toBeUndefined();
  });
});

describe("GET /projects/:projectId/tasks — limit clamping", () => {
  it("honors an explicit limit within bounds", async () => {
    await makeApp().request(`/projects/${PROJECT_ID}/tasks?limit=7`);
    expect(lastFindManyArgs().take).toBe(7);
  });

  it("clamps limit to the 500 ceiling", async () => {
    await makeApp().request(`/projects/${PROJECT_ID}/tasks?limit=9999`);
    expect(lastFindManyArgs().take).toBe(500);
  });

  it("rejects limit=0 with 400", async () => {
    const res = await makeApp().request(`/projects/${PROJECT_ID}/tasks?limit=0`);
    expect(res.status).toBe(400);
  });

  it("rejects non-numeric limit with 400", async () => {
    const res = await makeApp().request(`/projects/${PROJECT_ID}/tasks?limit=banana`);
    expect(res.status).toBe(400);
  });
});

describe("GET /projects/:projectId/tasks — externalRef filter (pre-existing behavior)", () => {
  it("filters by exact externalRef match", async () => {
    await makeApp().request(`/projects/${PROJECT_ID}/tasks?externalRef=my-key`);
    expect(lastFindManyArgs().where).toMatchObject({
      externalRef: "my-key",
    });
  });

  it("silently ignores externalRef longer than 255 chars", async () => {
    // Documented quirk preserved from the original implementation: prevents
    // unbounded string columns from hitting the DB. Worth pinning so we
    // notice if anyone tightens it to a 400.
    const tooLong = "a".repeat(256);
    await makeApp().request(`/projects/${PROJECT_ID}/tasks?externalRef=${tooLong}`);
    expect(lastFindManyArgs().where.externalRef).toBeUndefined();
  });
});

describe("GET /projects/:projectId/tasks — composite filters", () => {
  it("combines status, priority, labels, unclaimed, and limit into one query", async () => {
    await makeApp().request(
      `/projects/${PROJECT_ID}/tasks?status=open&priority=HIGH,CRITICAL&labels=mcp&unclaimed=true&limit=10`,
    );
    const args = lastFindManyArgs();
    expect(args.take).toBe(10);
    expect(args.where).toMatchObject({
      projectId: PROJECT_ID,
      status: { in: ["open"] },
      priority: { in: ["HIGH", "CRITICAL"] },
      labels: { hasSome: ["mcp"] },
      claimedByAgentId: null,
      claimedByUserId: null,
    });
  });
});

// ── Sort + cursor pagination (task 14c947a7) ────────────────────────────────
//
// This route already defaulted to `createdAt desc` (newest first) before
// this task; `sort` adds an explicit override (asc) and a compound
// `[createdAt, id]` orderBy for a stable tiebreaker. `cursor` + `nextCursor`
// add pagination so MCP `project_tasks` can page through more tasks than fit
// under the harness's tool-result token cap without raising `limit`.

describe("GET /projects/:projectId/tasks — sort", () => {
  it("defaults to descending createdAt+id order (unchanged, pre-existing behavior)", async () => {
    await makeApp().request(`/projects/${PROJECT_ID}/tasks`);
    expect(lastFindManyArgs().orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("sort=createdAt:asc reverses both the primary and tiebreaker direction", async () => {
    await makeApp().request(`/projects/${PROJECT_ID}/tasks?sort=createdAt:asc`);
    expect(lastFindManyArgs().orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
  });

  it("sort=createdAt:desc is accepted explicitly (same as the default)", async () => {
    await makeApp().request(`/projects/${PROJECT_ID}/tasks?sort=createdAt:desc`);
    expect(lastFindManyArgs().orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("rejects an unrecognized sort value with 400 and does not call Prisma", async () => {
    const res = await makeApp().request(`/projects/${PROJECT_ID}/tasks?sort=priority:desc`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toContain("createdAt:asc");
    expect(prismaMocks.taskFindMany).not.toHaveBeenCalled();
  });
});

describe("GET /projects/:projectId/tasks — cursor pagination", () => {
  it("omits cursor/skip from the Prisma call when no cursor is supplied", async () => {
    await makeApp().request(`/projects/${PROJECT_ID}/tasks`);
    const args = lastFindManyArgs();
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
  });

  it("forwards cursor as { id } with skip: 1 to exclude the cursor row itself", async () => {
    const cursorId = "33333333-3333-3333-3333-333333333333";
    await makeApp().request(`/projects/${PROJECT_ID}/tasks?cursor=${cursorId}`);
    const args = lastFindManyArgs();
    expect(args.cursor).toEqual({ id: cursorId });
    expect(args.skip).toBe(1);
  });
});

describe("GET /projects/:projectId/tasks — nextCursor", () => {
  it("returns the last row's id as nextCursor when a limited page comes back full", async () => {
    prismaMocks.taskFindMany.mockResolvedValueOnce([{ id: "task-1" }, { id: "task-2" }]);
    const res = await makeApp().request(`/projects/${PROJECT_ID}/tasks?limit=2`);
    const body = (await res.json()) as { nextCursor: string | null };
    expect(body.nextCursor).toBe("task-2");
  });

  it("returns null when a limited page comes back short of the limit (end of results)", async () => {
    prismaMocks.taskFindMany.mockResolvedValueOnce([{ id: "task-1" }]);
    const res = await makeApp().request(`/projects/${PROJECT_ID}/tasks?limit=5`);
    const body = (await res.json()) as { nextCursor: string | null };
    expect(body.nextCursor).toBeNull();
  });

  it("returns null when limit is omitted, even if many rows come back (already unbounded)", async () => {
    prismaMocks.taskFindMany.mockResolvedValueOnce([{ id: "task-1" }, { id: "task-2" }]);
    const res = await makeApp().request(`/projects/${PROJECT_ID}/tasks`);
    const body = (await res.json()) as { nextCursor: string | null };
    expect(body.nextCursor).toBeNull();
  });
});
