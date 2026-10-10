/**
 * DB-backed test for POST /tasks/:id/claim against a task that sits in review.
 *
 * An admin release frees the work claim of a task in review but leaves its
 * status alone. /claim used to accept any unclaimed row, so the review holder
 * (or anyone else) could take the work claim, which wrote the task back to
 * in_progress and, for the review holder, left one actor with both claims.
 * The locked revalidate now refuses a task outside the initial state and the
 * review holder as work claimant.
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

import { taskRouter } from "../../src/routes/tasks.js";

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
});
