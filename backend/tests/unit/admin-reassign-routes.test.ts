/**
 * Route tests for `POST /tasks/:id/admin-reassign` -- the human-project-admin
 * escape hatch that hands a work or review claim from its current holder
 * straight to a chosen eligible human or agent, without touching task.status.
 *
 * Mirrors the mock preamble of admin-release-routes.test.ts, with two
 * differences that matter for an authorization change: the grounding wrapper
 * mock runs `revalidate` before `mutate` (so the in-transaction re-check is
 * exercised), and `updateMany` is a small in-memory row matcher for the CAS
 * tests, so a write whose where is not pinned to the observed holder really
 * changes the outcome instead of hiding behind a canned `{ count }`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";
import { GroundingAccessError } from "../../src/services/grounding-context.js";

const prismaMocks = vi.hoisted(() => ({
  taskFindUnique: vi.fn(),
  taskFindFirst: vi.fn(),
  taskUpdateMany: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: {
      findUnique: prismaMocks.taskFindUnique,
      findFirst: prismaMocks.taskFindFirst,
      updateMany: prismaMocks.taskUpdateMany,
    },
  },
}));

const accessMocks = vi.hoisted(() => ({
  hasProjectAccess: vi.fn(),
  hasProjectRole: vi.fn(),
  isProjectAdmin: vi.fn(),
  requireProjectWrite: vi.fn(),
}));
vi.mock("../../src/services/team-access.js", () => accessMocks);

const eligibleMocks = vi.hoisted(() => ({ listEligibleActors: vi.fn() }));
vi.mock("../../src/services/eligible-actors.js", () => eligibleMocks);

const logAuditEventMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: logAuditEventMock,
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
vi.mock("../../src/services/github-merge.js", () => ({
  performPrMerge: vi.fn(),
}));
vi.mock("../../src/services/github-delegation.js", () => ({
  findDelegationUser: vi.fn().mockResolvedValue(null),
}));

const groundingMocks = vi.hoisted(() => ({
  mutateRuns: vi.fn(),
  /** When set, the row the wrapper hands to `revalidate` and `mutate` (a row that moved after the route loaded it). */
  locked: { value: null as Record<string, unknown> | null },
}));
vi.mock("../../src/services/grounding-route-context.js", () => ({
  // Runs the route's `revalidate` and then `mutate` against the task the
  // route loaded first, like the real wrapper does under its lock.
  mutateGroundingRouteContext: async (_client: unknown, input: {
    projectId: string;
    reason: string;
    revalidate: (db: unknown, task: unknown) => Promise<void>;
    mutate: (db: unknown, task: unknown) => Promise<{ value: unknown; changed: boolean }>;
  }) => {
    const task = groundingMocks.locked.value ?? ((await prismaMocks.taskFindUnique.mock.results[0]!.value) as Record<string, unknown>);
    groundingMocks.mutateRuns(input.reason);
    const db = { task: { updateMany: prismaMocks.taskUpdateMany, findFirst: prismaMocks.taskFindFirst } };
    await input.revalidate(db, task);
    return input.mutate(db, task);
  },
  presentGroundingRouteContext: async (_client: unknown, input: { present: (task: never, context: { mode: "UNPROVISIONED" }) => Promise<unknown> }) => ({
    task: {} as never,
    context: { mode: "UNPROVISIONED" },
    value: await input.present({} as never, { mode: "UNPROVISIONED" }),
  }),
  buildExternalGroundingHint: (taskId: string) => ({ taskId, kind: "external_grounding_v1" }),
  selectGroundingRouteContext: vi.fn().mockResolvedValue({ mode: "UNPROVISIONED" }),
}));

vi.mock("../../src/config/index.js", () => ({
  config: {
    NODE_ENV: "test",
    SESSION_SECRET: "test-session-secret-must-be-32chars!!",
    GITHUB_CLIENT_ID: "test-id",
    GITHUB_CLIENT_SECRET: "test-secret",
    FRONTEND_URL: "http://localhost:3000",
    CORS_ORIGINS: "http://localhost:3000",
    PORT: 3001,
    DATABASE_URL: "postgresql://test:test@localhost/test",
  },
}));

import { taskRouter } from "../../src/routes/tasks.js";

function makeApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", taskRouter);
  return app;
}

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const TASK_ID = "00000000-0000-0000-0000-000000000001";

