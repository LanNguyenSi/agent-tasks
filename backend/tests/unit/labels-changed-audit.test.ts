/**
 * Route-level tests for `task.labels_changed` (agent-tasks task 14eb4f9b).
 *
 * Labels are a claim-gating input (resolveTriggeredRiskModifiers reads them
 * to raise the effective claim threshold, and they drive easy-pick/heavy-pick
 * dispatch routing). Since the label editor (#496) made `labels`
 * human-writable via PATCH /tasks/:id, this audit event closes the trail
 * gap the same way `task.deliverable_repo_changed` covers `deliverableRepo`.
 *
 * Per the project feedback memory: prefer `mockResolvedValue` /
 * `mockImplementation` over stacked `mockResolvedValueOnce` queues (not
 * drained by `vi.clearAllMocks`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const prismaMocks = vi.hoisted(() => ({
  taskFindUnique: vi.fn(),
  taskUpdate: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: {
      findUnique: prismaMocks.taskFindUnique,
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: prismaMocks.taskUpdate,
    },
    project: { findUnique: vi.fn().mockResolvedValue({ confidenceThreshold: 0, taskTemplate: null }) },
    signal: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    workflow: { findFirst: vi.fn().mockResolvedValue(null) },
    agentToken: { findUnique: vi.fn().mockResolvedValue({ name: "Agent" }) },
    user: { findUnique: vi.fn().mockResolvedValue({ name: "Human" }) },
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

const AGENT: Actor = {
  type: "agent",
  tokenId: "agent-1",
  teamId: "team-1",
  userId: "agent-owner",
  scopes: ["tasks:read", "tasks:claim", "tasks:transition", "tasks:create", "tasks:update"],
};

const HUMAN: Actor = { type: "human", userId: "user-1", teamId: "team-1" };

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const TASK_ID = "00000000-0000-0000-0000-000000000001";

const baseProject = {
  id: PROJECT_ID,
  name: "Agent Tasks",
  slug: "agent-tasks",
  teamId: "team-1",
  githubRepo: "acme/thing",
  confidenceThreshold: 0,
  taskTemplate: null,
  requireDistinctReviewer: false,
  soloMode: false,
  governanceMode: null,
  requireGroundingForDebug: false,
};

const baseTask = {
  id: TASK_ID,
  projectId: PROJECT_ID,
  title: "Task with labels",
  description: null,
  status: "open",
  priority: "MEDIUM",
  workflowId: null,
  workflow: null,
  templateData: null,
  metadata: null,
  createdByAgentId: "agent-author",
  createdByUserId: null,
  claimedByAgentId: null,
  claimedByUserId: null,
  claimedAt: null,
  reviewClaimedByAgentId: null,
  reviewClaimedByUserId: null,
  reviewClaimedAt: null,
  branchName: "feat/test-branch",
  prUrl: null,
  prNumber: null,
  result: null,
  autoMergeSha: null,
  deliverableRepo: null as string | null,
  labels: [] as string[],
  project: baseProject,
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
  accessMocks.hasProjectRole.mockResolvedValue(true);
  accessMocks.isProjectAdmin.mockResolvedValue(true);
  accessMocks.requireProjectWrite.mockResolvedValue(true);
  prismaMocks.taskUpdate.mockImplementation(
    ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
      Promise.resolve({ ...baseTask, id: where.id, ...data }),
  );
});

describe("PATCH /tasks/:id — labels audit", () => {
  it("audits task.labels_changed with {from, to, actorType} when labels actually change", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...baseTask, labels: ["easy-pick"], project: baseProject });
    const res = await makeApp(HUMAN).request(`/tasks/${TASK_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: ["heavy-pick", "urgent"] }),
    });
    expect(res.status).toBe(200);
    expect(prismaMocks.taskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ labels: ["heavy-pick", "urgent"] }) }),
    );
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.labels_changed",
        taskId: TASK_ID,
        projectId: PROJECT_ID,
        actorId: "user-1",
        payload: expect.objectContaining({
          from: ["easy-pick"],
          to: ["heavy-pick", "urgent"],
          actorType: "human",
        }),
      }),
    );
  });

  it("audits task.labels_changed for a same-cardinality swap (easy-pick -> heavy-pick)", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...baseTask, labels: ["easy-pick"], project: baseProject });
    const res = await makeApp(HUMAN).request(`/tasks/${TASK_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: ["heavy-pick"] }),
    });
    expect(res.status).toBe(200);
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.labels_changed",
        actorId: "user-1",
        payload: expect.objectContaining({ from: ["easy-pick"], to: ["heavy-pick"] }),
      }),
    );
  });

  it("does not audit task.labels_changed when the PATCH omits labels", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...baseTask, labels: ["easy-pick"], project: baseProject });
    const res = await makeApp(HUMAN).request(`/tasks/${TASK_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Renamed" }),
    });
    expect(res.status).toBe(200);
    expect(logAuditEventMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.labels_changed" }),
    );
  });

  it("does not audit task.labels_changed when the same label set is sent reordered", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({
      ...baseTask,
      labels: ["alpha", "beta", "gamma"],
      project: baseProject,
    });
    const res = await makeApp(HUMAN).request(`/tasks/${TASK_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: ["gamma", "alpha", "beta"] }),
    });
    expect(res.status).toBe(200);
    expect(logAuditEventMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.labels_changed" }),
    );
  });

  it("audits task.labels_changed when clearing all labels", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...baseTask, labels: ["easy-pick"], project: baseProject });
    const res = await makeApp(HUMAN).request(`/tasks/${TASK_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: [] }),
    });
    expect(res.status).toBe(200);
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.labels_changed",
        payload: expect.objectContaining({ from: ["easy-pick"], to: [] }),
      }),
    );
  });

  it("agent PATCH cannot write labels (not in agentUpdateTaskSchema, so the field is silently ignored)", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...baseTask, labels: ["easy-pick"], project: baseProject });
    const res = await makeApp(AGENT).request(`/tasks/${TASK_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: ["heavy-pick"] }),
    });
    expect(res.status).toBe(200);
    // The guarantee is about persistence, not only about the event: the agent
    // lane must not write labels at all.
    expect(prismaMocks.taskUpdate).toHaveBeenCalled();
    for (const call of prismaMocks.taskUpdate.mock.calls) {
      expect(call[0].data).not.toHaveProperty("labels");
    }
    expect(logAuditEventMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.labels_changed" }),
    );
  });
});
