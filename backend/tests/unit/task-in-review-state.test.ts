/**
 * The task payload's server-computed `inReviewState` flag follows the task's
 * EFFECTIVE workflow (task-pinned, else project default, else built-in), the
 * same resolution the release/transition gates use, so a pinned task is not
 * judged on the project default.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const prismaMocks = vi.hoisted(() => ({
  taskFindUnique: vi.fn(),
  taskUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
  workflowFindFirst: vi.fn(),
  workflowFindUnique: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: {
      findUnique: prismaMocks.taskFindUnique,
      updateMany: prismaMocks.taskUpdateMany,
    },
    workflow: {
      findFirst: prismaMocks.workflowFindFirst,
      findUnique: prismaMocks.workflowFindUnique,
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

vi.mock("../../src/services/grounding-route-context.js", () => ({
  mutateGroundingRouteContext: async (_client: unknown, input: {
    mutate: (db: { task: { updateMany: typeof prismaMocks.taskUpdateMany } }, task: never) => Promise<{ value: unknown; changed: boolean }>;
  }) => {
    const task = await prismaMocks.taskFindUnique.mock.results.map(result => result.value).reverse().find(Boolean) as never;
    return input.mutate({ task: { updateMany: prismaMocks.taskUpdateMany } }, task);
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

const baseTask = {
  id: TASK_ID,
  projectId: PROJECT_ID,
  title: "A task",
  status: "in_progress",
  workflowId: null as string | null,
  claimedByUserId: null as string | null,
  claimedByAgentId: null as string | null,
  attachments: [],
  comments: [],
  claimedByUser: null,
  claimedByAgent: null,
  blockedBy: [],
  blocks: [],
};

// Pinned workflow: "qa" is its review-like state (qa -> shipped, not a direct
// target of the initial state). Its "review" state has no way to a terminal
// state, so it is NOT review-like here even though it is under the built-in
// default workflow.
const PINNED_DEFINITION = {
  initialState: "todo",
  states: [
    { name: "todo", label: "Todo", terminal: false },
    { name: "doing", label: "Doing", terminal: false },
    { name: "qa", label: "QA", terminal: false },
    { name: "review", label: "Review", terminal: false },
    { name: "shipped", label: "Shipped", terminal: true },
  ],
  transitions: [
    { from: "todo", to: "doing" },
    { from: "todo", to: "review" },
    { from: "doing", to: "qa" },
    { from: "review", to: "doing" },
    { from: "qa", to: "shipped" },
  ],
};

const WORKFLOW_ID = "22222222-2222-2222-2222-222222222222";

async function getFlag(task: Record<string, unknown>): Promise<boolean> {
  prismaMocks.taskFindUnique.mockResolvedValue({ ...baseTask, ...task });
  const res = await makeApp(ADMIN).request(`/tasks/${TASK_ID}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { task: { inReviewState: boolean } };
  return body.task.inReviewState;
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.workflowFindFirst.mockResolvedValue(null);
  prismaMocks.workflowFindUnique.mockResolvedValue({ definition: PINNED_DEFINITION });
});

describe("GET /tasks/:id inReviewState", () => {
  it("unpinned task follows the built-in default workflow", async () => {
    expect(await getFlag({ status: "review", workflowId: null })).toBe(true);
    expect(await getFlag({ status: "in_progress", workflowId: null })).toBe(false);
    expect(prismaMocks.workflowFindUnique).not.toHaveBeenCalled();
  });

  it("unpinned task follows the project default workflow row", async () => {
    prismaMocks.workflowFindFirst.mockResolvedValue({ definition: PINNED_DEFINITION });
    expect(await getFlag({ status: "qa", workflowId: null })).toBe(true);
    expect(await getFlag({ status: "review", workflowId: null })).toBe(false);
  });

  it("pinned task: in review under the pinned workflow but not under the default", async () => {
    expect(await getFlag({ status: "qa", workflowId: WORKFLOW_ID })).toBe(true);
    expect(prismaMocks.workflowFindUnique).toHaveBeenCalledWith({ where: { id: WORKFLOW_ID } });
  });

  it("pinned task: in review under the default but not under the pinned workflow", async () => {
    expect(await getFlag({ status: "review", workflowId: WORKFLOW_ID })).toBe(false);
  });

  it("pinned task whose workflow row is gone falls back to the project default", async () => {
    prismaMocks.workflowFindUnique.mockResolvedValue(null);
    expect(await getFlag({ status: "review", workflowId: WORKFLOW_ID })).toBe(true);
  });
});
