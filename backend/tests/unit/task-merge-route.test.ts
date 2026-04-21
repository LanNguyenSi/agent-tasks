/**
 * Route tests for POST /tasks/:id/merge. Focused on wiring:
 * - scope gating (`github:pr_merge`)
 * - the bad-status rejection (open/in_progress → 409)
 * - the distinct-reviewer gate (review→done path)
 * - the self-merge gate (fires on both review→done and done→done)
 * - the task update + audit payload on success
 *
 * The rule logic itself is covered by self-merge-gate.test.ts; this file
 * asserts that the route calls the shared gates correctly and maps the
 * results to the right HTTP responses.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const prismaMocks = vi.hoisted(() => ({
  taskFindUnique: vi.fn(),
  taskFindFirst: vi.fn(),
  taskFindMany: vi.fn(),
  taskUpdate: vi.fn(),
  signalFindFirst: vi.fn(),
  signalUpdate: vi.fn(),
  signalUpdateMany: vi.fn().mockResolvedValue({ count: 0 }),
  workflowFindFirst: vi.fn(),
  agentTokenFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: {
      findUnique: prismaMocks.taskFindUnique,
      findFirst: prismaMocks.taskFindFirst,
      findMany: prismaMocks.taskFindMany,
      update: prismaMocks.taskUpdate,
    },
    signal: {
      findFirst: prismaMocks.signalFindFirst,
      update: prismaMocks.signalUpdate,
      updateMany: prismaMocks.signalUpdateMany,
    },
    workflow: { findFirst: prismaMocks.workflowFindFirst },
    agentToken: { findUnique: prismaMocks.agentTokenFindUnique },
    user: { findUnique: prismaMocks.userFindUnique },
  },
}));

const accessMocks = vi.hoisted(() => ({
  hasProjectAccess: vi.fn().mockResolvedValue(true),
  hasProjectRole: vi.fn().mockResolvedValue(true),
  isProjectAdmin: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../src/services/team-access.js", () => accessMocks);

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/review-signal.js", () => ({
  emitReviewSignal: vi.fn(),
  emitChangesRequestedSignal: vi.fn(),
  emitTaskApprovedSignal: vi.fn(),
}));
vi.mock("../../src/services/task-signal.js", () => ({ emitTaskAvailableSignal: vi.fn() }));
vi.mock("../../src/services/force-transition-signal.js", () => ({
  emitForceTransitionedSignal: vi.fn(),
}));
vi.mock("../../src/services/self-merge-notice.js", () => ({
  emitSelfMergeNoticeIfApplicable: vi.fn().mockResolvedValue(0),
}));
vi.mock("../../src/services/github-delegation.js", () => ({
  findDelegationUser: vi.fn().mockResolvedValue(null),
}));

const mergeMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/github-merge.js", () => ({
  performPrMerge: mergeMock,
}));

import { taskRouter } from "../../src/routes/tasks.js";
import { logAuditEvent } from "../../src/services/audit.js";

const AGENT_WITH_SCOPE: Actor = {
  type: "agent",
  tokenId: "agent-reviewer",
  teamId: "team-1",
  scopes: ["tasks:read", "github:pr_merge"],
};

const AGENT_CLAIMANT: Actor = {
  type: "agent",
  tokenId: "agent-claimant",
  teamId: "team-1",
  scopes: ["tasks:read", "github:pr_merge"],
};

function makeApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", taskRouter);
  return app;
}

const baseTask = {
  id: "task-1",
  projectId: "proj-1",
  status: "review",
  claimedByUserId: null,
  claimedByAgentId: "agent-claimant",
  reviewClaimedByUserId: null,
  reviewClaimedByAgentId: "agent-reviewer",
  prNumber: 42,
  branchName: "feat/x",
  prUrl: "https://github.com/acme/thing/pull/42",
  project: {
    id: "proj-1",
    teamId: "team-1",
    githubRepo: "acme/thing",
    requireDistinctReviewer: true,
    soloMode: false,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  accessMocks.hasProjectAccess.mockResolvedValue(true);
  mergeMock.mockResolvedValue({ ok: true, sha: "deadbeef", alreadyMerged: false });
  prismaMocks.taskUpdate.mockImplementation(
    ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
      Promise.resolve({ ...baseTask, id: where.id, ...data }),
  );
});

describe("POST /tasks/:id/merge", () => {
  it("rejects agents missing github:pr_merge scope", async () => {
    const weak: Actor = { ...AGENT_WITH_SCOPE, scopes: ["tasks:read"] };
    const res = await makeApp(weak).request("/tasks/task-1/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect(prismaMocks.taskFindUnique).not.toHaveBeenCalled();
    expect(mergeMock).not.toHaveBeenCalled();
  });

  it("rejects a task that is still in open/in_progress with 409 bad_state", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...baseTask, status: "in_progress" });
    const res = await makeApp(AGENT_WITH_SCOPE).request("/tasks/task-1/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    expect(mergeMock).not.toHaveBeenCalled();
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.merge_rejected_bad_status" }),
    );
  });

  it("blocks self-merge when actor is the work claimant (DR on, not solo)", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...baseTask });
    const res = await makeApp(AGENT_CLAIMANT).request("/tasks/task-1/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("self_merge_blocked");
    expect(mergeMock).not.toHaveBeenCalled();
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.pr_merged.blocked_self_merge",
        payload: expect.objectContaining({ via: "task_merge" }),
      }),
    );
  });

  it("allows self-merge when the project is in soloMode", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({
      ...baseTask,
      project: { ...baseTask.project, soloMode: true, requireDistinctReviewer: false },
    });
    const res = await makeApp(AGENT_CLAIMANT).request("/tasks/task-1/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mergeMethod: "squash" }),
    });
    expect(res.status).toBe(200);
    expect(mergeMock).toHaveBeenCalledTimes(1);
    expect(prismaMocks.taskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "done",
          claimedByAgentId: null,
          reviewClaimedByAgentId: null,
          autoMergeSha: "deadbeef",
        }),
      }),
    );
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.merged",
        payload: expect.objectContaining({ via: "task_merge", mergeMethod: "squash" }),
      }),
    );
  });

  it("lets a distinct reviewer merge (happy path)", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...baseTask });
    const res = await makeApp(AGENT_WITH_SCOPE).request("/tasks/task-1/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mergeMethod: "merge" }),
    });
    expect(res.status).toBe(200);
    expect(mergeMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
      "merge",
      AGENT_WITH_SCOPE,
    );
    const body = (await res.json()) as { merged: boolean; sha: string };
    expect(body.merged).toBe(true);
    expect(body.sha).toBe("deadbeef");
  });

  it("enforces distinct-reviewer gate when no review lock is present", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({
      ...baseTask,
      reviewClaimedByAgentId: null,
      reviewClaimedByUserId: null,
    });
    const res = await makeApp(AGENT_WITH_SCOPE).request("/tasks/task-1/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect(mergeMock).not.toHaveBeenCalled();
  });

  it("idempotent on done: still runs self-merge gate on retry", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...baseTask, status: "done" });
    const res = await makeApp(AGENT_CLAIMANT).request("/tasks/task-1/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("self_merge_blocked");
  });

  it("surfaces performPrMerge failure with its own status code", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...baseTask });
    mergeMock.mockResolvedValue({
      ok: false,
      error: "github_error",
      message: "409 conflict",
      status: 409,
    });
    const res = await makeApp(AGENT_WITH_SCOPE).request("/tasks/task-1/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
  });
});
