/**
 * Workflow round-trip suite — non-soloMode + distinct-reviewer path.
 *
 * Counterpart to `agent-roundtrip-solo.test.ts`. Same fixture pattern, same
 * BYTES_BUDGET source of truth; exercises the canonical agent flow when the
 * project enforces a distinct reviewer (soloMode: false, requireDistinctReviewer:
 * true).
 *
 * Round-trip exercised here:
 *   1. (author) task_create    → POST /projects/:projectId/tasks
 *   2. (author) task_start     → POST /tasks/:id/start         (open → in_progress)
 *   3. (author) task_submit_pr → POST /tasks/:id/submit-pr
 *   4. (author) task_finish    → POST /tasks/:id/finish        (→ review)
 *   5. (reviewer) task_start   → POST /tasks/:id/start         (review-claim)
 *   6. (reviewer) task_finish  → POST /tasks/:id/finish        (outcome=approve, autoMerge)
 *
 * See `./fixtures.ts` for the calibration and budget rationale.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";
import {
  BYTES_BUDGET,
  makeProject,
  makeTask,
  measure,
  type TaskRow,
} from "./fixtures.js";

const PROJECT_ID = "33333333-3333-3333-3333-333333333333";
const TASK_ID = "44444444-4444-4444-4444-444444444444";

const prismaMocks = vi.hoisted(() => ({
  taskCreate: vi.fn(),
  taskFindUnique: vi.fn(),
  taskFindFirst: vi.fn().mockResolvedValue(null),
  taskFindMany: vi.fn().mockResolvedValue([]),
  taskUpdate: vi.fn(),
  signalFindFirst: vi.fn(),
  signalUpdate: vi.fn(),
  signalUpdateMany: vi.fn().mockResolvedValue({ count: 0 }),
  workflowFindFirst: vi.fn().mockResolvedValue(null),
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

const AGENT_AUTHOR = {
  type: "agent" as const,
  tokenId: "agent-author",
  teamId: "team-1",
  userId: "user-author",
  scopes: ["tasks:read", "tasks:create", "tasks:claim", "tasks:transition"],
} satisfies Actor;
const AGENT_REVIEWER = {
  type: "agent" as const,
  tokenId: "agent-reviewer",
  teamId: "team-1",
  userId: "user-reviewer",
  // Minimum reviewer scopes. `github:pr_merge` is required for the
  // task_finish autoMerge branch (re-checked at routes/tasks.ts:1802).
  scopes: ["tasks:read", "tasks:claim", "tasks:transition", "github:pr_merge"],
} satisfies Actor;

function makeApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", taskRouter);
  return app;
}

describe("workflow round-trip — distinct-reviewer path (task 47cc3e43)", () => {
  let currentTask: TaskRow;

  beforeEach(() => {
    vi.clearAllMocks();
    mergeMock.mockResolvedValue({
      ok: true,
      sha: "cafef00dcafef00dcafef00dcafef00dcafef00d",
      alreadyMerged: false,
    });
    // Reset default mocks that vi.clearAllMocks blew away.
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
    groundingMocks.deriveDebugFlavor.mockResolvedValue({
      isFresh: false,
      mergedMetadata: null,
    });

    const project = makeProject({
      id: PROJECT_ID,
      soloMode: false,
      requireDistinctReviewer: true,
    });
    currentTask = makeTask({ id: TASK_ID, projectId: PROJECT_ID }, project);

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
    prismaMocks.taskCreate.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => {
        currentTask = {
          ...currentTask,
          title: (data.title as string) ?? currentTask.title,
          description: (data.description as string | null) ?? currentTask.description,
          priority: (data.priority as string) ?? currentTask.priority,
          labels: (data.labels as string[]) ?? currentTask.labels,
          createdByAgentId: (data.createdByAgentId as string | null) ?? currentTask.createdByAgentId,
        };
        return Promise.resolve(currentTask);
      },
    );
  });

  it("completes the canonical distinct-reviewer round-trip inside per-verb + aggregate byte budgets", async () => {
    const authorApp = makeApp(AGENT_AUTHOR);
    const reviewerApp = makeApp(AGENT_REVIEWER);
    let aggregateBytes = 0;

    // ── Step 1: (author) task_create ───────────────────────────────────
    const createRes = await measure<{ task: TaskRow }>(
      authorApp.request(`/projects/${PROJECT_ID}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Round-trip with reviewer",
          description: "Fixture for the non-soloMode round-trip suite.",
          priority: "MEDIUM",
          labels: ["test", "round-trip"],
        }),
      }),
    );
    expect(createRes.status).toBe(201);
    expect(createRes.byteLength).toBeLessThan(BYTES_BUDGET.taskCreate);
    aggregateBytes += createRes.byteLength;

    // ── Step 2: (author) task_start ─────────────────────────────────────
    const startRes = await measure<{ task: TaskRow }>(
      authorApp.request(`/tasks/${TASK_ID}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(startRes.status).toBe(200);
    expect(startRes.byteLength).toBeLessThan(BYTES_BUDGET.taskStart);
    expect(currentTask.status).toBe("in_progress");
    expect(currentTask.claimedByAgentId).toBe(AGENT_AUTHOR.tokenId);
    aggregateBytes += startRes.byteLength;

    // ── Step 3: (author) task_submit_pr ─────────────────────────────────
    const submitPrRes = await measure<{ task: TaskRow }>(
      authorApp.request(`/tasks/${TASK_ID}/submit-pr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchName: "feat/round-trip-distinct-reviewer",
          prUrl: "https://github.com/LanNguyenSi/fixture-project/pull/43",
          prNumber: 43,
        }),
      }),
    );
    expect(submitPrRes.status).toBe(200);
    expect(submitPrRes.byteLength).toBeLessThan(BYTES_BUDGET.taskSubmitPr);
    expect(currentTask.branchName).toBe("feat/round-trip-distinct-reviewer");
    aggregateBytes += submitPrRes.byteLength;

    // ── Step 4: (author) task_finish → review ───────────────────────────
    // Non-soloMode: task_finish without autoMerge transitions to review,
    // keeping the work claim so the reviewer can take over.
    const finishRes = await measure<{ task: TaskRow }>(
      authorApp.request(`/tasks/${TASK_ID}/finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          result: "Ready for review.",
        }),
      }),
    );
    expect(finishRes.status).toBe(200);
    expect(finishRes.byteLength).toBeLessThan(BYTES_BUDGET.taskFinish);
    expect(currentTask.status).toBe("review");
    aggregateBytes += finishRes.byteLength;

    // ── Step 5: (reviewer) task_start → review-claim ────────────────────
    // Real claim flow: at this point reviewClaimedByAgentId is null and
    // the route should transition it to AGENT_REVIEWER.tokenId. f3e35ba8
    // split `checkDistinctReviewerGate` into the pure-identity gate (used
    // here) and `checkReviewApprovalGate` (used at approval-time), so the
    // claim no longer false-rejects on `no_review_lock`.
    prismaMocks.agentTokenFindUnique.mockResolvedValue({
      id: "agent-reviewer",
      name: "Reviewer",
    });
    const reviewClaimRes = await measure<{ task: TaskRow }>(
      reviewerApp.request(`/tasks/${TASK_ID}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(reviewClaimRes.status).toBe(200);
    expect(reviewClaimRes.byteLength).toBeLessThan(BYTES_BUDGET.taskStart);
    expect(currentTask.reviewClaimedByAgentId).toBe(AGENT_REVIEWER.tokenId);
    aggregateBytes += reviewClaimRes.byteLength;

    // ── Step 6: (reviewer) task_finish → approve + autoMerge ────────────
    const approveRes = await measure<{ task: TaskRow }>(
      reviewerApp.request(`/tasks/${TASK_ID}/finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome: "approve",
          autoMerge: true,
          mergeMethod: "squash",
          result: "LGTM.",
        }),
      }),
    );
    expect(approveRes.status).toBe(200);
    expect(approveRes.byteLength).toBeLessThan(BYTES_BUDGET.taskFinishAutoMerge);
    expect(currentTask.status).toBe("done");
    expect(mergeMock).toHaveBeenCalledOnce();
    aggregateBytes += approveRes.byteLength;

    // ── Aggregate budget for the whole round-trip ───────────────────────
    expect(aggregateBytes).toBeLessThan(BYTES_BUDGET.roundtripDistinctReviewer);
  });

  it("non-soloMode aggregate budget is more permissive than soloMode (extra review-claim step)", () => {
    expect(BYTES_BUDGET.roundtripDistinctReviewer).toBeGreaterThan(
      BYTES_BUDGET.roundtripSolo,
    );
  });
});