const ADMIN: Actor = { type: "human", userId: "admin-1" };
const NON_ADMIN: Actor = { type: "human", userId: "user-2" };
const AGENT: Actor = {
  type: "agent",
  tokenId: "agent-tok-1",
  teamId: "team-1",
  userId: "agent-owner",
  scopes: ["tasks:claim", "tasks:transition"],
};

const OPEN_PROJECT = { id: PROJECT_ID, governanceMode: null, soloMode: false, requireDistinctReviewer: false };
const DISTINCT_PROJECT = { ...OPEN_PROJECT, requireDistinctReviewer: true };

const baseTask = {
  id: TASK_ID,
  projectId: PROJECT_ID,
  title: "Stuck task",
  status: "in_progress",
  claimedByUserId: null as string | null,
  claimedByAgentId: null as string | null,
  claimedAt: null as Date | null,
  reviewClaimedByUserId: null as string | null,
  reviewClaimedByAgentId: null as string | null,
  reviewClaimedAt: null as Date | null,
  project: OPEN_PROJECT,
  attachments: [],
  comments: [],
  claimedByUser: null,
  claimedByAgent: null,
  blockedBy: [],
  blocks: [],
};

const ELIGIBLE = {
  humans: [
    { userId: "user-2", name: "Two", source: "team", role: "HUMAN_MEMBER" },
    { userId: "user-3", name: "Three", source: "project", role: "PROJECT_CONTRIBUTOR" },
    { userId: "admin-1", name: "Admin", source: "team", role: "ADMIN" },
  ],
  agents: [
    { tokenId: "agent-new", name: "New agent" },
    { tokenId: "agent-77", name: "Old agent" },
  ],
};

