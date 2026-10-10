/**
 * DB-backed test for POST /tasks/:id/claim against a task that sits in review.
 *
 * An admin release frees the work claim of a task in review but leaves its
 * status alone. /claim used to accept any unclaimed row, so the review holder
 * (or anyone else) could take the work claim, which wrote the task back to
 * in_progress and, for the review holder, left one actor with both claims.
 * The route now refuses a task outside the initial state and the review holder
 * as work claimant, ahead of the confidence and transition gates (a specific
 * 409), and repeats the identity rule under the project lock for a review
 * claim that lands between the read and the lock.
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

const claim = (actor: Actor, taskId: string) => makeApp(actor).request(`/tasks/${taskId}/claim`, { method: "POST" });
const reassign = (actor: Actor, taskId: string, body: Record<string, unknown>) =>
  makeApp(actor).request(`/tasks/${taskId}/admin-reassign`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const STATE_MESSAGE = (status: string) => `Task in '${status}' cannot be claimed — must be in initial state ('open')`;
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

describe("POST /tasks/:id/claim against Postgres", () => {
  it("claims an unclaimed task in the initial state", async () => {
    const taskId = await seedTask();
    const res = await claim(actorOf(holderId), taskId);
    expect(res.status).toBe(200);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("in_progress");
    expect(row.claimedByUserId).toBe(holderId);
  });

  it("refuses the review holder of a review task whose work claim was released, and keeps work=null, review=holder", async () => {
    const reviewedAt = new Date();
    const taskId = await seedTask({ status: "review", reviewClaimedByUserId: holderId, reviewClaimedAt: reviewedAt });
    const res = await claim(actorOf(holderId), taskId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "bad_state", message: STATE_MESSAGE("review") });
    expect(logAuditEvent).not.toHaveBeenCalled();
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("review");
    expect(row.claimedByUserId).toBeNull();
    expect(row.claimedByAgentId).toBeNull();
    expect(row.reviewClaimedByUserId).toBe(holderId);
    expect(row.reviewClaimedAt?.getTime()).toBe(reviewedAt.getTime());
  });

  it("refuses a distinct actor on a review task too: /claim must not pull a task out of review", async () => {
    const taskId = await seedTask({ status: "review", reviewClaimedByUserId: holderId, reviewClaimedAt: new Date() });
    const res = await claim(actorOf(otherId), taskId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "bad_state", message: STATE_MESSAGE("review") });
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("review");
    expect(row.claimedByUserId).toBeNull();
    expect(row.reviewClaimedByUserId).toBe(holderId);
  });

  it("refuses the review holder on a task already back in the initial state, but lets a distinct actor claim it", async () => {
    // A review lock left behind on an initial-state row: the status rule does
    // not apply, only the identity rule does.
    const taskId = await seedTask({ reviewClaimedByUserId: holderId, reviewClaimedAt: new Date() });
    const refused = await claim(actorOf(holderId), taskId);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "bad_state", message: REVIEW_HOLDER_MESSAGE });
    expect(logAuditEvent).not.toHaveBeenCalled();
    let row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("open");
    expect(row.claimedByUserId).toBeNull();
    expect(row.reviewClaimedByUserId).toBe(holderId);

    const allowed = await claim(actorOf(otherId), taskId);
    expect(allowed.status).toBe(200);
    row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.claimedByUserId).toBe(otherId);
    expect(row.reviewClaimedByUserId).toBe(holderId);
  });

  it("leaves the identity rule to the project's distinct-reviewer setting", async () => {
    const soloProject = randomUUID();
    await db.project.create({ data: { id: soloProject, teamId, name: "Solo", slug: randomUUID(), governanceMode: "AUTONOMOUS", requireDistinctReviewer: false, soloMode: true } });
    const taskId = await seedTask({ reviewClaimedByUserId: holderId, reviewClaimedAt: new Date() }, soloProject);
    const res = await claim(actorOf(holderId), taskId);
    expect(res.status).toBe(200);
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).claimedByUserId).toBe(holderId);
  });
  it("refuses an agent review holder and leaves the work claim unset", async () => {
    const tokenId = randomUUID();
    await db.agentToken.create({
      data: { id: tokenId, teamId, createdById: adminId, name: `agent-${tokenId.slice(0, 8)}`, tokenHash: tokenId, scopes: ["tasks:claim"] },
    });
    const agent: Actor = { type: "agent", tokenId, teamId, userId: adminId, scopes: ["tasks:claim"] };
    const taskId = await seedTask({ reviewClaimedByAgentId: tokenId, reviewClaimedAt: new Date() });
    const res = await makeApp(agent).request(`/tasks/${taskId}/claim`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "bad_state", message: REVIEW_HOLDER_MESSAGE });
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.claimedByAgentId).toBeNull();
    expect(row.reviewClaimedByAgentId).toBe(tokenId);
    // The confidence gate audits agent callers; a refusal must come before it.
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it("refuses an unclaimed task in a non-initial, non-review state of a custom workflow", async () => {
    await db.workflow.create({
      data: {
        id: randomUUID(),
        projectId,
        name: "custom",
        isDefault: true,
        definition: {
          initialState: "open",
          states: [
            { name: "open", label: "Open", terminal: false },
            { name: "in_progress", label: "In progress", terminal: false },
            { name: "blocked", label: "Blocked", terminal: false },
            { name: "review", label: "Review", terminal: false },
            { name: "done", label: "Done", terminal: true },
          ],
          transitions: [
            { from: "open", to: "in_progress", requiredRole: "any" },
            { from: "in_progress", to: "blocked", requiredRole: "any" },
            { from: "blocked", to: "in_progress", requiredRole: "any" },
            { from: "in_progress", to: "review", requiredRole: "any" },
            { from: "review", to: "done", requiredRole: "any" },
          ],
        } as never,
      },
    });
    const taskId = await seedTask({ status: "blocked" });
    const res = await claim(actorOf(otherId), taskId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "bad_state", message: STATE_MESSAGE("blocked") });
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("blocked");
    expect(row.claimedByUserId).toBeNull();
  });

  it("409s the claim under the lock when an admin reassigns the review claim to the claimant first", async () => {
    // The review lock is held by someone else when /claim reads the row, so the
    // pre-lock check passes; the reassign commits first and the locked
    // revalidate sees the claimant as the review holder.
    const taskId = await seedTask({ reviewClaimedByUserId: otherId, reviewClaimedAt: new Date() });
    const [reassigned, claimed] = await raceBehindProjectLock(
      () => reassign(actorOf(adminId), taskId, { claim: "review", target: { type: "human", id: holderId } }),
      () => claim(actorOf(holderId), taskId),
    );
    expect(reassigned.status).toBe(200);
    expect(claimed.status).toBe(409);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("open");
    expect(row.claimedByUserId).toBeNull();
    expect(row.reviewClaimedByUserId).toBe(holderId);
  });
});
