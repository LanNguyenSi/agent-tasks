/**
 * Route tests for POST /projects/:projectId/tasks with `dependsOn`.
 *
 * Mirrors the setup of tasks-artifacts-routes.test.ts (hoisted Prisma mocks,
 * injected actor via pre-middleware) and avoids `mockResolvedValueOnce` queues
 * per the project memory on the vitest mock-queue leak.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const BLOCKER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BLOCKER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const STRANGER = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const prismaMocks = vi.hoisted(() => ({
  taskCreate: vi.fn(),
  taskFindMany: vi.fn(),
  taskFindUnique: vi.fn(),
  agentTokenFindUnique: vi.fn().mockResolvedValue({ name: "Agent" }),
  userFindUnique: vi.fn().mockResolvedValue({ name: "Human" }),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: {
      create: prismaMocks.taskCreate,
      findMany: prismaMocks.taskFindMany,
      findUnique: prismaMocks.taskFindUnique,
      // Stubs imported but unused by the create endpoint
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    signal: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    workflow: { findFirst: vi.fn() },
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
vi.mock("../../src/services/github-merge.js", () => ({ performPrMerge: vi.fn() }));
vi.mock("../../src/services/github-delegation.js", () => ({
  findDelegationUser: vi.fn().mockResolvedValue(null),
}));

import { taskRouter } from "../../src/routes/tasks.js";

const AGENT: Actor = {
  type: "agent",
  tokenId: "agent-1",
  teamId: "team-1",
  scopes: ["tasks:create"],
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

beforeEach(() => {
  vi.clearAllMocks();
  accessMocks.hasProjectAccess.mockResolvedValue(true);
  prismaMocks.taskCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "task-new", ...data, attachments: [], artifacts: [], comments: [] }),
  );
});

async function postCreate(body: Record<string, unknown>) {
  return makeApp(AGENT).request(`/projects/${PROJECT_ID}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /projects/:projectId/tasks — dependsOn", () => {
  it("connects blockers when all dependsOn IDs exist in the same project", async () => {
    prismaMocks.taskFindMany.mockResolvedValue([{ id: BLOCKER_A }, { id: BLOCKER_B }]);

    const res = await postCreate({
      title: "Child",
      dependsOn: [BLOCKER_A, BLOCKER_B],
    });

    expect(res.status).toBe(201);
    expect(prismaMocks.taskFindMany).toHaveBeenCalledWith({
      where: { id: { in: [BLOCKER_A, BLOCKER_B] }, projectId: PROJECT_ID },
      select: { id: true },
    });
    const createArg = prismaMocks.taskCreate.mock.calls[0]![0];
    expect(createArg.data.blockedBy).toEqual({
      connect: [{ id: BLOCKER_A }, { id: BLOCKER_B }],
    });
  });

  it("dedupes repeated IDs in dependsOn", async () => {
    prismaMocks.taskFindMany.mockResolvedValue([{ id: BLOCKER_A }]);

    const res = await postCreate({
      title: "Child",
      dependsOn: [BLOCKER_A, BLOCKER_A, BLOCKER_A],
    });

    expect(res.status).toBe(201);
    expect(prismaMocks.taskFindMany).toHaveBeenCalledWith({
      where: { id: { in: [BLOCKER_A] }, projectId: PROJECT_ID },
      select: { id: true },
    });
    const createArg = prismaMocks.taskCreate.mock.calls[0]![0];
    expect(createArg.data.blockedBy).toEqual({ connect: [{ id: BLOCKER_A }] });
  });

  it("rejects with 400 when a dependsOn ID does not exist in the project", async () => {
    // Stranger isn't returned → it's missing or in a different project.
    prismaMocks.taskFindMany.mockResolvedValue([{ id: BLOCKER_A }]);

    const res = await postCreate({
      title: "Child",
      dependsOn: [BLOCKER_A, STRANGER],
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; missing: string[] };
    expect(body.error).toBe("bad_request");
    expect(body.missing).toEqual([STRANGER]);
    expect(prismaMocks.taskCreate).not.toHaveBeenCalled();
  });

  it("omits the blockedBy connect when dependsOn is absent", async () => {
    const res = await postCreate({ title: "Solo" });

    expect(res.status).toBe(201);
    expect(prismaMocks.taskFindMany).not.toHaveBeenCalled();
    const createArg = prismaMocks.taskCreate.mock.calls[0]![0];
    expect(createArg.data.blockedBy).toBeUndefined();
  });

  it("omits the blockedBy connect when dependsOn is an empty array", async () => {
    const res = await postCreate({ title: "Solo", dependsOn: [] });

    expect(res.status).toBe(201);
    expect(prismaMocks.taskFindMany).not.toHaveBeenCalled();
    const createArg = prismaMocks.taskCreate.mock.calls[0]![0];
    expect(createArg.data.blockedBy).toBeUndefined();
  });

  it("rejects malformed dependsOn entries via the zod schema", async () => {
    const res = await postCreate({
      title: "Bad",
      dependsOn: ["not-a-uuid"],
    });

    expect(res.status).toBe(400);
    expect(prismaMocks.taskFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.taskCreate).not.toHaveBeenCalled();
  });
});