function postReassign(actor: Actor, body: Record<string, unknown>) {
  return makeApp(actor).request(`/tasks/${TASK_ID}/admin-reassign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The row `updateMany` matches against; `null` columns are absent holders. */
type Row = Record<"claimedByUserId" | "claimedByAgentId" | "reviewClaimedByUserId" | "reviewClaimedByAgentId", string | null>;
const HOLDER_COLUMNS = ["claimedByUserId", "claimedByAgentId", "reviewClaimedByUserId", "reviewClaimedByAgentId"] as const;

/**
 * An `updateMany` that behaves like the database for the where shapes the
 * route produces: every holder column the where names must equal the row's
 * current value, otherwise nothing matches. The merge-reservation fragment is
 * ignored (the integration suites cover it against Postgres).
 */
function rowMatchingUpdateMany(row: Row) {
  prismaMocks.taskUpdateMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    const matches = HOLDER_COLUMNS.every((column) => !(column in where) || where[column] === row[column]);
    return { count: matches ? 1 : 0 };
  });
}

const fresh = (task: Record<string, unknown>) => ({ ...baseTask, ...task });

beforeEach(() => {
  for (const mock of [
    prismaMocks.taskFindUnique,
    prismaMocks.taskFindFirst,
    prismaMocks.taskUpdateMany,
    accessMocks.hasProjectAccess,
    accessMocks.hasProjectRole,
    accessMocks.isProjectAdmin,
    accessMocks.requireProjectWrite,
    eligibleMocks.listEligibleActors,
    logAuditEventMock,
    groundingMocks.mutateRuns,
  ]) {
    mock.mockReset();
  }
  groundingMocks.locked.value = null;
  accessMocks.hasProjectAccess.mockResolvedValue(true);
  accessMocks.hasProjectRole.mockResolvedValue(true);
  accessMocks.isProjectAdmin.mockResolvedValue(true);
  accessMocks.requireProjectWrite.mockResolvedValue(true);
  eligibleMocks.listEligibleActors.mockResolvedValue(ELIGIBLE);
  prismaMocks.taskUpdateMany.mockResolvedValue({ count: 1 });
  prismaMocks.taskFindFirst.mockResolvedValue(null);
  logAuditEventMock.mockResolvedValue(undefined);
});

describe("POST /tasks/:id/admin-reassign: authorization", () => {
  it("[negative control] rejects an agent caller with 403 and makes no DB read or write", async () => {
    const res = await postReassign(AGENT, { claim: "work", target: { type: "human", id: "user-2" } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toMatch(/^Agents cannot/);
    expect(prismaMocks.taskFindUnique).not.toHaveBeenCalled();
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
    expect(logAuditEventMock).not.toHaveBeenCalled();
  });

  it("rejects a non-admin human caller with 403 and makes no write", async () => {
    accessMocks.isProjectAdmin.mockResolvedValue(false);
    prismaMocks.taskFindUnique.mockResolvedValue(fresh({ claimedByAgentId: "agent-77" }));
    const res = await postReassign(NON_ADMIN, { claim: "work", target: { type: "human", id: "user-2" } });
    expect(res.status).toBe(403);
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
    expect(groundingMocks.mutateRuns).not.toHaveBeenCalled();
    expect(logAuditEventMock).not.toHaveBeenCalled();
  });

  it("re-validates ADMIN inside the transaction: an admin demoted since the load gets 403 and no write", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue(fresh({ claimedByAgentId: "agent-77" }));
    accessMocks.hasProjectRole.mockResolvedValue(false);
    const res = await postReassign(ADMIN, { claim: "work", target: { type: "human", id: "user-2" } });
    expect(res.status).toBe(403);
    expect(accessMocks.hasProjectRole).toHaveBeenCalledWith(ADMIN, PROJECT_ID, "ADMIN", expect.anything());
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
    expect(logAuditEventMock).not.toHaveBeenCalled();
  });

  it("404s when the task does not exist", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue(null);
    const res = await postReassign(ADMIN, { claim: "work", target: { type: "human", id: "user-2" } });
    expect(res.status).toBe(404);
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
  });
});

describe("POST /tasks/:id/admin-reassign: validation", () => {
  it.each([
    ["an empty body", {}],
    ["an unknown claim kind", { claim: "both", target: { type: "human", id: "user-2" } }],
    ["a missing target", { claim: "work" }],
    ["an unknown target type", { claim: "work", target: { type: "team", id: "t-1" } }],
    ["an empty target id", { claim: "work", target: { type: "human", id: "" } }],
    ["a reason over 500 characters", { claim: "work", target: { type: "human", id: "user-2" }, reason: "x".repeat(501) }],
  ])("400s on %s and makes no write", async (_label, body) => {
    prismaMocks.taskFindUnique.mockResolvedValue(fresh({ claimedByAgentId: "agent-77" }));
    const res = await postReassign(ADMIN, body);
    expect(res.status).toBe(400);
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
    expect(logAuditEventMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a human outside the eligible set", { type: "human", id: "stranger" }],
    ["an agent outside the eligible set", { type: "agent", id: "agent-elsewhere" }],
    ["a human id presented as an agent", { type: "agent", id: "user-2" }],
    ["an agent id presented as a human", { type: "human", id: "agent-new" }],
  ])("400s for %s with a clear message and no write", async (_label, target) => {
    prismaMocks.taskFindUnique.mockResolvedValue(fresh({ claimedByAgentId: "agent-77" }));
    const res = await postReassign(ADMIN, { claim: "work", target });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toMatch(/not an eligible claim holder/);
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
    expect(logAuditEventMock).not.toHaveBeenCalled();
  });

  it("re-checks the target inside the transaction: a token revoked since the first check gets 409 and no write", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue(fresh({ claimedByUserId: "user-3" }));
    eligibleMocks.listEligibleActors
      .mockResolvedValueOnce(ELIGIBLE)
      .mockResolvedValueOnce({ ...ELIGIBLE, agents: [] });
    const res = await postReassign(ADMIN, { claim: "work", target: { type: "agent", id: "agent-new" } });
    expect(res.status).toBe(409);
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
    expect(logAuditEventMock).not.toHaveBeenCalled();
  });
});

describe("POST /tasks/:id/admin-reassign: reassigning claims", () => {
  it("hands a work claim from an AGENT to a HUMAN: status unchanged, other column cleared, claimedAt refreshed, audited", async () => {
    prismaMocks.taskFindUnique
      .mockResolvedValueOnce(fresh({ status: "in_progress", claimedByAgentId: "agent-77" }))
      .mockResolvedValueOnce(fresh({ status: "in_progress", claimedByUserId: "user-2" }));

    const res = await postReassign(ADMIN, { claim: "work", target: { type: "human", id: "user-2" }, reason: "agent stalled" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      task: { status: string; claimedByUserId: string | null };
      reassigned: { claim: string; priorHolder: unknown; newHolder: unknown };
    };
    expect(body.task.status).toBe("in_progress");
    expect(body.reassigned).toEqual({
      claim: "work",
      priorHolder: { type: "agent", id: "agent-77" },
      newHolder: { type: "human", id: "user-2" },
    });
    expect(groundingMocks.mutateRuns).toHaveBeenCalledWith("admin_reassign");

    expect(prismaMocks.taskUpdateMany).toHaveBeenCalledTimes(1);
    const call = prismaMocks.taskUpdateMany.mock.calls[0]![0];
    expect(call.where).toMatchObject({ id: TASK_ID, claimedByAgentId: "agent-77" });
    expect(call.data).toEqual({ claimedByUserId: "user-2", claimedByAgentId: null, claimedAt: expect.any(Date) });
    expect(call.data.status).toBeUndefined();

    expect(logAuditEventMock).toHaveBeenCalledTimes(1);
    expect(logAuditEventMock).toHaveBeenCalledWith({
      action: "task.claim_reassigned",
      actorId: "admin-1",
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      payload: {
        claim: "work",
        priorHolder: { type: "agent", id: "agent-77" },
        newHolder: { type: "human", id: "user-2" },
        reason: "agent stalled",
      },
    });
  });

  it("hands a review claim from a HUMAN to an AGENT: review columns only, work claim untouched, audited with a null reason", async () => {
    prismaMocks.taskFindUnique
      .mockResolvedValueOnce(fresh({ status: "review", claimedByUserId: "user-3", reviewClaimedByUserId: "user-2" }))
      .mockResolvedValueOnce(fresh({ status: "review", claimedByUserId: "user-3", reviewClaimedByAgentId: "agent-new" }));

    const res = await postReassign(ADMIN, { claim: "review", target: { type: "agent", id: "agent-new" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: { status: string }; reassigned: unknown };
    expect(body.task.status).toBe("review");
    expect(body.reassigned).toEqual({
      claim: "review",
      priorHolder: { type: "human", id: "user-2" },
      newHolder: { type: "agent", id: "agent-new" },
    });

    const call = prismaMocks.taskUpdateMany.mock.calls[0]![0];
    expect(call.where).toMatchObject({ id: TASK_ID, reviewClaimedByUserId: "user-2" });
    expect(call.where.claimedByUserId).toBeUndefined();
    expect(call.data).toEqual({ reviewClaimedByUserId: null, reviewClaimedByAgentId: "agent-new", reviewClaimedAt: expect.any(Date) });

    expect(logAuditEventMock).toHaveBeenCalledTimes(1);
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.claim_reassigned",
        payload: {
          claim: "review",
          priorHolder: { type: "human", id: "user-2" },
          newHolder: { type: "agent", id: "agent-new" },
          reason: null,
        },
      }),
    );
  });

  it("allows a HUMAN target regardless of other claims (humans are exempt from the single-active-claim rule)", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue(fresh({ claimedByAgentId: "agent-77" }));
    prismaMocks.taskFindFirst.mockResolvedValue({ id: "other", title: "Other", reviewClaimedByAgentId: null });

    const res = await postReassign(ADMIN, { claim: "work", target: { type: "human", id: "user-2" } });
    expect(res.status).toBe(200);
    expect(prismaMocks.taskFindFirst).not.toHaveBeenCalled();
    expect(prismaMocks.taskUpdateMany).toHaveBeenCalledTimes(1);
  });
});

describe("POST /tasks/:id/admin-reassign: refused reassignments", () => {
  it("409s when the claim has no current holder, with an explicit message and no write", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue(fresh({ claimedByAgentId: null, claimedByUserId: null }));
    const res = await postReassign(ADMIN, { claim: "work", target: { type: "human", id: "user-2" } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toMatch(/no work claim to reassign/);
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
    expect(logAuditEventMock).not.toHaveBeenCalled();
  });

  it("409s when the review claim has no current holder", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue(fresh({ status: "review", claimedByUserId: "user-3" }));
    const res = await postReassign(ADMIN, { claim: "review", target: { type: "human", id: "user-2" } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toMatch(/no review claim to reassign/);
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
  });

  it("409s when the target already holds the claim, instead of a silent no-op", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue(fresh({ claimedByAgentId: "agent-77" }));
    const res = await postReassign(ADMIN, { claim: "work", target: { type: "agent", id: "agent-77" } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toMatch(/already holds/);
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
    expect(logAuditEventMock).not.toHaveBeenCalled();
  });

  it("treats a user id and an agent token id as different holders even when the strings are equal", async () => {
    const shared = { ...ELIGIBLE, agents: [{ tokenId: "user-2", name: "Collides" }] };
    eligibleMocks.listEligibleActors.mockResolvedValue(shared);
    prismaMocks.taskFindUnique.mockResolvedValue(fresh({ claimedByUserId: "user-2" }));
    const res = await postReassign(ADMIN, { claim: "work", target: { type: "agent", id: "user-2" } });
    expect(res.status).toBe(200);
  });

  it("409s already_claimed for an AGENT target holding another active claim, with the activeClaim shape and no write", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue(fresh({ claimedByUserId: "user-3" }));
    prismaMocks.taskFindFirst.mockResolvedValue({ id: "task-other", title: "Other work", reviewClaimedByAgentId: null });

    const res = await postReassign(ADMIN, { claim: "work", target: { type: "agent", id: "agent-new" } });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string; activeClaim: unknown };
    expect(body.error).toBe("already_claimed");
    expect(body.message).toMatch(/already holds an active claim/);
    expect(body.activeClaim).toEqual({ taskId: "task-other", title: "Other work", role: "author" });

    // The same predicate the agent branches of pickup and start use, minus this task.
    expect(prismaMocks.taskFindFirst.mock.calls[0]![0].where).toEqual({
      id: { not: TASK_ID },
      OR: [
        { claimedByAgentId: "agent-new", status: { not: "done" } },
        { reviewClaimedByAgentId: "agent-new", status: "review" },
      ],
    });
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
    expect(logAuditEventMock).not.toHaveBeenCalled();
  });

  it("reports role reviewer in activeClaim when the target agent's other claim is a review claim", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue(fresh({ claimedByUserId: "user-3" }));
    prismaMocks.taskFindFirst.mockResolvedValue({ id: "task-rev", title: "Under review", reviewClaimedByAgentId: "agent-new" });
    const res = await postReassign(ADMIN, { claim: "work", target: { type: "agent", id: "agent-new" } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { activeClaim: { role: string } }).activeClaim.role).toBe("reviewer");
  });

  it("allows an AGENT target without another active claim", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue(fresh({ claimedByUserId: "user-3" }));
    const res = await postReassign(ADMIN, { claim: "work", target: { type: "agent", id: "agent-new" } });
    expect(res.status).toBe(200);
    expect(prismaMocks.taskFindFirst).toHaveBeenCalledTimes(1);
    expect(prismaMocks.taskUpdateMany.mock.calls[0]![0].data).toEqual({
      claimedByUserId: null,
      claimedByAgentId: "agent-new",
      claimedAt: expect.any(Date),
    });
  });

  describe("distinct reviewer", () => {
    it("409s when the review claim would go to the task's work claimant (human), with no write", async () => {
      prismaMocks.taskFindUnique.mockResolvedValue(
        fresh({ status: "review", project: DISTINCT_PROJECT, claimedByUserId: "user-3", reviewClaimedByAgentId: "agent-77" }),
      );
      const res = await postReassign(ADMIN, { claim: "review", target: { type: "human", id: "user-3" } });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { message: string }).message).toMatch(/distinct reviewer/);
      expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
      expect(logAuditEventMock).not.toHaveBeenCalled();
    });

    it("409s when the review claim would go to the task's work claimant (agent)", async () => {
      prismaMocks.taskFindUnique.mockResolvedValue(
        fresh({ status: "review", project: DISTINCT_PROJECT, claimedByAgentId: "agent-new", reviewClaimedByUserId: "user-2" }),
      );
      const res = await postReassign(ADMIN, { claim: "review", target: { type: "agent", id: "agent-new" } });
      expect(res.status).toBe(409);
      expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
    });

    it("allows the same handoff when the project does not require a distinct reviewer", async () => {
      prismaMocks.taskFindUnique.mockResolvedValue(
        fresh({ status: "review", project: OPEN_PROJECT, claimedByUserId: "user-3", reviewClaimedByAgentId: "agent-77" }),
      );
      const res = await postReassign(ADMIN, { claim: "review", target: { type: "human", id: "user-3" } });
      expect(res.status).toBe(200);
    });

    it("does not apply to a work claim reassignment", async () => {
      prismaMocks.taskFindUnique.mockResolvedValue(
        fresh({ status: "review", project: DISTINCT_PROJECT, claimedByAgentId: "agent-77", reviewClaimedByUserId: "user-3" }),
      );
      const res = await postReassign(ADMIN, { claim: "work", target: { type: "human", id: "user-2" } });
      expect(res.status).toBe(200);
    });

    it("re-checks the gate inside the transaction against the locked row", async () => {
      // The route loaded a task with no work claimant; by the time the wrapper
      // holds the lock, user-3 has become the claimant.
      const loaded = fresh({ status: "review", project: DISTINCT_PROJECT, claimedByUserId: null, reviewClaimedByAgentId: "agent-77" });
      prismaMocks.taskFindUnique.mockResolvedValue(loaded);
      groundingMocks.locked.value = { ...loaded, claimedByUserId: "user-3" };
      const res = await postReassign(ADMIN, { claim: "review", target: { type: "human", id: "user-3" } });
      expect(res.status).toBe(409);
      expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
      expect(logAuditEventMock).not.toHaveBeenCalled();
    });
  });
});

describe("POST /tasks/:id/admin-reassign: compare-and-swap and merge reservation", () => {
  it("409s when the claim changed hands between the load and the write, and never clobbers the new holder", async () => {
    // Load sees agent-77; by write time the claim belongs to user-3.
    const row: Row = { claimedByUserId: "user-3", claimedByAgentId: null, reviewClaimedByUserId: null, reviewClaimedByAgentId: null };
    prismaMocks.taskFindUnique.mockResolvedValue(fresh({ claimedByAgentId: "agent-77" }));
    rowMatchingUpdateMany(row);

    const res = await postReassign(ADMIN, { claim: "work", target: { type: "human", id: "user-2" } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("conflict");
    expect(prismaMocks.taskUpdateMany).toHaveBeenCalledTimes(1);
    expect(prismaMocks.taskUpdateMany.mock.calls[0]![0].where).toMatchObject({ id: TASK_ID, claimedByAgentId: "agent-77" });
    expect(logAuditEventMock).not.toHaveBeenCalled();
  });

  it("succeeds when the pinned holder still holds the claim at write time", async () => {
    const row: Row = { claimedByUserId: null, claimedByAgentId: "agent-77", reviewClaimedByUserId: null, reviewClaimedByAgentId: null };
    prismaMocks.taskFindUnique.mockResolvedValue(fresh({ claimedByAgentId: "agent-77" }));
    rowMatchingUpdateMany(row);

    const res = await postReassign(ADMIN, { claim: "work", target: { type: "human", id: "user-2" } });
    expect(res.status).toBe(200);
    expect(logAuditEventMock).toHaveBeenCalledTimes(1);
  });

  it("409s on a lost review-claim CAS as well", async () => {
    const row: Row = { claimedByUserId: "user-3", claimedByAgentId: null, reviewClaimedByUserId: null, reviewClaimedByAgentId: "agent-other" };
    prismaMocks.taskFindUnique.mockResolvedValue(fresh({ status: "review", claimedByUserId: "user-3", reviewClaimedByUserId: "user-2" }));
    rowMatchingUpdateMany(row);

    const res = await postReassign(ADMIN, { claim: "review", target: { type: "agent", id: "agent-new" } });
    expect(res.status).toBe(409);
    expect(logAuditEventMock).not.toHaveBeenCalled();
  });

  it("answers 409 merge_in_progress, not the plain conflict, when a live merge reservation made the write miss", async () => {
    prismaMocks.taskFindUnique
      .mockResolvedValueOnce(fresh({ claimedByAgentId: "agent-77" }))
      // The route's own re-read for the reason: a reservation taken just now.
      .mockResolvedValueOnce({ mergeReservedAt: new Date() });
    prismaMocks.taskUpdateMany.mockResolvedValue({ count: 0 });

    const res = await postReassign(ADMIN, { claim: "work", target: { type: "human", id: "user-2" } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("merge_in_progress");
    expect(logAuditEventMock).not.toHaveBeenCalled();
  });

  it("composes the write's where with the no-live-merge-reservation predicate", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue(fresh({ claimedByAgentId: "agent-77" }));
    await postReassign(ADMIN, { claim: "work", target: { type: "human", id: "user-2" } });
    const where = prismaMocks.taskUpdateMany.mock.calls[0]![0].where as { AND?: unknown[] };
    expect(JSON.stringify(where.AND)).toContain("mergeReservedAt");
  });
});

describe("POST /tasks/:id/admin-reassign: grounding wrapper", () => {
  it("surfaces a wrapper refusal as the matching HTTP status", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue(fresh({ claimedByAgentId: "agent-77" }));
    accessMocks.hasProjectRole.mockImplementation(async () => {
      throw new GroundingAccessError("bad_state", 409);
    });
    const res = await postReassign(ADMIN, { claim: "work", target: { type: "human", id: "user-2" } });
    expect(res.status).toBe(409);
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
  });
});
