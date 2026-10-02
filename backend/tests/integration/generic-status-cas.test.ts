/**
 * DB-backed race tests for the generic status write (agent-tasks task
 * e4e27a39): PATCH /tasks/:id with a status and POST /tasks/:id/transition
 * only write while the row still has the status the handler validated.
 *
 * The interleaving is deterministic, not timing based: a hook runs right after
 * the handler's first read of the task row (exactly the window between the
 * validation and the write) and changes the row through a real write, then the
 * handler continues into its own write against the changed row.
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
import { emitTaskAvailableSignal } from "../../src/services/task-signal.js";
import { emitReviewSignal } from "../../src/services/review-signal.js";

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
let teamId: string;
let projectId: string;
let userId: string;
let human: Actor;

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

async function seedTask(overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  await db.task.create({
    data: {
      id,
      projectId,
      title: `Task ${id.slice(0, 8)}`,
      description: "A task for the status compare-and-swap race tests.",
      status: "open",
      createdByUserId: userId,
      ...overrides,
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
  await db.team.create({ data: { id: teamId, name: "Status CAS", slug: randomUUID() } });
  await db.teamMember.create({ data: { teamId, userId, role: "ADMIN" } });
  projectId = randomUUID();
  await db.project.create({ data: { id: projectId, teamId, name: "Status CAS", slug: randomUUID() } });
  human = { type: "human", userId, teamId };
});

const PATCH_HEADERS = { "content-type": "application/json" };

function patchStatus(taskId: string, status: string, extra: Record<string, unknown> = {}) {
  return makeApp(human).request(`/tasks/${taskId}`, {
    method: "PATCH",
    headers: PATCH_HEADERS,
    body: JSON.stringify({ status, ...extra }),
  });
}

function transition(taskId: string, status: string) {
  return makeApp(human).request(`/tasks/${taskId}/transition`, {
    method: "POST",
    headers: PATCH_HEADERS,
    body: JSON.stringify({ status }),
  });
}

/** Runs a real REST demote (open -> backlog) from inside the read-to-write window. */
function demoteDuringRead(taskId: string) {
  let demoteStatus = 0;
  shared.afterTaskRead = async () => {
    const res = await patchStatus(taskId, "backlog");
    demoteStatus = res.status;
  };
  return () => demoteStatus;
}

describe.each([
  ["PATCH /tasks/:id", (taskId: string, status: string) => patchStatus(taskId, status)],
  ["POST /tasks/:id/transition", (taskId: string, status: string) => transition(taskId, status)],
])("generic status write %s against a real database", (_label, write) => {
  it("a demote that commits between the read and the write makes the stale open -> in_progress answer 409 and leaves the row unchanged", async () => {
    const taskId = await seedTask();
    const demoteStatus = demoteDuringRead(taskId);

    const res = await write(taskId, "in_progress");

    expect(demoteStatus()).toBe(200);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("conflict");
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("backlog");
    expect(row.claimedByUserId).toBeNull();
    expect(row.claimedByAgentId).toBeNull();
    // The losing write left no transition audit and woke nobody.
    expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "task.transitioned" }));
    expect(emitTaskAvailableSignal).not.toHaveBeenCalled();
    expect(emitReviewSignal).not.toHaveBeenCalled();
  });

  it("any other status change in the window also loses: a terminal write over a task that moved to review is 409 and its claims survive", async () => {
    const taskId = await seedTask({
      status: "in_progress",
      claimedByUserId: userId,
      claimedAt: new Date(),
      branchName: "feat/x",
      prUrl: "https://github.com/acme/thing/pull/1",
      prNumber: 1,
    });
    shared.afterTaskRead = async () => {
      await db.task.update({ where: { id: taskId }, data: { status: "review" } });
    };

    const res = await write(taskId, "done");

    expect(res.status).toBe(409);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("review");
    expect(row.claimedByUserId).toBe(userId);
    expect(row.claimedAt).not.toBeNull();
    expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "task.transitioned" }));
  });

  it("without a concurrent change the transition lands: 200, the new status, the audit event", async () => {
    const taskId = await seedTask();

    const res = await write(taskId, "in_progress");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: { id: string; status: string } };
    expect(body.task.id).toBe(taskId);
    expect(body.task.status).toBe("in_progress");
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("in_progress");
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.transitioned",
        taskId,
        payload: expect.objectContaining({ from: "open", to: "in_progress" }),
      }),
    );
  });
});

describe("PATCH /tasks/:id carrying an unchanged status", () => {
  it("an echoed status does not write over a concurrent demote: 409, and the other fields are not applied either", async () => {
    const taskId = await seedTask();
    const demoteStatus = demoteDuringRead(taskId);

    const res = await patchStatus(taskId, "open", { title: "Renamed by a stale full-object PATCH" });

    expect(demoteStatus()).toBe(200);
    expect(res.status).toBe(409);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("backlog");
    expect(row.title).not.toBe("Renamed by a stale full-object PATCH");
  });

  it("an echoed status without a race still applies the other fields: 200", async () => {
    const taskId = await seedTask();

    const res = await patchStatus(taskId, "open", { title: "Renamed" });

    expect(res.status).toBe(200);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("open");
    expect(row.title).toBe("Renamed");
  });
});

describe("PATCH /tasks/:id without a status", () => {
  it("a title-only PATCH is unaffected by the compare-and-swap and lands even while the status changes underneath", async () => {
    const taskId = await seedTask();
    const demoteStatus = demoteDuringRead(taskId);

    const res = await makeApp(human).request(`/tasks/${taskId}`, {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ title: "Only the title" }),
    });

    expect(demoteStatus()).toBe(200);
    expect(res.status).toBe(200);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.title).toBe("Only the title");
    expect(row.status).toBe("backlog");
  });
});
