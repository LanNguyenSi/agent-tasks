/**
 * Route tests for `POST /tasks/:id/admin-release` — the human-project-admin
 * escape hatch that force-releases a work and/or review claim held by
 * ANYONE, without touching task.status (status is the admin's separate
 * `/tasks/:id/transition{force:true}` lever).
 *
 * Mirrors the mock preamble from deliverable-repo-routes.test.ts, which is a
 * clean recent example of route-level testing against the taskRouter.
 *
 * Per the project feedback memory: prefer `mockResolvedValue` over stacked
 * `mockResolvedValueOnce` queues (`vi.clearAllMocks` does not drain the
 * once-queue). `taskUpdateMany` therefore defaults to `{ count: 1 }`
 * persistently; only the idempotent/race tests override it with a single
 * `mockResolvedValueOnce` that is fully consumed within that same test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const prismaMocks = vi.hoisted(() => ({
  taskFindUnique: vi.fn(),
  taskUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: {
      findUnique: prismaMocks.taskFindUnique,
      updateMany: prismaMocks.taskUpdateMany,
    },
  },
}));

const accessMocks = vi.hoisted(() => ({
  hasProjectAccess: vi.fn().mockResolvedValue(true),
  hasProjectRole: vi.fn().mockResolvedValue(true),
  isProjectAdmin: vi.fn().mockResolvedValue(true),
  requireProjectWrite: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../src/services/team-access.js", () => accessMocks);

const logAuditEventMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: logAuditEventMock,
}));

// The taskRouter module also imports these collaborators at module-load
// time; mocked here the same way deliverable-repo-routes.test.ts does so
// importing the router doesn't pull in real GitHub/signal side effects.
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
  attachments: [],
  comments: [],
  claimedByUser: null,
  claimedByAgent: null,
  blockedBy: [],
  blocks: [],
};

function postAdminRelease(actor: Actor, body: Record<string, unknown>) {
  return makeApp(actor).request(`/tasks/${TASK_ID}/admin-release`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  accessMocks.hasProjectAccess.mockResolvedValue(true);
  accessMocks.hasProjectRole.mockResolvedValue(true);
  accessMocks.isProjectAdmin.mockResolvedValue(true);
  accessMocks.requireProjectWrite.mockResolvedValue(true);
  prismaMocks.taskUpdateMany.mockResolvedValue({ count: 1 });
});

describe("POST /tasks/:id/admin-release — authorization", () => {
  it("[negative control] rejects an agent caller with 403 and makes no DB write", async () => {
    const res = await postAdminRelease(AGENT, { releaseWorkClaim: true });
    expect(res.status).toBe(403);
    expect(prismaMocks.taskFindUnique).not.toHaveBeenCalled();
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects a non-admin human caller with 403 and makes no DB write", async () => {
    accessMocks.isProjectAdmin.mockResolvedValue(false);
    prismaMocks.taskFindUnique.mockResolvedValue({ ...baseTask, claimedByAgentId: "agent-x" });
    const res = await postAdminRelease(NON_ADMIN, { releaseWorkClaim: true });
    expect(res.status).toBe(403);
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
  });

  it("404s when the task does not exist", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue(null);
    const res = await postAdminRelease(ADMIN, { releaseWorkClaim: true });
    expect(res.status).toBe(404);
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
  });
});

describe("POST /tasks/:id/admin-release — validation", () => {
  it("400s when neither releaseWorkClaim nor releaseReviewClaim is set", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...baseTask, claimedByAgentId: "agent-x" });
    const res = await postAdminRelease(ADMIN, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toMatch(/nothing to release/);
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
  });

  it("400s when both booleans are explicitly false", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...baseTask, claimedByAgentId: "agent-x" });
    const res = await postAdminRelease(ADMIN, { releaseWorkClaim: false, releaseReviewClaim: false });
    expect(res.status).toBe(400);
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
  });
});

describe("POST /tasks/:id/admin-release — releasing claims", () => {
  it("releases a work claim held by an AGENT: 200, fields nulled, status unchanged, audited with agent priorHolder", async () => {
    prismaMocks.taskFindUnique
      .mockResolvedValueOnce({ ...baseTask, status: "in_progress", claimedByAgentId: "agent-77" })
      .mockResolvedValueOnce({ ...baseTask, status: "in_progress", claimedByAgentId: null });

    const res = await postAdminRelease(ADMIN, { releaseWorkClaim: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      task: { status: string; claimedByAgentId: string | null };
      released: { workClaim: boolean; reviewClaim: boolean };
    };
    expect(body.released).toEqual({ workClaim: true, reviewClaim: false });
    expect(body.task.claimedByAgentId).toBeNull();
    expect(body.task.status).toBe("in_progress"); // unchanged, unlike self-service /release

    const call = prismaMocks.taskUpdateMany.mock.calls[0]![0];
    expect(call.data).toEqual({ claimedByUserId: null, claimedByAgentId: null, claimedAt: null });
    expect(call.data.status).toBeUndefined();
    expect(call.where).toMatchObject({ id: TASK_ID });

    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.claim_released_by_admin",
        actorId: "admin-1",
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        payload: expect.objectContaining({
          priorHolder: { type: "agent", id: "agent-77" },
          reason: null,
        }),
      }),
    );
    expect(logAuditEventMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.review_claim_released_by_admin" }),
    );
  });

  it("releases a review claim held by a HUMAN: 200, review fields nulled, audited with human priorHolder", async () => {
    prismaMocks.taskFindUnique
      .mockResolvedValueOnce({ ...baseTask, status: "review", reviewClaimedByUserId: "user-99" })
      .mockResolvedValueOnce({ ...baseTask, status: "review", reviewClaimedByUserId: null });

    const res = await postAdminRelease(ADMIN, { releaseReviewClaim: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      task: { reviewClaimedByUserId: string | null };
      released: { workClaim: boolean; reviewClaim: boolean };
    };
    expect(body.released).toEqual({ workClaim: false, reviewClaim: true });
    expect(body.task.reviewClaimedByUserId).toBeNull();

    const call = prismaMocks.taskUpdateMany.mock.calls[0]![0];
    expect(call.data).toEqual({
      reviewClaimedByUserId: null,
      reviewClaimedByAgentId: null,
      reviewClaimedAt: null,
    });

    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.review_claim_released_by_admin",
        payload: expect.objectContaining({
          priorHolder: { type: "human", id: "user-99" },
          reason: null,
        }),
      }),
    );
  });

  it("releases BOTH claims in one call: both nulled, two distinct audit events", async () => {
    prismaMocks.taskFindUnique
      .mockResolvedValueOnce({
        ...baseTask,
        claimedByAgentId: "agent-1",
        reviewClaimedByUserId: "user-2",
      })
      .mockResolvedValueOnce({
        ...baseTask,
        claimedByAgentId: null,
        reviewClaimedByUserId: null,
      });

    const res = await postAdminRelease(ADMIN, { releaseWorkClaim: true, releaseReviewClaim: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { released: { workClaim: boolean; reviewClaim: boolean } };
    expect(body.released).toEqual({ workClaim: true, reviewClaim: true });

    expect(prismaMocks.taskUpdateMany).toHaveBeenCalledTimes(2);
    expect(logAuditEventMock).toHaveBeenCalledTimes(2);
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.claim_released_by_admin" }),
    );
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.review_claim_released_by_admin" }),
    );
  });

  it("threads a provided reason into the audit payload", async () => {
    prismaMocks.taskFindUnique
      .mockResolvedValueOnce({ ...baseTask, claimedByAgentId: "agent-77" })
      .mockResolvedValueOnce({ ...baseTask, claimedByAgentId: null });

    const res = await postAdminRelease(ADMIN, {
      releaseWorkClaim: true,
      reason: "Agent went unresponsive for 3 days",
    });
    expect(res.status).toBe(200);
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ reason: "Agent went unresponsive for 3 days" }),
      }),
    );
  });
});

describe("POST /tasks/:id/admin-release — idempotency and CAS races", () => {
  it("is idempotent when releasing a work claim on a task with no work claim: 200, released.workClaim=false, no audit", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({
      ...baseTask,
      claimedByAgentId: null,
      claimedByUserId: null,
    });
    prismaMocks.taskUpdateMany.mockResolvedValueOnce({ count: 0 });

    const res = await postAdminRelease(ADMIN, { releaseWorkClaim: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { released: { workClaim: boolean; reviewClaim: boolean } };
    expect(body.released).toEqual({ workClaim: false, reviewClaim: false });
    expect(logAuditEventMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.claim_released_by_admin" }),
    );
  });

  it("handles a CAS race (updateMany count 0 despite a claim visible at load time): no audit, released flag false", async () => {
    prismaMocks.taskFindUnique
      .mockResolvedValueOnce({ ...baseTask, claimedByAgentId: "agent-raced-away" })
      .mockResolvedValueOnce({ ...baseTask, claimedByAgentId: null });
    // Simulates another actor releasing/claiming between the initial load
    // and this admin's CAS write.
    prismaMocks.taskUpdateMany.mockResolvedValueOnce({ count: 0 });

    const res = await postAdminRelease(ADMIN, { releaseWorkClaim: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { released: { workClaim: boolean; reviewClaim: boolean } };
    expect(body.released.workClaim).toBe(false);
    expect(logAuditEventMock).not.toHaveBeenCalled();
  });
});
