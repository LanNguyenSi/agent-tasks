/**
 * DB-backed test for the work branch of POST /tasks/:id/start (the MCP
 * task_start verb) when the caller holds the review claim.
 *
 * The work holder's self-service release of a task in review sets the status
 * back to open and keeps the review lock. /start used to claim any unclaimed
 * row in the initial state, so the review holder took the work claim and ended
 * with both claims. Under a distinct-reviewer project the route now answers a
 * specific 409 ahead of the confidence and transition gates, and repeats the
 * rule under the project lock for a review claim that lands between the read
 * and the lock.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";
import { barrier, groundingPostgres } from "../helpers/grounding-postgres.js";

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

import { taskRouter } from "../../src/routes/tasks.js";
import { logAuditEvent } from "../../src/services/audit.js";

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
let teamId: string;
let projectId: string;
let adminId: string;
let holderId: string; // review holder X
let otherId: string; // a distinct teammate Y

const actorOf = (userId: string): Actor => ({ type: "human", userId });

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

const start = (actor: Actor, taskId: string) => makeApp(actor).request(`/tasks/${taskId}/start`, { method: "POST" });
const release = (actor: Actor, taskId: string) => makeApp(actor).request(`/tasks/${taskId}/release`, { method: "POST" });
const reassign = (actor: Actor, taskId: string, body: Record<string, unknown>) =>
  makeApp(actor).request(`/tasks/${taskId}/admin-reassign`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const REVIEW_HOLDER_MESSAGE =
  "You hold this task's review claim; under this project's distinct-reviewer rule the reviewer cannot also take the work claim";

/**
 * Parks two requests behind the project row lock a third connection holds, in
 * arrival order, then releases it: both pass their pre-lock read before either
 * commits, so the second one is decided by the locked revalidate alone.
 */
