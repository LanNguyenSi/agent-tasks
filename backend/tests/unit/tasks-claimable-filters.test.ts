/**
 * Filter and projection coverage for `GET /tasks/claimable` — the endpoint
 * the MCP `tasks_list` verb dispatches to. The suite is mock-Prisma based:
 * every test inspects the Prisma `where` argument to verify that query-string
 * params translate into the expected database query, and (for the projection
 * tests) that the right `select` vs `include` shape is used.
 *
 * Same `vi.hoisted` pattern as `tasks-v2-routes.test.ts` so we can stand the
 * router up on a throw-away Hono app without booting Prisma.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor, AgentActor, HumanActor } from "../../src/types/auth.js";

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
  resolveTeamId: vi
    .fn()
    .mockResolvedValue({ ok: true, teamId: "team-1" }),
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
};

const HUMAN: HumanActor = {
  type: "human",
  userId: "user-1",
  teamId: "team-1",
  role: "HUMAN_MEMBER",
};

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
  accessMocks.resolveTeamId.mockResolvedValue({ ok: true, teamId: "team-1" });
  prismaMocks.taskFindMany.mockResolvedValue([]);
});

function lastFindManyArgs() {
  const calls = prismaMocks.taskFindMany.mock.calls;
  if (calls.length === 0) {
    throw new Error("expected prisma.task.findMany to have been called");
  }
  return calls[calls.length - 1]![0] as {
    where: Record<string, unknown>;
    take: number;
    include?: Record<string, unknown>;
    select?: Record<string, unknown>;
    orderBy: unknown;
  };
}

describe("GET /tasks/claimable — defaults & projection", () => {
  it("defaults to limit 25, summary projection, and the legacy claimable filter", async () => {
    const res = await makeApp().request("/tasks/claimable");
    expect(res.status).toBe(200);

    const args = lastFindManyArgs();
    expect(args.take).toBe(25);
    expect(args.where).toMatchObject({
      status: "open",
      claimedByUserId: null,
      claimedByAgentId: null,
      project: { teamId: "team-1" },
    });
    // Summary projection: `select` only, no `include`. Description must NOT be
    // selected so the response stays inside the harness's tool-result token cap.
    expect(args.select).toBeDefined();
    expect(args.include).toBeUndefined();
    expect(args.select!.description).toBeUndefined();
    expect(args.select!.id).toBe(true);
    expect(args.select!.title).toBe(true);
    expect(args.select!.priority).toBe(true);
    expect(args.select!.labels).toBe(true);
    expect(args.select!.project).toEqual({
      select: { id: true, name: true, slug: true },
    });
  });

  it("verbose=true switches to the full include shape", async () => {
    const res = await makeApp().request("/tasks/claimable?verbose=true");
    expect(res.status).toBe(200);
    const args = lastFindManyArgs();
    expect(args.select).toBeUndefined();
    expect(args.include).toBeDefined();
    // Full include carries comments and attachments — the heavy fields the
    // summary projection deliberately omits.
    expect(args.include!.comments).toBeDefined();
    expect(args.include!.attachments).toBeDefined();
  });

  it("respects an explicit limit query param within bounds", async () => {
    await makeApp().request("/tasks/claimable?limit=7");
    expect(lastFindManyArgs().take).toBe(7);
  });

  it("falls back to the default 25 when limit is out of range or non-numeric", async () => {
    await makeApp().request("/tasks/claimable?limit=0");
    expect(lastFindManyArgs().take).toBe(25);
    await makeApp().request("/tasks/claimable?limit=999");
    expect(lastFindManyArgs().take).toBe(25);
    await makeApp().request("/tasks/claimable?limit=banana");
    expect(lastFindManyArgs().take).toBe(25);
  });
});

describe("GET /tasks/claimable — status filter", () => {
  it("single status replaces the default open + null-claim constraints", async () => {
    await makeApp().request("/tasks/claimable?status=in_progress");
    const where = lastFindManyArgs().where;
    expect(where.status).toBe("in_progress");
    // Implicit claim-null defaults must NOT be applied once an explicit
    // status is requested — otherwise in_progress tasks are unreachable.
    expect(where.claimedByUserId).toBeUndefined();
    expect(where.claimedByAgentId).toBeUndefined();
  });

  it("CSV status uses Prisma's { in: [...] } operator", async () => {
    await makeApp().request("/tasks/claimable?status=open,in_progress,review");
    const where = lastFindManyArgs().where;
    expect(where.status).toEqual({ in: ["open", "in_progress", "review"] });
  });

  it("rejects an unknown status value with 400", async () => {
    const res = await makeApp().request("/tasks/claimable?status=bogus");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toContain("invalid status");
    expect(prismaMocks.taskFindMany).not.toHaveBeenCalled();
  });
});

describe("GET /tasks/claimable — priority and labels", () => {
  it("single priority lands as a scalar where clause", async () => {
    await makeApp().request("/tasks/claimable?priority=HIGH");
    expect(lastFindManyArgs().where.priority).toBe("HIGH");
  });

  it("CSV priority lands as { in: [...] }", async () => {
    await makeApp().request("/tasks/claimable?priority=HIGH,CRITICAL");
    expect(lastFindManyArgs().where.priority).toEqual({
      in: ["HIGH", "CRITICAL"],
    });
  });

  it("rejects an unknown priority value with 400", async () => {
    const res = await makeApp().request("/tasks/claimable?priority=URGENT");
    expect(res.status).toBe(400);
  });

  it("labels CSV becomes a Prisma hasEvery filter (AND-match)", async () => {
    await makeApp().request("/tasks/claimable?labels=mcp,tooling");
    expect(lastFindManyArgs().where.labels).toEqual({
      hasEvery: ["mcp", "tooling"],
    });
  });
});

describe("GET /tasks/claimable — claimedByAgentId", () => {
  it('"me" resolves to the calling agent\'s tokenId and drops the claim-null defaults', async () => {
    await makeApp().request("/tasks/claimable?claimedByAgentId=me");
    const where = lastFindManyArgs().where;
    expect(where.claimedByAgentId).toBe("agent-token-1");
    expect(where.claimedByUserId).toBeUndefined();
    // Without an explicit status, all statuses are reachable (no implicit
    // open) — the explicit-search branch dropped the default.
    expect(where.status).toBeUndefined();
  });

  it('"me" rejects with 400 when the actor is a human', async () => {
    const res = await makeApp(HUMAN).request("/tasks/claimable?claimedByAgentId=me");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain('claimedByAgentId="me"');
  });

  it("explicit UUID is forwarded verbatim", async () => {
    const uuid = "11111111-2222-3333-4444-555555555555";
    await makeApp().request(`/tasks/claimable?claimedByAgentId=${uuid}`);
    expect(lastFindManyArgs().where.claimedByAgentId).toBe(uuid);
  });

  it("empty claimedByAgentId/status query params do not flip the explicit-search heuristic", async () => {
    // A stray `?claimedByAgentId=` or `?status=` from a misbehaving client
    // must NOT turn a plain claimable lookup into a "show me everything in
    // my team" query. Key on the parsed values, not on the raw presence of
    // the query string.
    await makeApp().request("/tasks/claimable?claimedByAgentId=&status=");
    const where = lastFindManyArgs().where;
    expect(where.status).toBe("open");
    expect(where.claimedByUserId).toBeNull();
    expect(where.claimedByAgentId).toBeNull();
  });
});

describe("GET /tasks/claimable — projectId and team scoping", () => {
  it("projectId filters by project and skips the team scoping", async () => {
    await makeApp().request(
      "/tasks/claimable?projectId=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
    const where = lastFindManyArgs().where;
    expect(where.projectId).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(where.project).toBeUndefined();
    expect(accessMocks.resolveTeamId).not.toHaveBeenCalled();
  });

  it("forbids the projectId path when project access check fails", async () => {
    accessMocks.hasProjectAccess.mockResolvedValueOnce(false);
    const res = await makeApp().request(
      "/tasks/claimable?projectId=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
    expect(res.status).toBe(403);
    expect(prismaMocks.taskFindMany).not.toHaveBeenCalled();
  });

  it("combined filters compose: status + priority + labels + claimedByAgentId=me", async () => {
    await makeApp().request(
      "/tasks/claimable?status=in_progress,review&priority=HIGH&labels=mcp,friction&claimedByAgentId=me",
    );
    const where = lastFindManyArgs().where;
    expect(where.status).toEqual({ in: ["in_progress", "review"] });
    expect(where.priority).toBe("HIGH");
    expect(where.labels).toEqual({ hasEvery: ["mcp", "friction"] });
    expect(where.claimedByAgentId).toBe("agent-token-1");
  });
});
