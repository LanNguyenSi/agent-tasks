/**
 * POST /tasks/:id/comments feeds the M5 clarification signal: a comment posted
 * by an AGENT that holds the task's active work claim while the task is in a
 * work state increments `clarificationCount` (one upsert). Every other comment
 * leaves telemetry alone, and telemetry failures never change the 201.
 *
 * The REAL confidence-telemetry service runs against a mocked prisma so the
 * fail-open behaviour is exercised end to end, not stubbed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const prismaMocks = vi.hoisted(() => ({
  taskFindUnique: vi.fn(),
  commentCreate: vi.fn(),
  workflowFindFirst: vi.fn(),
  workflowFindUnique: vi.fn(),
  confidenceTelemetryUpsert: vi.fn(),
  auditLogFindFirst: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: { findUnique: prismaMocks.taskFindUnique },
    comment: { create: prismaMocks.commentCreate },
    workflow: { findFirst: prismaMocks.workflowFindFirst, findUnique: prismaMocks.workflowFindUnique },
    confidenceTelemetry: { upsert: prismaMocks.confidenceTelemetryUpsert },
    auditLog: { findFirst: prismaMocks.auditLogFindFirst },
  },
}));

const accessMocks = vi.hoisted(() => ({
  hasProjectAccess: vi.fn(),
  requireProjectWrite: vi.fn(),
}));
vi.mock("../../src/services/team-access.js", () => accessMocks);
vi.mock("../../src/services/audit.js", () => ({ logAuditEvent: vi.fn().mockResolvedValue(undefined) }));

const loggerMocks = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../../src/lib/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/logger.js")>();
  return { ...actual, logger: { ...actual.logger, error: loggerMocks.error } };
});

import { taskRouter } from "../../src/routes/tasks.js";

const CLAIM_HOLDER: Actor = {
  type: "agent",
  tokenId: "agent-1",
  teamId: "team-1",
  userId: "user-1",
  scopes: ["tasks:read", "tasks:comment"],
};
const OTHER_AGENT: Actor = { ...CLAIM_HOLDER, tokenId: "agent-2" };
const HUMAN: Actor = { type: "human", userId: "user-9" };

function makeApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", taskRouter);
  return app;
}

const TASK = {
  id: "task-1",
  projectId: "proj-1",
  status: "in_progress",
  workflowId: null,
  claimedByAgentId: "agent-1",
  claimedByUserId: null,
};

const COMMENT = { id: "comment-1", taskId: "task-1", content: "which API version?" };

async function postComment(actor: Actor) {
  return makeApp(actor).request("/tasks/task-1/comments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "which API version?" }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  accessMocks.hasProjectAccess.mockResolvedValue(true);
  accessMocks.requireProjectWrite.mockResolvedValue(true);
  prismaMocks.taskFindUnique.mockResolvedValue(TASK);
  prismaMocks.commentCreate.mockResolvedValue(COMMENT);
  prismaMocks.workflowFindFirst.mockResolvedValue(null); // built-in default workflow
  prismaMocks.confidenceTelemetryUpsert.mockResolvedValue({});
  prismaMocks.auditLogFindFirst.mockResolvedValue(null);
});

describe("POST /tasks/:id/comments - clarification counting", () => {
  it("counts exactly one clarification for the agent work-claim holder on an in_progress task", async () => {
    prismaMocks.auditLogFindFirst
      .mockResolvedValueOnce({ payload: { score: 77, threshold: 60 } })
      .mockResolvedValueOnce(null);

    const res = await postComment(CLAIM_HOLDER);

    expect(res.status).toBe(201);
    expect(prismaMocks.confidenceTelemetryUpsert).toHaveBeenCalledTimes(1);
    expect(prismaMocks.confidenceTelemetryUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { taskId: "task-1" },
        create: expect.objectContaining({
          taskId: "task-1",
          projectId: "proj-1",
          clarificationCount: 1,
          scoreAtClaim: 77,
        }),
        update: { clarificationCount: { increment: 1 } },
      }),
    );
    const body = (await res.json()) as { comment: { id: string } };
    expect(body.comment.id).toBe("comment-1");
  });

  it("does not count a comment from another agent that is not the claim holder", async () => {
    const res = await postComment(OTHER_AGENT);
    expect(res.status).toBe(201);
    expect(prismaMocks.confidenceTelemetryUpsert).not.toHaveBeenCalled();
  });

  it("does not count the claim holder's comment while the task is in review", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...TASK, status: "review" });
    const res = await postComment(CLAIM_HOLDER);
    expect(res.status).toBe(201);
    expect(prismaMocks.confidenceTelemetryUpsert).not.toHaveBeenCalled();
  });

  it("does not count a human who holds the work claim", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({
      ...TASK,
      claimedByAgentId: null,
      claimedByUserId: "user-9",
    });
    const res = await postComment(HUMAN);
    expect(res.status).toBe(201);
    expect(prismaMocks.confidenceTelemetryUpsert).not.toHaveBeenCalled();
  });

  it("does not count a comment on a task without a claim", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({
      ...TASK,
      status: "open",
      claimedByAgentId: null,
    });
    const res = await postComment(CLAIM_HOLDER);
    expect(res.status).toBe(201);
    expect(prismaMocks.confidenceTelemetryUpsert).not.toHaveBeenCalled();
  });

  it("does not count an agent claim-holder's comment on a task in the initial state", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...TASK, status: "open" });
    const res = await postComment(CLAIM_HOLDER);
    expect(res.status).toBe(201);
    expect(prismaMocks.confidenceTelemetryUpsert).not.toHaveBeenCalled();
  });

  it("does not count when the task is in a terminal state even if a stale claim id is present", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...TASK, status: "done" });
    const res = await postComment(CLAIM_HOLDER);
    expect(res.status).toBe(201);
    expect(prismaMocks.confidenceTelemetryUpsert).not.toHaveBeenCalled();
  });
});

// A definition whose initial state is `todo`: a task whose status is `open`
// is then a plain work state, while under the built-in definition `open` is
// the initial state. Only the resolved effective definition can tell them apart.
const CUSTOM_DEFINITION = {
  initialState: "todo",
  states: [
    { name: "todo", terminal: false },
    { name: "open", terminal: false },
    { name: "review", terminal: false },
    { name: "done", terminal: true },
  ],
  transitions: [
    { from: "todo", to: "open", label: "start", requiredRole: "any" },
    { from: "open", to: "review", label: "finish", requiredRole: "any" },
    { from: "review", to: "done", label: "approve", requiredRole: "any" },
  ],
};

describe("POST /tasks/:id/comments - effective workflow definition", () => {
  it("uses the task's own workflow when workflowId is set", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...TASK, status: "open", workflowId: "wf-1" });
    prismaMocks.workflowFindUnique.mockResolvedValue({ id: "wf-1", definition: CUSTOM_DEFINITION });

    const res = await postComment(CLAIM_HOLDER);

    expect(res.status).toBe(201);
    expect(prismaMocks.workflowFindUnique).toHaveBeenCalledWith({ where: { id: "wf-1" } });
    expect(prismaMocks.confidenceTelemetryUpsert).toHaveBeenCalledTimes(1);
  });

  it("uses the project-default workflow row when the task has no workflowId", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...TASK, status: "open" });
    prismaMocks.workflowFindFirst.mockResolvedValue({ id: "wf-d", definition: CUSTOM_DEFINITION });

    const res = await postComment(CLAIM_HOLDER);

    expect(res.status).toBe(201);
    expect(prismaMocks.workflowFindUnique).not.toHaveBeenCalled();
    expect(prismaMocks.confidenceTelemetryUpsert).toHaveBeenCalledTimes(1);
  });

  it("does not load a per-task workflow for a non-holder", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...TASK, status: "open", workflowId: "wf-1" });
    const res = await postComment(OTHER_AGENT);
    expect(res.status).toBe(201);
    expect(prismaMocks.workflowFindUnique).not.toHaveBeenCalled();
    expect(prismaMocks.confidenceTelemetryUpsert).not.toHaveBeenCalled();
  });

  it("returns 201 and logs when the per-task workflow lookup throws", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...TASK, workflowId: "wf-1" });
    prismaMocks.workflowFindUnique.mockRejectedValue(new Error("workflow load failed"));

    const res = await postComment(CLAIM_HOLDER);

    expect(res.status).toBe(201);
    expect(prismaMocks.confidenceTelemetryUpsert).not.toHaveBeenCalled();
    expect(loggerMocks.error).toHaveBeenCalledWith(
      expect.objectContaining({ op: "recordClarification", taskId: "task-1" }),
      expect.any(String),
    );
  });
});

describe("POST /tasks/:id/comments - fail-open", () => {
  it("returns 201 with the comment and logs when the telemetry upsert throws", async () => {
    prismaMocks.confidenceTelemetryUpsert.mockRejectedValue(new Error("db unreachable"));

    const res = await postComment(CLAIM_HOLDER);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { comment: { id: string } };
    expect(body.comment.id).toBe("comment-1");
    expect(prismaMocks.confidenceTelemetryUpsert).toHaveBeenCalled();
    expect(loggerMocks.error).toHaveBeenCalledWith(
      expect.objectContaining({ op: "recordClarification", taskId: "task-1" }),
      expect.any(String),
    );
  });

  it("returns 201 with the comment and logs when the claim snapshot lookup throws", async () => {
    prismaMocks.auditLogFindFirst.mockRejectedValue(new Error("audit lookup failed"));

    const res = await postComment(CLAIM_HOLDER);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { comment: { id: string } };
    expect(body.comment.id).toBe("comment-1");
    expect(loggerMocks.error).toHaveBeenCalledWith(
      expect.objectContaining({ op: "recordClarification", taskId: "task-1" }),
      expect.any(String),
    );
  });

  it("returns 201 with the comment and logs when the workflow lookup throws", async () => {
    prismaMocks.workflowFindFirst.mockRejectedValue(new Error("workflow lookup failed"));

    const res = await postComment(CLAIM_HOLDER);

    expect(res.status).toBe(201);
    expect(prismaMocks.confidenceTelemetryUpsert).not.toHaveBeenCalled();
    expect(loggerMocks.error).toHaveBeenCalledWith(
      expect.objectContaining({ op: "recordClarification", taskId: "task-1" }),
      expect.any(String),
    );
  });
});
