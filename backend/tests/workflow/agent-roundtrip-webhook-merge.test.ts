/**
 * Workflow round-trip suite — webhook-merge-to-review path (self-approve).
 *
 * Exercises the scenario where a GitHub webhook fires a merge event that
 * transitions the task from `in_progress` to `review` status while the agent
 * still holds only a work claim (no separate review claim). This is the
 * "webhook-merge-to-review dead-end" described in task 2a65fe2d.
 *
 * The new third dispatch branch in POST /tasks/:id/finish allows the work-claim
 * holder to finalize a review-state task on a non-REQUIRES_DISTINCT_REVIEWER
 * project by acting as self-reviewer (supplying `outcome`).
 *
 * Round-trip exercised here:
 *   1. (author) task_start   → POST /tasks/:id/start         (open → in_progress)
 *   2.          [webhook]    → task status externally set to "review" (simulated via DB)
 *   3. (author) task_finish  → POST /tasks/:id/finish { outcome: "approve" }  → done
 *
 * Additional cases (isolated, not part of the sequential round-trip):
 *   - outcome: "request_changes" → back to in_progress, work claim retained
 *   - REQUIRES_DISTINCT_REVIEWER project → 403 from the same call
 *   - missing outcome on review-state task → descriptive 400
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";
import {
  makeProject,
  makeTask,
  measure,
  type TaskRow,
} from "./fixtures.js";

const PROJECT_ID = "55555555-5555-5555-5555-555555555555";
const TASK_ID = "66666666-6666-6666-6666-666666666666";

const prismaMocks = vi.hoisted(() => ({
  taskCreate: vi.fn(),
  taskFindUnique: vi.fn(),
  taskFindFirst: vi.fn().mockResolvedValue(null),
  taskFindMany: vi.fn().mockResolvedValue([]),
  taskUpdate: vi.fn(),
  taskUpdateMany: vi.fn(),
  signalFindFirst: vi.fn(),
  signalUpdate: vi.fn(),
  signalUpdateMany: vi.fn().mockResolvedValue({ count: 0 }),
  workflowFindFirst: vi.fn().mockResolvedValue(null),
  projectFindUnique: vi.fn().mockResolvedValue({ confidenceThreshold: 0, taskTemplate: null }),
  agentTokenFindUnique: vi.fn().mockResolvedValue({ id: "agent-author", name: "Author" }),
  userFindUnique: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: {
      create: prismaMocks.taskCreate,
      findUnique: prismaMocks.taskFindUnique,
      findFirst: prismaMocks.taskFindFirst,
      findMany: prismaMocks.taskFindMany,
      update: prismaMocks.taskUpdate,
      updateMany: prismaMocks.taskUpdateMany,
    },
    project: { findUnique: prismaMocks.projectFindUnique },
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
  requireProjectWrite: vi.fn().mockResolvedValue(true),
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
vi.mock("../../src/services/task-signal.js", () => ({
  emitTaskAvailableSignal: vi.fn().mockResolvedValue(undefined),
}));
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

const groundingMocks = vi.hoisted(() => ({
  getGroundingClient: vi.fn(() => null),
  deriveDebugFlavor: vi.fn().mockResolvedValue({
    isFresh: false,
    mergedMetadata: null,
  }),
}));
vi.mock("../../src/services/grounding.js", () => ({
  getGroundingClient: groundingMocks.getGroundingClient,
}));
vi.mock("../../src/services/debug-flavor.js", () => ({
  deriveDebugFlavor: groundingMocks.deriveDebugFlavor,
}));

import { taskRouter } from "../../src/routes/tasks.js";

const AGENT_AUTHOR: Actor = {
  type: "agent",
  tokenId: "agent-author",
  teamId: "team-1",
  userId: "user-author",
  scopes: ["tasks:read", "tasks:create", "tasks:claim", "tasks:transition", "github:pr_merge"],
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

/** Build a task that is already in "review" status with a work claim held. */
function makeReviewStateTask(project: ReturnType<typeof makeProject>): TaskRow {
  return makeTask(
    {
      id: TASK_ID,
      projectId: PROJECT_ID,
      status: "review",
      claimedByAgentId: "agent-author",
      claimedByUserId: null,
      claimedAt: new Date("2026-06-15T10:00:00Z"),
      reviewClaimedByAgentId: null,
      reviewClaimedByUserId: null,
      reviewClaimedAt: null,
      branchName: "feat/webhook-merge-test",
      prUrl: "https://github.com/LanNguyenSi/fixture-project/pull/99",
      prNumber: 99,
    },
    project,
  );
}

