/**
 * Route tests for the v2 MCP verb-oriented task endpoints
 * (`/tasks/pickup`, `/tasks/:id/start`, `/tasks/:id/finish`, `/tasks/:id/abandon`).
 *
 * The taskRouter is mounted on a throw-away Hono app with a pre-middleware
 * that injects a test actor via `c.set("actor", ...)`. Prisma and the
 * collaborating services are mocked with `vi.hoisted` so we can inspect the
 * payload of every call without standing up a real database.
 *
 * Per the project feedback memory: we deliberately avoid
 * `mockResolvedValueOnce` queues — `vi.clearAllMocks` does not drain them and
 * that has caused cross-test bleed before. Every test sets its own return
 * values explicitly with `mockResolvedValue(...)` or `mockImplementation(...)`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const prismaMocks = vi.hoisted(() => ({
  taskFindFirst: vi.fn(),
  taskFindUnique: vi.fn(),
  taskFindMany: vi.fn(),
  taskUpdate: vi.fn(),
  signalFindFirst: vi.fn(),
  signalUpdate: vi.fn(),
  workflowFindFirst: vi.fn(),
  agentTokenFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: {
      findFirst: prismaMocks.taskFindFirst,
      findUnique: prismaMocks.taskFindUnique,
      findMany: prismaMocks.taskFindMany,
      update: prismaMocks.taskUpdate,
    },
    signal: {
      findFirst: prismaMocks.signalFindFirst,
      update: prismaMocks.signalUpdate,
    },
    workflow: {
      findFirst: prismaMocks.workflowFindFirst,
    },
    agentToken: {
      findUnique: prismaMocks.agentTokenFindUnique,
    },
    user: {
      findUnique: prismaMocks.userFindUnique,
    },
  },
}));

const accessMocks = vi.hoisted(() => ({
  hasProjectAccess: vi.fn().mockResolvedValue(true),
  hasProjectRole: vi.fn().mockResolvedValue(true),
  isProjectAdmin: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../src/services/team-access.js", () => accessMocks);

const signalEmitters = vi.hoisted(() => ({
  emitReviewSignal: vi.fn().mockResolvedValue(undefined),
  emitChangesRequestedSignal: vi.fn().mockResolvedValue(undefined),
  emitTaskApprovedSignal: vi.fn().mockResolvedValue(undefined),
  emitTaskAvailableSignal: vi.fn().mockResolvedValue(undefined),
  emitForceTransitionedSignal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/review-signal.js", () => ({
  emitReviewSignal: signalEmitters.emitReviewSignal,
  emitChangesRequestedSignal: signalEmitters.emitChangesRequestedSignal,
  emitTaskApprovedSignal: signalEmitters.emitTaskApprovedSignal,
}));
vi.mock("../../src/services/task-signal.js", () => ({
  emitTaskAvailableSignal: signalEmitters.emitTaskAvailableSignal,
}));
vi.mock("../../src/services/force-transition-signal.js", () => ({
  emitForceTransitionedSignal: signalEmitters.emitForceTransitionedSignal,
}));

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import { taskRouter } from "../../src/routes/tasks.js";

const AGENT: Actor = {
  type: "agent",
  tokenId: "agent-1",
  teamId: "team-1",
  scopes: ["tasks:read", "tasks:claim", "tasks:transition", "tasks:create"],
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

const baseTask = {
  id: "task-1",
  projectId: "proj-1",
  title: "Fix thing",
  description: "do the thing",
  status: "open",
  priority: "MEDIUM",
  workflowId: null,
  workflow: null,
  templateData: null,
  createdByAgentId: "agent-author",
  createdByUserId: null,
  claimedByAgentId: null,
  claimedByUserId: null,
  claimedAt: null,
  reviewClaimedByAgentId: null,
  reviewClaimedByUserId: null,
  reviewClaimedAt: null,
  // Default-workflow `in_progress → review` and `→ done` transitions require
  // `branchPresent`, so every work-finish fixture needs a branch. Tests that
  // want to exercise a gate-fail override this back to null explicitly.
  branchName: "feat/test-branch",
  prUrl: null,
  prNumber: null,
  result: null,
  project: {
    id: "proj-1",
    name: "Agent Tasks",
    slug: "agent-tasks",
    teamId: "team-1",
    githubRepo: "acme/thing",
    confidenceThreshold: 0,
    taskTemplate: null,
    requireDistinctReviewer: false,
  },
  attachments: [],
  comments: [],
  claimedByUser: null,
  claimedByAgent: null,
  blockedBy: [],
  blocks: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  accessMocks.hasProjectAccess.mockResolvedValue(true);
  prismaMocks.taskUpdate.mockImplementation(
    ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
      Promise.resolve({ ...baseTask, id: where.id, ...data }),
  );
});

// ── /tasks/pickup ────────────────────────────────────────────────────────────

describe("POST /tasks/pickup", () => {
  it("returns 409 already_claimed when the agent already holds an active claim", async () => {
    prismaMocks.taskFindFirst.mockResolvedValueOnce({
      id: "other-task",
      title: "Other",
      claimedByAgentId: "agent-1",
      reviewClaimedByAgentId: null,
    });

    const res = await makeApp().request("/tasks/pickup", { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; activeClaim: { taskId: string; role: string } };
    expect(body.error).toBe("already_claimed");
    expect(body.activeClaim).toEqual({ taskId: "other-task", title: "Other", role: "author" });
    expect(prismaMocks.taskFindMany).not.toHaveBeenCalled();
  });

  it("delivers a pending signal, acks it atomically, and does not look at tasks", async () => {
    prismaMocks.taskFindFirst.mockResolvedValueOnce(null); // hard-limit check
    prismaMocks.signalFindFirst.mockResolvedValueOnce({
      id: "sig-7",
      type: "review_needed",
      recipientAgentId: "agent-1",
      acknowledgedAt: null,
      createdAt: new Date(),
    });
    prismaMocks.signalUpdate.mockResolvedValueOnce({ id: "sig-7" });

    const res = await makeApp().request("/tasks/pickup", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; signal: { id: string } };
    expect(body.kind).toBe("signal");
    expect(body.signal.id).toBe("sig-7");
    expect(prismaMocks.signalUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "sig-7" }, data: expect.objectContaining({ acknowledgedAt: expect.any(Date) }) }),
    );
  });

  it("review pickup filters out tasks authored by the same agent (distinct-reviewer)", async () => {
    prismaMocks.taskFindFirst
      .mockResolvedValueOnce(null) // hard-limit
      .mockResolvedValueOnce({ ...baseTask, status: "review" }) // review pickup hit
      .mockResolvedValueOnce(null); // work pickup (not reached but safe)
    prismaMocks.signalFindFirst.mockResolvedValueOnce(null);

    const res = await makeApp().request("/tasks/pickup", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe("review");

    // The 2nd findFirst call (review pickup) must include distinct-reviewer filter
    const reviewCall = prismaMocks.taskFindFirst.mock.calls[1]![0];
    expect(reviewCall.where.createdByAgentId).toEqual({ not: "agent-1" });
    expect(reviewCall.where.status).toBe("review");
    expect(reviewCall.where.reviewClaimedByAgentId).toBeNull();
    expect(reviewCall.where.reviewClaimedByUserId).toBeNull();
  });

  it("returns idle when no signals, no review task, no work task", async () => {
    prismaMocks.taskFindFirst.mockResolvedValue(null);
    prismaMocks.signalFindFirst.mockResolvedValue(null);

    const res = await makeApp().request("/tasks/pickup", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe("idle");
  });
});

// ── /tasks/:id/start ─────────────────────────────────────────────────────────

describe("POST /tasks/:id/start", () => {
  it("open task: claims, transitions to in_progress, returns expectedFinishState", async () => {
    prismaMocks.taskFindUnique.mockResolvedValueOnce({ ...baseTask, status: "open" });
    prismaMocks.taskFindFirst.mockResolvedValueOnce(null); // hard-limit ok
    prismaMocks.taskFindMany.mockResolvedValueOnce([]); // no blockers
    prismaMocks.workflowFindFirst.mockResolvedValueOnce(null); // falls back to built-in default

    const res = await makeApp().request("/tasks/task-1/start", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; expectedFinishState: string; task: { status: string; claimedByAgentId: string } };
    expect(body.kind).toBe("work");
    expect(body.expectedFinishState).toBe("review");
    expect(body.task.status).toBe("in_progress");
    expect(body.task.claimedByAgentId).toBe("agent-1");

    const updateCall = prismaMocks.taskUpdate.mock.calls[0]![0];
    expect(updateCall.data).toMatchObject({
      status: "in_progress",
      claimedByAgentId: "agent-1",
      claimedByUserId: null,
    });
  });

  it("rejects when the agent already holds an active claim on a different task", async () => {
    prismaMocks.taskFindUnique.mockResolvedValueOnce({ ...baseTask, status: "open" });
    prismaMocks.taskFindFirst.mockResolvedValueOnce({
      id: "other",
      title: "Other",
      claimedByAgentId: "agent-1",
      reviewClaimedByAgentId: null,
    });

    const res = await makeApp().request("/tasks/task-1/start", { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("already_claimed");
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
  });

  it("review branch: rejects self-review when the agent authored the task", async () => {
    prismaMocks.taskFindUnique.mockResolvedValueOnce({
      ...baseTask,
      status: "review",
      createdByAgentId: "agent-1",
      claimedByAgentId: "agent-1",
    });
    prismaMocks.taskFindFirst.mockResolvedValueOnce(null);

    const res = await makeApp().request("/tasks/task-1/start", { method: "POST" });
    expect(res.status).toBe(403);
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
  });

  it("review branch: sets review claim without touching status", async () => {
    prismaMocks.taskFindUnique.mockResolvedValueOnce({
      ...baseTask,
      status: "review",
      createdByAgentId: "agent-author", // different author
    });
    prismaMocks.taskFindFirst.mockResolvedValueOnce(null);

    const res = await makeApp().request("/tasks/task-1/start", { method: "POST" });
    expect(res.status).toBe(200);
    const updateCall = prismaMocks.taskUpdate.mock.calls[0]![0];
    expect(updateCall.data.reviewClaimedByAgentId).toBe("agent-1");
    expect(updateCall.data.status).toBeUndefined();
  });
});

// ── /tasks/:id/finish ────────────────────────────────────────────────────────

describe("POST /tasks/:id/finish (work claim)", () => {
  it("rejects a malformed prUrl without touching the task", async () => {
    prismaMocks.taskFindUnique.mockResolvedValueOnce({
      ...baseTask,
      status: "in_progress",
      claimedByAgentId: "agent-1",
    });

    const res = await makeApp().request("/tasks/task-1/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prUrl: "https://gitlab.example.com/x/y/-/merge_requests/1" }),
    });
    expect(res.status).toBe(400);
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
  });

  it("work → review: stores prUrl+prNumber, keeps claim, emits review signal", async () => {
    prismaMocks.taskFindUnique.mockResolvedValueOnce({
      ...baseTask,
      status: "in_progress",
      claimedByAgentId: "agent-1",
      workflowId: null,
    });
    prismaMocks.workflowFindFirst.mockResolvedValueOnce(null); // built-in default → review

    const res = await makeApp().request("/tasks/task-1/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prUrl: "https://github.com/acme/thing/pull/42",
        result: "shipped",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { targetStatus: string };
    expect(body.targetStatus).toBe("review");

    const data = prismaMocks.taskUpdate.mock.calls[0]![0].data;
    expect(data.status).toBe("review");
    expect(data.prUrl).toBe("https://github.com/acme/thing/pull/42");
    expect(data.prNumber).toBe(42);
    expect(data.result).toBe("shipped");
    // work claim must stay set so the author can auto-resume on request_changes
    expect(data.claimedByAgentId).toBeUndefined();
    expect(data.claimedByUserId).toBeUndefined();
    expect(data.claimedAt).toBeUndefined();

    expect(signalEmitters.emitReviewSignal).toHaveBeenCalledTimes(1);
  });

  it("work → done: clears work claim when the workflow skips review", async () => {
    prismaMocks.taskFindUnique.mockResolvedValueOnce({
      ...baseTask,
      status: "in_progress",
      claimedByAgentId: "agent-1",
    });
    // Workflow only has in_progress → done
    prismaMocks.workflowFindFirst.mockResolvedValueOnce({
      definition: {
        initialState: "open",
        states: [],
        transitions: [{ from: "in_progress", to: "done" }],
      },
    });

    const res = await makeApp().request("/tasks/task-1/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const data = prismaMocks.taskUpdate.mock.calls[0]![0].data;
    expect(data.status).toBe("done");
    expect(data.claimedByAgentId).toBeNull();
    expect(data.claimedByUserId).toBeNull();
    expect(data.claimedAt).toBeNull();
    expect(signalEmitters.emitReviewSignal).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller does not hold any claim on the task", async () => {
    prismaMocks.taskFindUnique.mockResolvedValueOnce({
      ...baseTask,
      status: "in_progress",
      claimedByAgentId: "someone-else",
    });

    const res = await makeApp().request("/tasks/task-1/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
  });
});

describe("POST /tasks/:id/finish — gate enforcement (regression)", () => {
  // Regression coverage for the pre-existing v2 bug where task_finish
  // silently bypassed every transition-rule gate. The default workflow
  // requires branchPresent + prPresent on in_progress→review and →done,
  // so these tests assert the handler rejects finishes that would have
  // been silently accepted before.

  it("rejects with 422 precondition_failed when branchName is missing (default workflow)", async () => {
    prismaMocks.taskFindUnique.mockResolvedValueOnce({
      ...baseTask,
      status: "in_progress",
      claimedByAgentId: "agent-1",
      branchName: null, // explicit gate miss
    });
    prismaMocks.workflowFindFirst.mockResolvedValueOnce(null);

    const res = await makeApp().request("/tasks/task-1/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prUrl: "https://github.com/acme/thing/pull/42" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string;
      failed: { rule: string }[];
      canForce: boolean;
    };
    expect(body.error).toBe("precondition_failed");
    expect(body.failed.map((f) => f.rule)).toContain("branchPresent");
    expect(body.canForce).toBe(false); // v2 has no force escape hatch
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
  });

  it("rejects with 422 when prUrl is missing and not provided in payload (default workflow)", async () => {
    prismaMocks.taskFindUnique.mockResolvedValueOnce({
      ...baseTask,
      status: "in_progress",
      claimedByAgentId: "agent-1",
      branchName: "feat/x",
      prUrl: null,
      prNumber: null,
    });
    prismaMocks.workflowFindFirst.mockResolvedValueOnce(null);

    const res = await makeApp().request("/tasks/task-1/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { failed: { rule: string }[] };
    expect(body.failed.map((f) => f.rule)).toContain("prPresent");
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
  });

  it("accepts the payload prUrl as an atomic submit + finish (merged gate context)", async () => {
    prismaMocks.taskFindUnique.mockResolvedValueOnce({
      ...baseTask,
      status: "in_progress",
      claimedByAgentId: "agent-1",
      branchName: "feat/x",
      prUrl: null,
      prNumber: null,
    });
    prismaMocks.workflowFindFirst.mockResolvedValueOnce(null);

    const res = await makeApp().request("/tasks/task-1/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prUrl: "https://github.com/acme/thing/pull/42",
      }),
    });
    expect(res.status).toBe(200);
    const data = prismaMocks.taskUpdate.mock.calls[0]![0].data;
    expect(data.prUrl).toBe("https://github.com/acme/thing/pull/42");
    expect(data.prNumber).toBe(42);
  });

  it("skips gate eval and passes when workflow has no requires on the target transition", async () => {
    prismaMocks.taskFindUnique.mockResolvedValueOnce({
      ...baseTask,
      status: "in_progress",
      claimedByAgentId: "agent-1",
      branchName: null, // would fail branchPresent on the default workflow
      prUrl: null,
      prNumber: null,
    });
    // Custom workflow that omits gates entirely
    prismaMocks.workflowFindFirst.mockResolvedValueOnce({
      definition: {
        initialState: "open",
        states: [],
        transitions: [{ from: "in_progress", to: "done" }],
      },
    });

    const res = await makeApp().request("/tasks/task-1/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const data = prismaMocks.taskUpdate.mock.calls[0]![0].data;
    expect(data.status).toBe("done");
  });

  it("returns a multi-rule failed array when several gates miss at once", async () => {
    prismaMocks.taskFindUnique.mockResolvedValueOnce({
      ...baseTask,
      status: "in_progress",
      claimedByAgentId: "agent-1",
      branchName: null,
      prUrl: null,
      prNumber: null,
    });
    prismaMocks.workflowFindFirst.mockResolvedValueOnce(null);

    const res = await makeApp().request("/tasks/task-1/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { failed: { rule: string }[] };
    const failed = body.failed.map((f) => f.rule);
    expect(failed).toContain("branchPresent");
    expect(failed).toContain("prPresent");
  });

  it("evaluates the review-finish path against the same gate evaluator", async () => {
    // Custom workflow that requires prPresent on review → done. Set both
    // claims (work + review) so the caller's review claim is active.
    prismaMocks.taskFindUnique.mockResolvedValueOnce({
      ...baseTask,
      status: "review",
      claimedByAgentId: "agent-author",
      reviewClaimedByAgentId: "agent-1",
      branchName: "feat/x",
      prUrl: null,
      prNumber: null,
      workflowId: "wf-1",
      workflow: {
        definition: {
          initialState: "open",
          states: [],
          transitions: [
            { from: "review", to: "done", requires: ["prPresent"] },
            { from: "review", to: "in_progress" },
          ],
        },
      },
    });
    prismaMocks.agentTokenFindUnique.mockResolvedValueOnce({ name: "Reviewer" });

    const res = await makeApp().request("/tasks/task-1/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "approve" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { failed: { rule: string }[] };
    expect(body.failed.map((f) => f.rule)).toContain("prPresent");
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
  });
});

describe("POST /tasks/:id/finish (review claim)", () => {
  it("approve: clears both claims and emits task_approved", async () => {
    prismaMocks.taskFindUnique.mockResolvedValueOnce({
      ...baseTask,
      status: "review",
      claimedByAgentId: "agent-author",
      reviewClaimedByAgentId: "agent-1",
    });
    prismaMocks.agentTokenFindUnique.mockResolvedValueOnce({ name: "Reviewer" });

    const res = await makeApp().request("/tasks/task-1/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "approve", result: "lgtm" }),
    });
    expect(res.status).toBe(200);
    const data = prismaMocks.taskUpdate.mock.calls[0]![0].data;
    expect(data.status).toBe("done");
    expect(data.reviewClaimedByAgentId).toBeNull();
    expect(data.claimedByAgentId).toBeNull();
    expect(data.claimedByUserId).toBeNull();
    expect(signalEmitters.emitTaskApprovedSignal).toHaveBeenCalledTimes(1);
    expect(signalEmitters.emitChangesRequestedSignal).not.toHaveBeenCalled();
  });

  it("request_changes: keeps work claim, clears review claim, emits signal", async () => {
    prismaMocks.taskFindUnique.mockResolvedValueOnce({
      ...baseTask,
      status: "review",
      claimedByAgentId: "agent-author",
      reviewClaimedByAgentId: "agent-1",
    });
    prismaMocks.agentTokenFindUnique.mockResolvedValueOnce({ name: "Reviewer" });

    const res = await makeApp().request("/tasks/task-1/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "request_changes", result: "pls fix" }),
    });
    expect(res.status).toBe(200);
    const data = prismaMocks.taskUpdate.mock.calls[0]![0].data;
    expect(data.status).toBe("in_progress");
    expect(data.reviewClaimedByAgentId).toBeNull();
    // work claim must NOT be cleared — author auto-resumes
    expect(data.claimedByAgentId).toBeUndefined();
    expect(data.claimedByUserId).toBeUndefined();
    expect(signalEmitters.emitChangesRequestedSignal).toHaveBeenCalledTimes(1);
    expect(signalEmitters.emitTaskApprovedSignal).not.toHaveBeenCalled();
  });

  it("rejects a review-outcome body without outcome", async () => {
    prismaMocks.taskFindUnique.mockResolvedValueOnce({
      ...baseTask,
      status: "review",
      reviewClaimedByAgentId: "agent-1",
    });

    const res = await makeApp().request("/tasks/task-1/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
  });
});

// ── /tasks/:id/abandon ───────────────────────────────────────────────────────

describe("POST /tasks/:id/abandon", () => {
  it("work claim on in_progress task: clears claim and resets status to open", async () => {
    prismaMocks.taskFindUnique.mockResolvedValueOnce({
      ...baseTask,
      status: "in_progress",
      claimedByAgentId: "agent-1",
    });

    const res = await makeApp().request("/tasks/task-1/abandon", { method: "POST" });
    expect(res.status).toBe(200);
    const data = prismaMocks.taskUpdate.mock.calls[0]![0].data;
    expect(data.status).toBe("open");
    expect(data.claimedByAgentId).toBeNull();
    expect(data.claimedAt).toBeNull();
  });

  it("review claim: clears review claim only, does not touch status", async () => {
    prismaMocks.taskFindUnique.mockResolvedValueOnce({
      ...baseTask,
      status: "review",
      claimedByAgentId: "agent-author",
      reviewClaimedByAgentId: "agent-1",
    });

    const res = await makeApp().request("/tasks/task-1/abandon", { method: "POST" });
    expect(res.status).toBe(200);
    const data = prismaMocks.taskUpdate.mock.calls[0]![0].data;
    expect(data.reviewClaimedByAgentId).toBeNull();
    expect(data.status).toBeUndefined();
    expect(data.claimedByAgentId).toBeUndefined();
  });

  it("returns 403 when caller does not hold any claim", async () => {
    prismaMocks.taskFindUnique.mockResolvedValueOnce({
      ...baseTask,
      status: "in_progress",
      claimedByAgentId: "someone-else",
    });

    const res = await makeApp().request("/tasks/task-1/abandon", { method: "POST" });
    expect(res.status).toBe(403);
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
  });

  it("rejects abandoning a work claim while task is in review (orphan prevention)", async () => {
    prismaMocks.taskFindUnique.mockResolvedValueOnce({
      ...baseTask,
      status: "review",
      claimedByAgentId: "agent-1", // caller holds work claim
      reviewClaimedByAgentId: null, // but NOT the review claim
    });

    const res = await makeApp().request("/tasks/task-1/abandon", { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_state");
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
  });
});

describe("POST /tasks/:id/finish — prUrl regex hardening", () => {
  const inProgressTask = {
    ...baseTask,
    status: "in_progress",
    claimedByAgentId: "agent-1",
  };

  async function postPrUrl(url: string) {
    prismaMocks.taskFindUnique.mockResolvedValueOnce(inProgressTask);
    prismaMocks.workflowFindFirst.mockResolvedValueOnce(null);
    return makeApp().request("/tasks/task-1/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prUrl: url }),
    });
  }

  it("rejects URLs with a userinfo suffix after the PR number", async () => {
    const res = await postPrUrl("https://github.com/a/b/pull/1@evil.com/path");
    expect(res.status).toBe(400);
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
  });

  it("rejects enterprise hosts like github.corp.example.com", async () => {
    const res = await postPrUrl("https://github.corp.example.com/a/b/pull/1");
    expect(res.status).toBe(400);
  });

  it("accepts a plain github.com PR URL", async () => {
    const res = await postPrUrl("https://github.com/acme/thing/pull/42");
    expect(res.status).toBe(200);
  });

  it("accepts a github.com PR URL with a trailing anchor", async () => {
    const res = await postPrUrl("https://github.com/acme/thing/pull/42#issuecomment-1");
    expect(res.status).toBe(200);
  });
});