async function raceBehindProjectLock(first: () => Response | Promise<Response>, second: () => Response | Promise<Response>) {
  const requestDb = store.connect(4);
  const blocker = store.connect();
  const observer = store.connect();
  const hold = barrier();
  let blockingPid = 0;
  const held = blocker.$transaction(
    async (tx) => {
      const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid FROM projects WHERE id = ${projectId} FOR UPDATE`;
      blockingPid = row!.pid;
      await hold.wait();
    },
    { timeout: 20000 },
  );
  await hold.reached;
  // Postgres queues lock waiters in arrival order, so counting the backends
  // blocked on the holder, directly or behind another waiter, tells that both
  // requests are parked, first one first.
  const waiters = async () => {
    const [row] = await observer.$queryRaw<{ n: number }[]>`
      WITH RECURSIVE chain(pid) AS (
        SELECT pid FROM pg_stat_activity WHERE ${blockingPid}::int = ANY(pg_blocking_pids(pid))
        UNION
        SELECT a.pid FROM pg_stat_activity a JOIN chain c ON c.pid = ANY(pg_blocking_pids(a.pid))
      )
      SELECT count(*)::int AS n FROM chain`;
    return row!.n;
  };
  const waitForWaiters = async (n: number) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if ((await waiters()) >= n) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`expected ${n} request(s) queued on the held project lock`);
  };
  const previous = shared.db;
  shared.db = requestDb;
  // Requests still in flight when a waiter check throws must settle before
  // their client disconnects.
  const pending: Promise<Response>[] = [];
  try {
    const firstPending = Promise.resolve(first());
    pending.push(firstPending);
    await waitForWaiters(1);
    const secondPending = Promise.resolve(second());
    pending.push(secondPending);
    await waitForWaiters(2);
    hold.release();
    await held;
    return await Promise.all([firstPending, secondPending]);
  } finally {
    hold.release();
    await held.catch(() => undefined);
    await Promise.allSettled(pending);
    shared.db = previous;
    await Promise.all([requestDb, blocker, observer].map((client) => client.$disconnect()));
  }
}

async function seedUser(label: string) {
  const id = randomUUID();
  await db.user.create({ data: { id, login: `${label}-${id}`, name: label } });
  return id;
}

async function seedTask(overrides: Record<string, unknown> = {}, inProject = projectId) {
  const id = randomUUID();
  await db.task.create({
    data: { id, projectId: inProject, title: `Task ${id.slice(0, 8)}`, description: "d", status: "open", createdByUserId: adminId, ...overrides },
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
  adminId = await seedUser("admin");
  holderId = await seedUser("holder");
  otherId = await seedUser("other");
  teamId = randomUUID();
  await db.team.create({ data: { id: teamId, name: "Claim", slug: randomUUID() } });
  for (const [userId, role] of [[adminId, "ADMIN"], [holderId, "HUMAN_MEMBER"], [otherId, "HUMAN_MEMBER"]] as const) {
    await db.teamMember.create({ data: { teamId, userId, role } });
  }
  projectId = randomUUID();
  await db.project.create({ data: { id: projectId, teamId, name: "Claim", slug: randomUUID(), governanceMode: "REQUIRES_DISTINCT_REVIEWER", requireDistinctReviewer: true, soloMode: false } });
});

describe("POST /tasks/:id/start work branch against Postgres", () => {
  const seedReviewedTask = (workerId: string) =>
    seedTask({
      status: "review",
      claimedByUserId: workerId,
      claimedAt: new Date(),
      reviewClaimedByUserId: holderId,
      reviewClaimedAt: new Date(),
      branchName: "feature/x",
      prUrl: "https://github.com/x/y/pull/1",
      prNumber: 1,
    });

  it("starts an unclaimed task in the initial state", async () => {
    const taskId = await seedTask();
    const res = await start(actorOf(holderId), taskId);
    expect(res.status).toBe(200);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("in_progress");
    expect(row.claimedByUserId).toBe(holderId);
  });

  it("refuses the review holder after the work holder released the task from review, and keeps work=null, review=holder", async () => {
    const workerId = await seedUser("worker");
    await db.teamMember.create({ data: { teamId, userId: workerId, role: "HUMAN_MEMBER" } });
    const taskId = await seedReviewedTask(workerId);
    const released = await release(actorOf(workerId), taskId);
    expect(released.status).toBe(200);
    let row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("open");
    expect(row.claimedByUserId).toBeNull();
    expect(row.reviewClaimedByUserId).toBe(holderId);
    const reviewedAt = row.reviewClaimedAt?.getTime();
    vi.mocked(logAuditEvent).mockClear();

    const res = await start(actorOf(holderId), taskId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "bad_state", message: REVIEW_HOLDER_MESSAGE });
    expect(logAuditEvent).not.toHaveBeenCalled();
    row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("open");
    expect(row.claimedByUserId).toBeNull();
    expect(row.claimedByAgentId).toBeNull();
    expect(row.reviewClaimedByUserId).toBe(holderId);
    expect(row.reviewClaimedAt?.getTime()).toBe(reviewedAt);

    // A distinct teammate may still take the work claim; the review lock stays.
    const allowed = await start(actorOf(otherId), taskId);
    expect(allowed.status).toBe(200);
    row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.claimedByUserId).toBe(otherId);
    expect(row.reviewClaimedByUserId).toBe(holderId);
  });

  it("leaves the identity rule to the project's distinct-reviewer setting", async () => {
    const soloProject = randomUUID();
    await db.project.create({ data: { id: soloProject, teamId, name: "Solo", slug: randomUUID(), governanceMode: "AUTONOMOUS", requireDistinctReviewer: false, soloMode: true } });
    const taskId = await seedTask({ reviewClaimedByUserId: holderId, reviewClaimedAt: new Date() }, soloProject);
    const res = await start(actorOf(holderId), taskId);
    expect(res.status).toBe(200);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("in_progress");
    expect(row.claimedByUserId).toBe(holderId);
  });

  it("refuses an agent review holder before the confidence gate audits and leaves the work claim unset", async () => {
    const scopes = ["tasks:claim", "tasks:transition"];
    const tokenId = randomUUID();
    await db.agentToken.create({
      data: { id: tokenId, teamId, createdById: adminId, name: `agent-${tokenId.slice(0, 8)}`, tokenHash: tokenId, scopes },
    });
    const agent: Actor = { type: "agent", tokenId, teamId, userId: adminId, scopes };
    const taskId = await seedTask({ reviewClaimedByAgentId: tokenId, reviewClaimedAt: new Date() });
    const res = await start(agent, taskId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "bad_state", message: REVIEW_HOLDER_MESSAGE });
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.claimedByAgentId).toBeNull();
    expect(row.reviewClaimedByAgentId).toBe(tokenId);
    // The confidence gate audits agent callers; a refusal must come before it.
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it("409s the start under the lock when an admin reassigns the review claim to the starter first", async () => {
    // The review lock is held by someone else when /start reads the row, so the
    // pre-lock check passes; the reassign commits first and the locked
    // revalidate sees the starter as the review holder.
    const taskId = await seedTask({ reviewClaimedByUserId: otherId, reviewClaimedAt: new Date() });
    const [reassigned, started] = await raceBehindProjectLock(
      () => reassign(actorOf(adminId), taskId, { claim: "review", target: { type: "human", id: holderId } }),
      () => start(actorOf(holderId), taskId),
    );
    expect(reassigned.status).toBe(200);
    expect(started.status).toBe(409);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("open");
    expect(row.claimedByUserId).toBeNull();
    expect(row.reviewClaimedByUserId).toBe(holderId);
  });
});
