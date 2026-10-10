/**
 * DB-backed test for the pinned-workflow resolution on the claim-drop routes.
 *
 * `resolveEffectiveDefinition` reads `task.workflow === undefined` as "the
 * relation was not loaded: fetch the pinned row by id" and `null` as "loaded,
 * row gone". `/release` and `/abandon` load the task with a bare
 * `findUnique` (no include), so the pinned workflow only reaches the gate
 * through that fetch. The unit tests pin the semantics through a prisma mock;
 * this one runs the real routes against a real database, so a bare findUnique
 * that omitted the workflow key would be caught instead of assumed.
 *
 * The pinned workflow has `qa` as its review-like state and `todo` as its
 * initial state. `review` exists in it too, but is not review-like there
 * (no path to a terminal state), whereas it is review-like under the
 * built-in default the project falls back to.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";
import { groundingPostgres } from "../helpers/grounding-postgres.js";

const shared = vi.hoisted(() => ({ db: undefined as PrismaClient | undefined }));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: new Proxy(
    {},
    {
      get: (_target, key) => {
        if (!shared.db) throw new Error("test database not connected");
        const value = Reflect.get(shared.db, key);
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

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
let teamId: string;
let userId: string;
let agentTokenId: string;
let agent: Actor;

const pinnedDefinition = {
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

async function postJson(path: string) {
  const res = await makeApp(agent).request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** A project on the built-in default workflow (no stored default) and one task pinned to `pinnedDefinition`. */
async function seedPinnedTask(status: string, claimed = true) {
  const projectId = randomUUID();
  await db.project.create({ data: { id: projectId, teamId, name: "P", slug: randomUUID() } });
  const workflow = await db.workflow.create({
    data: { projectId, name: "pinned", isDefault: false, definition: pinnedDefinition },
  });
  const taskId = randomUUID();
  await db.task.create({
    data: {
      id: taskId,
      projectId,
      title: `Task ${taskId.slice(0, 8)}`,
      description: "Seeded task.",
      status,
      workflowId: workflow.id,
      createdByUserId: userId,
      ...(claimed ? { claimedByAgentId: agentTokenId, claimedAt: new Date() } : {}),
    },
  });
  return taskId;
}

const rowOf = (taskId: string) => db.task.findUniqueOrThrow({ where: { id: taskId } });

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
  accessMocks.hasProjectAccess.mockResolvedValue(true);
  accessMocks.hasProjectRole.mockResolvedValue(true);
  accessMocks.isProjectAdmin.mockResolvedValue(true);
  accessMocks.requireProjectWrite.mockResolvedValue(true);

  userId = randomUUID();
  await db.user.create({ data: { id: userId, login: `u-${userId}` } });
  teamId = randomUUID();
  await db.team.create({ data: { id: teamId, name: "Pinned", slug: randomUUID() } });
  await db.teamMember.create({ data: { teamId, userId, role: "ADMIN" } });
  const scopes = ["tasks:read", "tasks:claim", "tasks:transition", "tasks:update"];
  agentTokenId = randomUUID();
  await db.agentToken.create({
    data: { id: agentTokenId, teamId, createdById: userId, name: "author", tokenHash: randomUUID(), scopes },
  });
  agent = { type: "agent", tokenId: agentTokenId, teamId, userId, scopes };
});

describe("POST /release on a task pinned to a non-default workflow", () => {
  it("refuses with 409 in the pinned review state and leaves the row alone", async () => {
    const taskId = await seedPinnedTask("qa");

    const { status, body } = await postJson(`/tasks/${taskId}/release`);

    expect(status).toBe(409);
    expect(body.error).toBe("bad_state");
    const row = await rowOf(taskId);
    expect(row.status).toBe("qa");
    expect(row.claimedByAgentId).toBe(agentTokenId);
  });

  it("is not refused in a state that is review-like only under the default, and resets to the pinned initial state", async () => {
    const taskId = await seedPinnedTask("review");

    const { status, body } = await postJson(`/tasks/${taskId}/release`);

    expect(status).toBe(200);
    expect(body.task.inReviewState).toBe(false);
    const row = await rowOf(taskId);
    expect(row.status).toBe("todo");
    expect(row.claimedByAgentId).toBeNull();
  });
});

describe("POST /abandon on a task pinned to a non-default workflow", () => {
  it("refuses with 409 in the pinned review state and leaves the row alone", async () => {
    const taskId = await seedPinnedTask("qa");

    const { status, body } = await postJson(`/tasks/${taskId}/abandon`);

    expect(status).toBe(409);
    expect(body.error).toBe("bad_state");
    const row = await rowOf(taskId);
    expect(row.status).toBe("qa");
    expect(row.claimedByAgentId).toBe(agentTokenId);
  });

  it("is not refused in a state that is review-like only under the default, resets to the pinned initial state and answers inReviewState", async () => {
    const taskId = await seedPinnedTask("review");

    const { status, body } = await postJson(`/tasks/${taskId}/abandon`);

    expect(status).toBe(200);
    expect(body.task.inReviewState).toBe(false);
    const row = await rowOf(taskId);
    expect(row.status).toBe("todo");
    expect(row.claimedByAgentId).toBeNull();
  });

  it("resets a plain work state to the pinned initial state", async () => {
    const taskId = await seedPinnedTask("doing");

    const { status, body } = await postJson(`/tasks/${taskId}/abandon`);

    expect(status).toBe(200);
    expect(body.task.inReviewState).toBe(false);
    expect((await rowOf(taskId)).status).toBe("todo");
  });
});
