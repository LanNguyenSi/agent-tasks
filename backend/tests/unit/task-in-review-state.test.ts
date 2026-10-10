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
  taskUpdate: vi.fn(),
  workflowFindFirst: vi.fn(),
  workflowFindUnique: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: {
      findUnique: prismaMocks.taskFindUnique,
      updateMany: prismaMocks.taskUpdateMany,
      update: prismaMocks.taskUpdate,
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

// ── Agreement with the release / abandon gates ───────────────────────────────
//
// The routes below load the task WITHOUT its workflow relation. The flag and
// the gates both resolve the pinned workflow by id, so the answers agree.

const CLAIMANT: Actor = { type: "human", userId: "claimant-1" };

async function releaseStatus(task: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  prismaMocks.taskFindUnique.mockResolvedValue({ ...baseTask, claimedByUserId: CLAIMANT.userId, ...task });
  const res = await makeApp(CLAIMANT).request(`/tasks/${TASK_ID}/release`, { method: "POST" });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /tasks/:id/release agrees with the inReviewState flag", () => {
  it("pinned task in review under the pinned workflow only: flag true and release 409", async () => {
    const pinned = { status: "qa", workflowId: WORKFLOW_ID };
    expect(await getFlag(pinned)).toBe(true);
    const { status, body } = await releaseStatus(pinned);
    expect(status).toBe(409);
    expect(body.error).toBe("bad_state");
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
  });

  it("pinned task in review under the default only: flag false and release 200", async () => {
    const pinned = { status: "review", workflowId: WORKFLOW_ID };
    expect(await getFlag(pinned)).toBe(false);
    const { status, body } = await releaseStatus(pinned);
    expect(status).toBe(200);
    expect((body.task as { inReviewState: boolean }).inReviewState).toBe(false);
    // The release resets to the PINNED workflow's initial state.
    expect(prismaMocks.taskUpdateMany.mock.calls[0]![0].data.status).toBe("todo");
  });

  it("unpinned task keeps judging on the default: flag true and release 409", async () => {
    const unpinned = { status: "review", workflowId: null };
    expect(await getFlag(unpinned)).toBe(true);
    expect((await releaseStatus(unpinned)).status).toBe(409);
  });
});

describe("POST /tasks/:id/abandon judges review state on the pinned workflow", () => {
  async function abandonStatus(task: Record<string, unknown>) {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...baseTask, claimedByUserId: CLAIMANT.userId, ...task });
    const res = await makeApp(CLAIMANT).request(`/tasks/${TASK_ID}/abandon`, { method: "POST" });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("pinned task in a pinned review state: 409 bad_state", async () => {
    const { status, body } = await abandonStatus({ status: "qa", workflowId: WORKFLOW_ID });
    expect(status).toBe(409);
    expect(body.error).toBe("bad_state");
    expect(prismaMocks.workflowFindUnique).toHaveBeenCalledWith({ where: { id: WORKFLOW_ID } });
  });

  it("pinned task in a state that is review-like only under the default: not rejected as in review", async () => {
    const { body } = await abandonStatus({ status: "review", workflowId: WORKFLOW_ID });
    expect(body.error).not.toBe("bad_state");
  });
});

// ── Mutation routes carry the pinned-correct flag ────────────────────────────
//
// Every route that returns the updated task to the sidebar answers with the
// flag computed on the task's own workflow, for the status it was left in.

const AGENT: Actor = {
  type: "agent",
  tokenId: "agent-1",
  scopes: ["tasks:update", "tasks:transition"],
} as Actor;

// `from` is the status the row has before the write, `to` the status it is
// left in; the flag is judged on `to`.
const MUTATION_ROUTES: Array<{
  name: string;
  actor: Actor;
  method: string;
  body: (to: string) => Record<string, unknown>;
  cases: Array<{ from: string; to: string; inReviewState: boolean }>;
}> = [
  {
    name: "POST /tasks/:id/transition",
    actor: ADMIN,
    method: "POST",
    body: (to) => ({ status: to }),
    cases: [
      { from: "doing", to: "qa", inReviewState: true },
      { from: "todo", to: "review", inReviewState: false },
    ],
  },
  {
    name: "PATCH /tasks/:id (agent lane)",
    actor: AGENT,
    method: "PATCH",
    body: () => ({ branchName: "feat/x" }),
    cases: [
      { from: "qa", to: "qa", inReviewState: true },
      { from: "review", to: "review", inReviewState: false },
    ],
  },
];

describe("mutation routes answer with the pinned-correct inReviewState", () => {
  for (const route of MUTATION_ROUTES) {
    for (const { from, to, inReviewState } of route.cases) {
      it(`${route.name} ${from} -> ${to} on a pinned task: inReviewState ${inReviewState}`, async () => {
        const before = {
          ...baseTask,
          status: from,
          workflowId: WORKFLOW_ID,
          workflow: { definition: PINNED_DEFINITION },
          project: {},
        };
        const after = { ...baseTask, status: to, workflowId: WORKFLOW_ID };
        prismaMocks.taskFindUnique.mockResolvedValueOnce(before).mockResolvedValue(after);
        prismaMocks.taskUpdate.mockResolvedValue(after);
        const path = route.method === "POST" ? `/tasks/${TASK_ID}/transition` : `/tasks/${TASK_ID}`;
        const res = await makeApp(route.actor).request(path, {
          method: route.method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(route.body(to)),
        });
        expect(res.status).toBe(200);
        const json = (await res.json()) as { task: { inReviewState: boolean } };
        expect(json.task.inReviewState).toBe(inReviewState);
      });
    }
  }
});
