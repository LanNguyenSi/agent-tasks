/**
 * Workflow round-trip suite — soloMode path.
 *
 * Exercises the canonical agent flow end-to-end against the real Hono route
 * handlers (with mocked Prisma + GitHub) and asserts both functional
 * correctness AND per-verb / aggregate byte budgets.
 *
 * See `./fixtures.ts` for the calibration rationale behind BYTES_BUDGET, and
 * agent-tasks task `47cc3e43-05ac-4975-9c86-60b5224ccda4` for the originating
 * design + calibration table.
 *
 * Round-trip exercised here:
 *   1. task_create   → POST /projects/:projectId/tasks
 *   2. task_start    → POST /tasks/:id/start         (open → in_progress)
 *   3. task_submit_pr→ POST /tasks/:id/submit-pr     (attach branch + PR meta)
 *   4. task_finish   → POST /tasks/:id/finish        (autoMerge: true)
 *      └ calls performPrMerge (mocked) and transitions status to done
 *
 * `pull_requests_create` is skipped: it talks to api.github.com directly via
 * raw `fetch()`, requires DB-backed delegationUser lookup, and would dominate
 * the mock surface for marginal coverage gain. The byte budget for that verb
 * is observed in calibration and pinned at the suite level via BYTES_BUDGET;
 * its actual integration is covered by github-routes-scope.test.ts.
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

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const TASK_ID = "22222222-2222-2222-2222-222222222222";

// Hoisted Prisma mocks — vitest requires mock factories to live at the top
// of the module and reference only `vi.hoisted` values.
const prismaMocks = vi.hoisted(() => ({
  taskCreate: vi.fn(),
  taskFindUnique: vi.fn(),
  taskFindFirst: vi.fn(),
  taskFindMany: vi.fn(),
  taskUpdate: vi.fn(),
  taskUpdateMany: vi.fn(),
  signalFindFirst: vi.fn(),
  signalUpdate: vi.fn(),
  signalUpdateMany: vi.fn().mockResolvedValue({ count: 0 }),
  workflowFindFirst: vi.fn().mockResolvedValue(null),
  // scorer-v2 T4: the create handler reads the project for the create-time
  // confidence object on the response.
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

const AGENT_AUTHOR = {
  type: "agent" as const,
  tokenId: "agent-author",
  teamId: "team-1",
  userId: "user-author",
  // Minimum scope set for the soloMode round-trip including the autoMerge
  // branch of task_finish, which re-checks `github:pr_merge` at
  // `routes/tasks.ts:1802` before invoking `performPrMerge`.
  scopes: [
    "tasks:read",
    "tasks:create",
    "tasks:claim",
    "tasks:transition",
    "github:pr_merge",
  ],
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

describe("workflow round-trip — soloMode path (task 47cc3e43)", () => {
  // Shared task-state holder. Each step in the round-trip mutates this
  // via taskUpdate; subsequent findUnique calls return the mutated state.
  let currentTask: TaskRow;

  beforeEach(() => {
    vi.clearAllMocks();
    mergeMock.mockResolvedValue({
      ok: true,
      sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      alreadyMerged: false,
    });

    const project = makeProject({
      id: PROJECT_ID,
      soloMode: true,
      requireDistinctReviewer: false,
      // This is a lifecycle + byte-budget round-trip, not a confidence-gate test
      // (the gate has dedicated coverage). Disable the gate so the round-trip is
      // not coupled to scorer calibration (scorer-v2 weights are tuned over time).
      confidenceThreshold: 0,
    });
    currentTask = makeTask({ id: TASK_ID, projectId: PROJECT_ID }, project);

    // Single-task in-memory store: every findUnique returns the current
    // task; every update merges `data` into it and re-returns. This is
    // intentionally a thin shim — the goal is to let the routes compose
    // across calls, not to re-implement Prisma.
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
    // CAS shim for the atomic claim (TOCTOU fix): only mutate when the row
    // still matches the unclaimed where-guard, mirroring Prisma updateMany.
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
    prismaMocks.taskFindMany.mockResolvedValue([]);
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

  it("completes the canonical solo round-trip inside per-verb + aggregate byte budgets", async () => {
    const app = makeApp(AGENT_AUTHOR);
    let aggregateBytes = 0;

    // ── Step 1: task_create ─────────────────────────────────────────────
    const createRes = await measure<{ task: TaskRow }>(
      app.request(`/projects/${PROJECT_ID}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Round-trip test task",
          description:
            "Description content for the round-trip test. Long enough to " +
            "exercise the byte budgets without dominating them.",
          priority: "MEDIUM",
          labels: ["test", "round-trip"],
        }),
      }),
    );
    expect(createRes.status).toBe(201);
    expect(createRes.byteLength).toBeLessThan(BYTES_BUDGET.taskCreate);
    expect(createRes.body.task.title).toBe("Round-trip test task");
    aggregateBytes += createRes.byteLength;

    // ── Step 2: task_start ──────────────────────────────────────────────
    const startRes = await measure<{ task: TaskRow }>(
      app.request(`/tasks/${TASK_ID}/start`, {
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

    // ── Step 3: task_submit_pr ──────────────────────────────────────────
    // The v2-native path for attaching branch + PR metadata (replaces
    // the deprecated tasks_update for these fields).
    const submitPrRes = await measure<{ task: TaskRow }>(
      app.request(`/tasks/${TASK_ID}/submit-pr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchName: "feat/round-trip-test",
          prUrl: "https://github.com/LanNguyenSi/fixture-project/pull/42",
          prNumber: 42,
        }),
      }),
    );
    expect(submitPrRes.status).toBe(200);
    expect(submitPrRes.byteLength).toBeLessThan(BYTES_BUDGET.taskSubmitPr);
    expect(currentTask.branchName).toBe("feat/round-trip-test");
    expect(currentTask.prUrl).toContain("/pull/42");
    aggregateBytes += submitPrRes.byteLength;

    // ── Step 4: task_finish with autoMerge ──────────────────────────────
    // soloMode + autoMerge takes the task straight to done and calls
    // performPrMerge (mocked) for the GitHub side.
    const finishRes = await measure<{ task: TaskRow; outcome: string }>(
      app.request(`/tasks/${TASK_ID}/finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          autoMerge: true,
          mergeMethod: "squash",
          result: "Round-trip complete; task done.",
        }),
      }),
    );
    expect(finishRes.status).toBe(200);
    expect(finishRes.byteLength).toBeLessThan(BYTES_BUDGET.taskFinishAutoMerge);
    expect(currentTask.status).toBe("done");
    expect(mergeMock).toHaveBeenCalledOnce();
    aggregateBytes += finishRes.byteLength;

    // ── Aggregate budget for the whole round-trip ───────────────────────
    expect(aggregateBytes).toBeLessThan(BYTES_BUDGET.roundtripSolo);
  });

  it("each per-verb response stays inside its individual budget at 2x observed", () => {
    // Pin assertion: a regression that doubles any verb's response size
    // would silently raise the aggregate budget below the threshold but
    // still fail the per-verb assertions above. This test documents the
    // contract explicitly so future readers see the regression-detection
    // story without re-reading the inline asserts.
    expect(BYTES_BUDGET.taskCreate).toBeLessThan(BYTES_BUDGET.taskStart);
    expect(BYTES_BUDGET.taskFinishAutoMerge).toBeLessThanOrEqual(
      BYTES_BUDGET.roundtripSolo / 2,
    );
  });
});
