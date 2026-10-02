/**
 * DB-backed test for the human "demote" special case of PATCH /tasks/:id
 * (agent-tasks task 7c64e80c): open -> backlog for an unclaimed task.
 *
 * The unit suite (tests/unit/task-demote-to-backlog.test.ts) replaces Prisma
 * with an in-memory row and the route transaction with a stand-in, so it can
 * show the handler's decisions but not that the pool filters, the signal
 * acknowledgement and the row lock behave against real Postgres. This suite
 * runs the real routes against a real database (the `groundingPostgres`
 * helper the other integration suites use) and checks:
 *   - after a demote, task_pickup no longer offers the task, task_start
 *     answers backlog_not_promoted, and the task's pending signals are
 *     acknowledged (other tasks' signals are not);
 *   - a task_start that claims the task between the demote's read and its
 *     write wins: the demote answers 409 and the task is never a backlog task
 *     with a claim.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";
import { groundingPostgres } from "../helpers/grounding-postgres.js";

const shared = vi.hoisted(() => ({
  db: undefined as PrismaClient | undefined,
  // Runs once, right after the demote handler's first read of the task row.
  afterTaskRead: null as (() => Promise<void>) | null,
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: new Proxy(
    {},
    {
      get: (_target, key) => {
        if (!shared.db) throw new Error("test database not connected");
        const value = Reflect.get(shared.db, key);
        if (key === "task") {
          return new Proxy(value as object, {
            get: (delegate, method) => {
              const member = Reflect.get(delegate, method);
              if (method !== "findUnique" || typeof member !== "function") return member;
              return async (...args: unknown[]) => {
                const row = await (member as (...a: unknown[]) => Promise<unknown>).apply(delegate, args);
                const hook = shared.afterTaskRead;
                if (hook) {
                  shared.afterTaskRead = null;
                  await hook();
                }
                return row;
              };
            },
          });
        }
        return typeof value === "function" ? value.bind(shared.db) : value;
      },
    },
  ),
}));

const accessMocks = vi.hoisted(() => ({
  hasProjectAccess: vi.fn().mockResolvedValue(true),
  hasProjectRole: vi.fn().mockResolvedValue(true),
  isProjectAdmin: vi.fn().mockResolvedValue(true),
  requireProjectWrite: vi.fn().mockResolvedValue(true),
  resolveTeamId: vi.fn().mockResolvedValue({ ok: true, teamId: "team-1" }),
  resolveTeamIdErrorBody: vi.fn(),
}));
vi.mock("../../src/services/team-access.js", () => accessMocks);
vi.mock("../../src/services/audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/audit.js")>()),
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
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
vi.mock("../../src/services/grounding-client.js", () => ({
  getGroundingClient: () => ({
    start: vi.fn().mockResolvedValue(null),
    getLedgerSummary: vi.fn().mockResolvedValue({ entryCount: 0 }),
  }),
  RealGroundingClient: class {},
  NullGroundingClient: class {},
  __resetGroundingClientCacheForTests: () => {},
}));

import { taskRouter } from "../../src/routes/tasks.js";
import { logAuditEvent } from "../../src/services/audit.js";

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
let teamId: string;
let projectId: string;
let userId: string;
let agentTokenId: string;
let human: Actor;
let agent: Actor;

function makeApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("groundingRemoteTargetGuard", null);
    await next();
  });
  app.route("/", taskRouter);
  return app;
}

function demote(taskId: string) {
  return makeApp(human).request(`/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "backlog" }),
  });
}

async function seedTask(overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  await db.task.create({
    data: {
      id,
      projectId,
      title: `Task ${id.slice(0, 8)}`,
      description: "A task that was promoted by mistake.",
      status: "open",
      createdByUserId: userId,
      ...overrides,
    },
  });
  return id;
}

async function seedAvailableSignal(taskId: string) {
  const id = randomUUID();
  await db.signal.create({
    data: {
      id,
      type: "task_available",
      taskId,
      projectId,
      recipientAgentId: agentTokenId,
      context: { taskTitle: "t", taskStatus: "open" },
    },
  });
  return id;
}

beforeAll(async () => {
  store = await groundingPostgres();
  db = store.db;
  shared.db = db;
}, 60000);

afterAll(async () => {
  if (store) await store.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  shared.afterTaskRead = null;
  accessMocks.hasProjectAccess.mockResolvedValue(true);
  accessMocks.requireProjectWrite.mockResolvedValue(true);

  userId = randomUUID();
  await db.user.create({ data: { id: userId, login: `u-${userId}` } });
  teamId = randomUUID();
  await db.team.create({ data: { id: teamId, name: "Demote", slug: randomUUID() } });
  await db.teamMember.create({ data: { teamId, userId, role: "ADMIN" } });
  projectId = randomUUID();
  await db.project.create({ data: { id: projectId, teamId, name: "Demote", slug: randomUUID() } });
  agentTokenId = randomUUID();
  await db.agentToken.create({
    data: {
      id: agentTokenId,
      teamId,
      createdById: userId,
      name: "demote-agent",
      tokenHash: randomUUID(),
      scopes: ["tasks:read", "tasks:claim", "tasks:transition", "tasks:update"],
    },
  });
  human = { type: "human", userId, teamId };
  agent = {
    type: "agent",
    tokenId: agentTokenId,
    teamId,
    userId,
    scopes: ["tasks:read", "tasks:claim", "tasks:transition", "tasks:update"],
  };
});

describe("demote against a real database", () => {
  it("after the demote the task leaves the pickup pool, task_start answers backlog_not_promoted, and only this task's signals are acknowledged", async () => {
    const taskId = await seedTask();
    const otherTaskId = await seedTask();

    // Control: while the task is open, an agent is offered it.
    const before = await makeApp(agent).request("/tasks/pickup", { method: "POST" });
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as { kind: string; task?: { id: string } };
    expect(beforeBody.kind).toBe("work");
    expect([taskId, otherTaskId]).toContain(beforeBody.task!.id);

    const demotedSignal = await seedAvailableSignal(taskId);
    const otherSignal = await seedAvailableSignal(otherTaskId);

    const res = await demote(taskId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: { id: string; status: string } };
    expect(body.task.status).toBe("backlog");

    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("backlog");
    expect(row.claimedByAgentId).toBeNull();

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.backlog_demoted",
        taskId,
        payload: expect.objectContaining({ from: "open", to: "backlog", actorType: "human", via: "patch" }),
      }),
    );

    // Signals: this task's pending signal is acknowledged, the other task's is not.
    const demotedRow = await db.signal.findUniqueOrThrow({ where: { id: demotedSignal } });
    expect(demotedRow.acknowledgedAt).not.toBeNull();
    const otherRow = await db.signal.findUniqueOrThrow({ where: { id: otherSignal } });
    expect(otherRow.acknowledgedAt).toBeNull();

    // Acknowledge the unrelated signal as the agent would, then pickup: the
    // demoted task is not offered, only the still-open one is.
    await db.signal.update({ where: { id: otherSignal }, data: { acknowledgedAt: new Date() } });
    const after = await makeApp(agent).request("/tasks/pickup", { method: "POST" });
    const afterBody = (await after.json()) as { kind: string; task?: { id: string } };
    expect(afterBody.kind).toBe("work");
    expect(afterBody.task!.id).toBe(otherTaskId);

    // With the other task gone from the pool too, nothing is offered at all.
    await db.task.update({ where: { id: otherTaskId }, data: { status: "backlog" } });
    const idle = await makeApp(agent).request("/tasks/pickup", { method: "POST" });
    expect(((await idle.json()) as { kind: string }).kind).toBe("idle");

    const start = await makeApp(agent).request(`/tasks/${taskId}/start`, { method: "POST" });
    expect(start.status).toBe(403);
    expect(((await start.json()) as { error: string }).error).toBe("backlog_not_promoted");
    const untouched = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(untouched.status).toBe("backlog");
    expect(untouched.claimedByAgentId).toBeNull();
  });

  it("a task_start that claims the task between the demote's read and its write wins: demote is 409, the task is never a backlog task with a claim", async () => {
    const taskId = await seedTask();
    await seedAvailableSignal(taskId);

    // The real task_start runs right after the demote handler read an open,
    // unclaimed row and before the demote's transaction opens.
    let startStatus = 0;
    shared.afterTaskRead = async () => {
      const start = await makeApp(agent).request(`/tasks/${taskId}/start`, { method: "POST" });
      startStatus = start.status;
    };

    const res = await demote(taskId);

    expect(startStatus).toBe(200);
    expect(res.status).toBe(409);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("in_progress");
    expect(row.claimedByAgentId).toBe(agentTokenId);
    // The losing demote wrote nothing: no demote audit, no signal ack.
    expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "task.backlog_demoted" }));
    const signals = await db.signal.findMany({ where: { taskId } });
    expect(signals.every((s) => s.acknowledgedAt === null)).toBe(true);
  });

  it("an open row that still carries a work or review claim is refused (409) and the claim is left alone", async () => {
    const workClaimed = await seedTask({ claimedByAgentId: agentTokenId, claimedAt: new Date() });
    const reviewClaimed = await seedTask({ reviewClaimedByUserId: userId, reviewClaimedAt: new Date() });
    for (const taskId of [workClaimed, reviewClaimed]) {
      const res = await demote(taskId);
      expect(res.status).toBe(409);
      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("open");
    }
    expect((await db.task.findUniqueOrThrow({ where: { id: workClaimed } })).claimedByAgentId).toBe(agentTokenId);
    expect((await db.task.findUniqueOrThrow({ where: { id: reviewClaimed } })).reviewClaimedByUserId).toBe(userId);
  });

  it("a task that was started is in_progress: demote answers 400 and the claim stays", async () => {
    const started = await seedTask();
    const start = await makeApp(agent).request(`/tasks/${started}/start`, { method: "POST" });
    expect(start.status).toBe(200);
    const res = await demote(started);
    expect(res.status).toBe(400);
    const row = await db.task.findUniqueOrThrow({ where: { id: started } });
    expect(row.status).toBe("in_progress");
    expect(row.claimedByAgentId).toBe(agentTokenId);
  });

  it("an unclaimed in_progress or review row is not demotable (400)", async () => {
    for (const status of ["in_progress", "review", "done"]) {
      const taskId = await seedTask({ status });
      const res = await demote(taskId);
      expect(res.status).toBe(400);
      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe(status);
    }
  });
});