describe("workflow round-trip — webhook-merge-to-review self-approve (task 2a65fe2d)", () => {
  let currentTask: TaskRow;

  function setupMocks(project: ReturnType<typeof makeProject>) {
    vi.clearAllMocks();
    mergeMock.mockResolvedValue({
      ok: true,
      sha: "aabbccddeeff00112233445566778899aabbccdd",
      alreadyMerged: false,
    });
    prismaMocks.taskFindFirst.mockResolvedValue(null);
    prismaMocks.taskFindMany.mockResolvedValue([]);
    prismaMocks.signalUpdateMany.mockResolvedValue({ count: 0 });
    prismaMocks.workflowFindFirst.mockResolvedValue(null);
    prismaMocks.agentTokenFindUnique.mockResolvedValue({ id: "agent-author", name: "Author" });
    prismaMocks.userFindUnique.mockResolvedValue(null);
    accessMocks.hasProjectAccess.mockResolvedValue(true);
    accessMocks.hasProjectRole.mockResolvedValue(true);
    accessMocks.isProjectAdmin.mockResolvedValue(true);
    groundingMocks.getGroundingClient.mockReturnValue(null);
    groundingMocks.deriveDebugFlavor.mockResolvedValue({ isFresh: false, mergedMetadata: null });

    currentTask = makeReviewStateTask(project);

    prismaMocks.taskFindUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id !== currentTask.id) return Promise.resolve(null);
      return Promise.resolve(currentTask);
    });
    prismaMocks.taskUpdate.mockImplementation(
      ({ where, data }: { where: { id: string }; data: Partial<TaskRow> }) => {
        if (where.id !== currentTask.id) return Promise.reject(new Error("task not found"));
        currentTask = { ...currentTask, ...data, updatedAt: new Date() };
        return Promise.resolve(currentTask);
      },
    );
    prismaMocks.taskUpdateMany.mockImplementation(
      ({
        where,
        data,
      }: {
        where: { id: string; claimedByAgentId?: null; claimedByUserId?: null };
        data: Partial<TaskRow>;
      }) => {
        if (where.id !== currentTask.id) return Promise.resolve({ count: 0 });
        if (
          where.claimedByAgentId === null &&
          (currentTask.claimedByAgentId !== null || currentTask.claimedByUserId !== null)
        ) {
          return Promise.resolve({ count: 0 });
        }
        currentTask = { ...currentTask, ...data, updatedAt: new Date() };
        return Promise.resolve({ count: 1 });
      },
    );
  }

  // ── Step 1–3 are represented by the initial state of currentTask ────────
  // The "webhook merge to review" transition is simulated by starting
  // currentTask with status="review" and claimedByAgentId="agent-author"
  // (no reviewClaimedByAgentId). This mirrors what happens when the GitHub
  // webhook fires and the server transitions the task from in_progress to
  // review without assigning a review claim.

  it("step 4: task_finish { outcome: approve } → 200 / status=done", async () => {
    const project = makeProject({
      id: PROJECT_ID,
      soloMode: false,
      requireDistinctReviewer: false,
      confidenceThreshold: 0,
    });
    setupMocks(project);
    const app = makeApp(AGENT_AUTHOR);

    const res = await measure<{ kind: string; task: TaskRow; outcome: string }>(
      app.request(`/tasks/${TASK_ID}/finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome: "approve",
          result: "Looks good, self-approved after webhook merge.",
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("review");
    expect(res.body.outcome).toBe("approve");
    expect(currentTask.status).toBe("done");
    expect(currentTask.claimedByAgentId).toBeNull();
    expect(currentTask.reviewClaimedByAgentId).toBeNull();
  });

  it("outcome: request_changes → back to in_progress, work claim retained", async () => {
    const project = makeProject({
      id: PROJECT_ID,
      soloMode: false,
      requireDistinctReviewer: false,
      confidenceThreshold: 0,
    });
    setupMocks(project);
    const app = makeApp(AGENT_AUTHOR);

    const res = await measure<{ kind: string; task: TaskRow; outcome: string }>(
      app.request(`/tasks/${TASK_ID}/finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome: "request_changes",
          result: "Needs another look.",
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("review");
    expect(res.body.outcome).toBe("request_changes");
    expect(currentTask.status).toBe("in_progress");
    // Work claim must be retained after request_changes.
    expect(currentTask.claimedByAgentId).toBe("agent-author");
  });

  it("requireDistinctReviewer=true → 403 (cannot self-approve)", async () => {
    const project = makeProject({
      id: PROJECT_ID,
      soloMode: false,
      requireDistinctReviewer: true,
      confidenceThreshold: 0,
    });
    setupMocks(project);
    const app = makeApp(AGENT_AUTHOR);

    const res = await measure<{ error: string; message: string }>(
      app.request(`/tasks/${TASK_ID}/finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome: "approve",
        }),
      }),
    );

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/distinct reviewer/i);
  });

  it("missing outcome on review-state task → descriptive 400", async () => {
    const project = makeProject({
      id: PROJECT_ID,
      soloMode: false,
      requireDistinctReviewer: false,
      confidenceThreshold: 0,
    });
    setupMocks(project);
    const app = makeApp(AGENT_AUTHOR);

    const res = await measure<{ error: string; message: string }>(
      app.request(`/tasks/${TASK_ID}/finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          result: "No outcome provided.",
        }),
      }),
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
    // Must explain that an outcome is required to finalize a review-state task.
    expect(res.body.message).toMatch(/outcome/i);
    expect(res.body.message).toMatch(/review/i);
    // Must NOT say "Work finish requires a work state" (the old misleading message).
    expect(res.body.message).not.toMatch(/work state/i);
  });

  it("concurrent reviewer holds claim → 409 reviewer_conflict (not DR-message)", async () => {
    const project = makeProject({
      id: PROJECT_ID,
      soloMode: false,
      requireDistinctReviewer: false,
      confidenceThreshold: 0,
    });
    setupMocks(project);

    // Simulate another agent having already claimed the review slot.
    currentTask = {
      ...currentTask,
      reviewClaimedByAgentId: "agent-reviewer",
      reviewClaimedAt: new Date("2026-06-15T10:30:00Z"),
    };

    const app = makeApp(AGENT_AUTHOR);

    const res = await measure<{ error: string; message: string }>(
      app.request(`/tasks/${TASK_ID}/finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome: "approve" }),
      }),
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("reviewer_conflict");
    expect(res.body.message).toMatch(/reviewer/i);
    // Must NOT say "distinct reviewer required" — that message belongs to DR projects.
    expect(res.body.message).not.toMatch(/project requires a distinct reviewer/i);
    // Must NOT say "work state" — we should not fall through to the work-finish branch.
    expect(res.body.message).not.toMatch(/work state/i);
  });

  it("mutation-confirm: removing reviewer-claim check allows silent clobber (guard is load-bearing)", async () => {
    // This test verifies the guard is meaningful: a task with an active reviewer
    // claim MUST be rejected 409, not silently approved. Without the
    // !task.reviewClaimedByAgentId check in the self-approve condition, the
    // self-approve branch would fire and overwrite the reviewer's claim.
    const project = makeProject({
      id: PROJECT_ID,
      soloMode: false,
      requireDistinctReviewer: false,
      confidenceThreshold: 0,
    });
    setupMocks(project);
    const app = makeApp(AGENT_AUTHOR);

    // Task WITHOUT a reviewer claim → self-approve is allowed (200).
    const resAllowed = await measure<{ kind: string }>(
      app.request(`/tasks/${TASK_ID}/finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome: "approve" }),
      }),
    );
    expect(resAllowed.status).toBe(200);

    // Reset and inject a reviewer claim → self-approve must be blocked (409).
    setupMocks(project);
    currentTask = {
      ...currentTask,
      reviewClaimedByAgentId: "agent-reviewer",
      reviewClaimedAt: new Date("2026-06-15T10:30:00Z"),
    };

    const resBlocked = await measure<{ error: string }>(
      app.request(`/tasks/${TASK_ID}/finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome: "approve" }),
      }),
    );
    // The guard must fire here. If it didn't, this would be 200.
    expect(resBlocked.status).toBe(409);
    expect(resBlocked.body.error).toBe("reviewer_conflict");
  });

  it("soloMode=true (AUTONOMOUS governanceMode) → 200 self-approve", async () => {
    const project = makeProject({
      id: PROJECT_ID,
      soloMode: true,
      requireDistinctReviewer: false,
      governanceMode: "AUTONOMOUS",
      confidenceThreshold: 0,
    });
    setupMocks(project);
    const app = makeApp(AGENT_AUTHOR);

    const res = await measure<{ kind: string; task: TaskRow; outcome: string }>(
      app.request(`/tasks/${TASK_ID}/finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome: "approve",
          result: "Self-approved on AUTONOMOUS project.",
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("review");
    expect(res.body.outcome).toBe("approve");
    expect(currentTask.status).toBe("done");
    expect(currentTask.claimedByAgentId).toBeNull();
  });

  it("autoMerge=true → 200 with autoMergeSha (github-merge mock called)", async () => {
    const project = makeProject({
      id: PROJECT_ID,
      soloMode: false,
      requireDistinctReviewer: false,
      confidenceThreshold: 0,
    });
    setupMocks(project);
    const app = makeApp(AGENT_AUTHOR);

    const res = await measure<{
      kind: string;
      task: TaskRow;
      outcome: string;
      autoMergeSha?: string;
    }>(
      app.request(`/tasks/${TASK_ID}/finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome: "approve",
          autoMerge: true,
          result: "Self-approved with autoMerge.",
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("review");
    expect(res.body.outcome).toBe("approve");
    // autoMergeSha must be present and match the mock's return value.
    expect(res.body.autoMergeSha).toBe("aabbccddeeff00112233445566778899aabbccdd");
    expect(currentTask.status).toBe("done");
    expect(currentTask.autoMergeSha).toBe("aabbccddeeff00112233445566778899aabbccdd");
    // The github-merge mock must have been invoked exactly once.
    expect(mergeMock).toHaveBeenCalledTimes(1);
  });
});
