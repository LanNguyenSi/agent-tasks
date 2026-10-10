/**
 * DB-backed test for the work pool of POST /tasks/pickup (the MCP task_pickup
 * verb) when the caller holds the review lock of an open task.
 *
 * A task can sit in the initial state with no work claim and a review lock
 * still set. Under a distinct-reviewer project task_start refuses the review
 * holder on it with a 409, so the pool must not offer it back to that holder;
 * otherwise the agent loops pickup -> start -> 409. Other callers, other
 * governance modes and the holder's other tasks are unaffected.
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
vi.mock("../../src/services/github-merge.js", () => ({ performPrMerge: vi.fn() }));
vi.mock("../../src/services/github-delegation.js", () => ({
  findDelegationUser: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../src/services/board-default.js", () => ({
  ensureDefaultBoardForProject: vi.fn().mockResolvedValue(undefined),
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
let projectId: string;
let adminId: string;
let holder: Actor; // agent holding the review lock
let other: Actor; // a distinct agent

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

const pickup = (actor: Actor) => makeApp(actor).request("/tasks/pickup", { method: "POST" });
const start = (actor: Actor, taskId: string) => makeApp(actor).request(`/tasks/${taskId}/start`, { method: "POST" });

async function seedAgent(): Promise<Actor> {
  const scopes = ["tasks:read", "tasks:claim", "tasks:transition"];
  const tokenId = randomUUID();
  await db.agentToken.create({
    data: { id: tokenId, teamId, createdById: adminId, name: `agent-${tokenId.slice(0, 8)}`, tokenHash: tokenId, scopes },
  });
  return { type: "agent", tokenId, teamId, userId: adminId, scopes };
}

async function seedProject(governanceMode: "REQUIRES_DISTINCT_REVIEWER" | "AUTONOMOUS", requireDistinctReviewer: boolean, soloMode: boolean) {
  const id = randomUUID();
  await db.project.create({ data: { id, teamId, name: governanceMode, slug: randomUUID(), governanceMode, requireDistinctReviewer, soloMode } });
  return id;
}

async function seedTask(overrides: Record<string, unknown> = {}, inProject = projectId) {
  const id = randomUUID();
  await db.task.create({
    data: { id, projectId: inProject, title: `Task ${id.slice(0, 8)}`, description: "d", status: "open", createdByUserId: adminId, ...overrides },
  });
  return id;
}

const reviewLockedBy = (actor: Actor) => ({
  reviewClaimedByAgentId: actor.type === "agent" ? actor.tokenId : null,
  reviewClaimedAt: new Date(),
});

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
  adminId = randomUUID();
  await db.user.create({ data: { id: adminId, login: `admin-${adminId}`, name: "admin" } });
  teamId = randomUUID();
  await db.team.create({ data: { id: teamId, name: "Pickup", slug: randomUUID() } });
  await db.teamMember.create({ data: { teamId, userId: adminId, role: "ADMIN" } });
  projectId = await seedProject("REQUIRES_DISTINCT_REVIEWER", true, false);
  holder = await seedAgent();
  other = await seedAgent();
});

describe("POST /tasks/pickup work pool against Postgres", () => {
  it("does not offer a task whose review lock the caller holds under a distinct-reviewer project", async () => {
    const taskId = await seedTask(reviewLockedBy(holder));
    // The route the pool must agree with: task_start refuses this very caller.
    expect((await start(holder, taskId)).status).toBe(409);

    const res = await pickup(holder);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "idle" });
  });

  it("offers the holder the next task instead, and the locked task to another caller", async () => {
    const lockedId = await seedTask(reviewLockedBy(holder), projectId);
    const freeId = await seedTask({}, projectId);

    const mine = await (await pickup(holder)).json();
    expect(mine.kind).toBe("work");
    expect(mine.task.id).toBe(freeId);

    const theirs = await pickup(other);
    const body = await theirs.json();
    expect(body.kind).toBe("work");
    expect([lockedId, freeId]).toContain(body.task.id);
    expect((await start(other, lockedId)).status).toBe(200);
  });

  it("still offers the task to a caller who does not hold the review lock", async () => {
    const taskId = await seedTask(reviewLockedBy(holder));
    const body = await (await pickup(other)).json();
    expect(body.kind).toBe("work");
    expect(body.task.id).toBe(taskId);
  });

  it("still offers the task to the review holder when the project permits self-review", async () => {
    const autonomous = await seedProject("AUTONOMOUS", false, true);
    const taskId = await seedTask(reviewLockedBy(holder), autonomous);
    const body = await (await pickup(holder)).json();
    expect(body.kind).toBe("work");
    expect(body.task.id).toBe(taskId);
    expect((await start(holder, taskId)).status).toBe(200);
  });
});
