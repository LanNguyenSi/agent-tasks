/**
 * Route tests for the /tasks/:id/artifacts endpoints.
 *
 * Mirrors the setup of tasks-v2-routes.test.ts (hoisted Prisma mocks, injected
 * actor via pre-middleware) and avoids `mockResolvedValueOnce` queues per the
 * project memory on the vitest mock-queue leak.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const prismaMocks = vi.hoisted(() => ({
  taskFindUnique: vi.fn(),
  artifactFindMany: vi.fn(),
  artifactFindUnique: vi.fn(),
  artifactCreate: vi.fn(),
  artifactDelete: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: { findUnique: prismaMocks.taskFindUnique },
    taskArtifact: {
      findMany: prismaMocks.artifactFindMany,
      findUnique: prismaMocks.artifactFindUnique,
      create: prismaMocks.artifactCreate,
      delete: prismaMocks.artifactDelete,
    },
    // Unused by these routes but imported by the tasks module at load time.
    task_other: {},
    signal: { findFirst: vi.fn(), update: vi.fn() },
    workflow: { findFirst: vi.fn() },
    agentToken: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

const accessMocks = vi.hoisted(() => ({
  hasProjectAccess: vi.fn().mockResolvedValue(true),
  hasProjectRole: vi.fn().mockResolvedValue(false),
  isProjectAdmin: vi.fn().mockResolvedValue(false),
}));
vi.mock("../../src/services/team-access.js", () => accessMocks);

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

// Silence all signal emitters — routes under test do not emit them but the
// tasks module imports and wires them at load time.
vi.mock("../../src/services/review-signal.js", () => ({
  emitReviewSignal: vi.fn(),
  emitChangesRequestedSignal: vi.fn(),
  emitTaskApprovedSignal: vi.fn(),
}));
vi.mock("../../src/services/task-signal.js", () => ({ emitTaskAvailableSignal: vi.fn() }));
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
  scopes: ["tasks:read", "tasks:update"],
};

const HUMAN: Actor = {
  type: "human",
  userId: "user-1",
  teamId: "team-1",
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

const task = { id: "task-1", projectId: "proj-1" };

beforeEach(() => {
  vi.clearAllMocks();
  accessMocks.hasProjectAccess.mockResolvedValue(true);
  accessMocks.hasProjectRole.mockResolvedValue(false);
  prismaMocks.taskFindUnique.mockResolvedValue(task);
});

describe("POST /tasks/:id/artifacts", () => {
  it("creates an inline artifact for an agent with tasks:update scope", async () => {
    prismaMocks.artifactCreate.mockResolvedValue({
      id: "art-1",
      taskId: "task-1",
      type: "test_report",
      name: "vitest.log",
      content: "PASS",
      sizeBytes: 4,
    });

    const res = await makeApp(AGENT).request("/tasks/task-1/artifacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "test_report",
        name: "vitest.log",
        content: "PASS",
      }),
    });

    expect(res.status).toBe(201);
    const createCall = prismaMocks.artifactCreate.mock.calls[0]![0];
    expect(createCall.data).toMatchObject({
      taskId: "task-1",
      type: "test_report",
      name: "vitest.log",
      content: "PASS",
      sizeBytes: 4, // UTF-8 byte length of "PASS"
      createdByAgentId: "agent-1",
      createdByUserId: null,
    });
  });

  it("rejects agents missing the tasks:update scope", async () => {
    const weakAgent: Actor = { ...AGENT, scopes: ["tasks:read"] };
    const res = await makeApp(weakAgent).request("/tasks/task-1/artifacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "other",
        name: "n",
        content: "x",
      }),
    });
    expect(res.status).toBe(403);
    expect(prismaMocks.artifactCreate).not.toHaveBeenCalled();
  });

  it("rejects payloads with neither content nor url", async () => {
    const res = await makeApp(AGENT).request("/tasks/task-1/artifacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "other", name: "n" }),
    });
    // zValidator returns 400 on schema failure.
    expect(res.status).toBe(400);
    expect(prismaMocks.artifactCreate).not.toHaveBeenCalled();
  });

  it("rejects inline content that exceeds the 1 MiB cap (via zod, before Prisma)", async () => {
    const res = await makeApp(AGENT).request("/tasks/task-1/artifacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "other",
        name: "big",
        content: "a".repeat(1_048_577),
      }),
    });
    // Zod's .max(1_048_576) fires first → 400. The 413 branch covers runtime
    // byte-length overflow (multi-byte chars that pass the char-count check).
    expect(res.status).toBe(400);
    expect(prismaMocks.artifactCreate).not.toHaveBeenCalled();
  });

  it("returns 413 when UTF-8 byte length exceeds the cap even though char count fits", async () => {
    // 4-byte code point × 262 145 ≈ 1 048 580 bytes; char count is 262 145
    // which is well under the zod .max(1_048_576) character limit, so the
    // request passes schema validation and exercises the runtime byte-length
    // check in the route handler.
    const multiByte = "\u{1F4A9}".repeat(262_145); // 💩 — 4 bytes per copy
    expect(multiByte.length).toBeLessThanOrEqual(1_048_576);

    const res = await makeApp(AGENT).request("/tasks/task-1/artifacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "other", name: "big", content: multiByte }),
    });

    expect(res.status).toBe(413);
    expect(prismaMocks.artifactCreate).not.toHaveBeenCalled();
  });

  it("returns 404 when the task does not exist", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue(null);
    const res = await makeApp(AGENT).request("/tasks/missing/artifacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "other", name: "n", content: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /tasks/:id/artifacts", () => {
  it("returns metadata and respects the type filter", async () => {
    prismaMocks.artifactFindMany.mockResolvedValue([
      { id: "a", taskId: "task-1", type: "build_log", name: "ci.log" },
    ]);

    const res = await makeApp(AGENT).request("/tasks/task-1/artifacts?type=build_log");
    expect(res.status).toBe(200);
    const call = prismaMocks.artifactFindMany.mock.calls[0]![0];
    expect(call.where).toEqual({ taskId: "task-1", type: "build_log" });
    // Content must NOT be in the list select — clients fetch by id.
    expect(call.select).not.toHaveProperty("content");
  });

  it("rejects an unknown type filter with 400", async () => {
    const res = await makeApp(AGENT).request("/tasks/task-1/artifacts?type=bogus");
    expect(res.status).toBe(400);
    expect(prismaMocks.artifactFindMany).not.toHaveBeenCalled();
  });
});

describe("GET /tasks/:id/artifacts/:artifactId", () => {
  it("returns the full artifact including inline content", async () => {
    prismaMocks.artifactFindUnique.mockResolvedValue({
      id: "art-1",
      taskId: "task-1",
      type: "build_log",
      name: "ci.log",
      content: "PASS",
    });

    const res = await makeApp(AGENT).request("/tasks/task-1/artifacts/art-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifact: { id: string; content: string } };
    expect(body.artifact.id).toBe("art-1");
    expect(body.artifact.content).toBe("PASS");
  });

  it("returns 404 when the artifact belongs to a different task (IDOR guard)", async () => {
    prismaMocks.artifactFindUnique.mockResolvedValue({
      id: "art-1",
      taskId: "OTHER-task",
      type: "build_log",
      name: "ci.log",
    });

    const res = await makeApp(AGENT).request("/tasks/task-1/artifacts/art-1");
    expect(res.status).toBe(404);
  });

  it("rejects agents missing tasks:read scope", async () => {
    const weakAgent: Actor = { ...AGENT, scopes: ["tasks:update"] };
    const res = await makeApp(weakAgent).request("/tasks/task-1/artifacts/art-1");
    expect(res.status).toBe(403);
    expect(prismaMocks.artifactFindUnique).not.toHaveBeenCalled();
  });
});

describe("DELETE /tasks/:id/artifacts/:artifactId", () => {
  it("allows the creator agent to delete their own artifact", async () => {
    prismaMocks.artifactFindUnique.mockResolvedValue({
      id: "art-1",
      taskId: "task-1",
      createdByAgentId: "agent-1",
      createdByUserId: null,
      type: "build_log",
    });

    const res = await makeApp(AGENT).request("/tasks/task-1/artifacts/art-1", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(prismaMocks.artifactDelete).toHaveBeenCalledWith({ where: { id: "art-1" } });
  });

  it("refuses delete from a non-creator human who is not a project admin", async () => {
    prismaMocks.artifactFindUnique.mockResolvedValue({
      id: "art-1",
      taskId: "task-1",
      createdByAgentId: "agent-other",
      createdByUserId: null,
      type: "build_log",
    });
    accessMocks.hasProjectRole.mockResolvedValue(false);

    const res = await makeApp(HUMAN).request("/tasks/task-1/artifacts/art-1", {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
    expect(prismaMocks.artifactDelete).not.toHaveBeenCalled();
  });

  it("allows a project admin to delete someone else's artifact", async () => {
    prismaMocks.artifactFindUnique.mockResolvedValue({
      id: "art-1",
      taskId: "task-1",
      createdByAgentId: "agent-other",
      createdByUserId: null,
      type: "build_log",
    });
    accessMocks.hasProjectRole.mockResolvedValue(true);

    const res = await makeApp(HUMAN).request("/tasks/task-1/artifacts/art-1", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(prismaMocks.artifactDelete).toHaveBeenCalled();
  });
});
