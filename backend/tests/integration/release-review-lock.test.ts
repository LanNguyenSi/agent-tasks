/**
 * DB-backed test for POST /tasks/:id/release against a task that sits in
 * review.
 *
 * The release resets the status to the workflow's initial state but never
 * touched the review lock, so the author's release of a task in review left an
 * `open` task with a stale review lock (the enabling cause of one actor holding
 * both claims). The route now refuses in a review state, like /abandon does,
 * and keeps working for a work holder in a work state.
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
import { logAuditEvent } from "../../src/services/audit.js";

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
let teamId: string;
let projectId: string;
let adminId: string;
let authorId: string; // work claim holder
let reviewerId: string; // review lock holder

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

const release = (actor: Actor, taskId: string) => makeApp(actor).request(`/tasks/${taskId}/release`, { method: "POST" });
const abandon = (actor: Actor, taskId: string) => makeApp(actor).request(`/tasks/${taskId}/abandon`, { method: "POST" });

const REVIEW_MESSAGE =
  "Cannot release a work claim while the task is in review. Wait for the reviewer to approve or request changes.";

async function seedUser(label: string) {
  const id = randomUUID();
  await db.user.create({ data: { id, login: `${label}-${id}`, name: label } });
  return id;
}

async function seedTask(overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  await db.task.create({
    data: { id, projectId, title: `Task ${id.slice(0, 8)}`, description: "d", status: "open", createdByUserId: adminId, ...overrides },
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
  authorId = await seedUser("author");
  reviewerId = await seedUser("reviewer");
  teamId = randomUUID();
  await db.team.create({ data: { id: teamId, name: "Release", slug: randomUUID() } });
  for (const [userId, role] of [[adminId, "ADMIN"], [authorId, "HUMAN_MEMBER"], [reviewerId, "HUMAN_MEMBER"]] as const) {
    await db.teamMember.create({ data: { teamId, userId, role } });
  }
  projectId = randomUUID();
  await db.project.create({
    data: { id: projectId, teamId, name: "Release", slug: randomUUID(), governanceMode: "REQUIRES_DISTINCT_REVIEWER", requireDistinctReviewer: true, soloMode: false },
  });
});

describe("POST /tasks/:id/release against Postgres", () => {
  it("releases a work claim held in a work state: back to open, claim cleared", async () => {
    const taskId = await seedTask({ status: "in_progress", claimedByUserId: authorId, claimedAt: new Date() });
    const res = await release(actorOf(authorId), taskId);
    expect(res.status).toBe(200);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("open");
    expect(row.claimedByUserId).toBeNull();
    expect(row.claimedByAgentId).toBeNull();
    expect(row.claimedAt).toBeNull();
    expect(row.reviewClaimedByUserId).toBeNull();
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "task.released", taskId }));
  });

  it("refuses the work claim holder of a task in review and leaves the task, the work claim and the review lock untouched", async () => {
    const claimedAt = new Date();
    const reviewedAt = new Date();
    const taskId = await seedTask({
      status: "review",
      claimedByUserId: authorId,
      claimedAt,
      reviewClaimedByUserId: reviewerId,
      reviewClaimedAt: reviewedAt,
    });
    const before = await db.task.findUniqueOrThrow({ where: { id: taskId } });

    const res = await release(actorOf(authorId), taskId);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "bad_state", message: REVIEW_MESSAGE });
    expect(logAuditEvent).not.toHaveBeenCalled();
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("review");
    expect(row.statusVersion).toBe(before.statusVersion);
    expect(row.claimedByUserId).toBe(authorId);
    expect(row.claimedAt?.getTime()).toBe(claimedAt.getTime());
    expect(row.reviewClaimedByUserId).toBe(reviewerId);
    expect(row.reviewClaimedAt?.getTime()).toBe(reviewedAt.getTime());
  });

  it("refuses a task in review that has no review lock yet, too", async () => {
    const taskId = await seedTask({ status: "review", claimedByUserId: authorId, claimedAt: new Date() });
    const res = await release(actorOf(authorId), taskId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "bad_state", message: REVIEW_MESSAGE });
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("review");
    expect(row.claimedByUserId).toBe(authorId);
  });

  it("never leaves the initial state with a review lock: the release outcomes of a review task agree with /abandon", async () => {
    const reviewTask = () =>
      seedTask({ status: "review", claimedByUserId: authorId, claimedAt: new Date(), reviewClaimedByUserId: reviewerId, reviewClaimedAt: new Date() });
    const viaRelease = await reviewTask();
    const viaAbandon = await reviewTask();

    const releaseRes = await release(actorOf(authorId), viaRelease);
    const abandonRes = await abandon(actorOf(authorId), viaAbandon);

    expect(releaseRes.status).toBe(409);
    expect(abandonRes.status).toBe(409);
    for (const id of [viaRelease, viaAbandon]) {
      const row = await db.task.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("review");
      expect(row.reviewClaimedByUserId).toBe(reviewerId);
    }
  });

  it("still answers 403 to an actor that does not hold the work claim, ahead of the state check", async () => {
    const taskId = await seedTask({ status: "review", claimedByUserId: authorId, claimedAt: new Date(), reviewClaimedByUserId: reviewerId, reviewClaimedAt: new Date() });
    const res = await release(actorOf(reviewerId), taskId);
    expect(res.status).toBe(403);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("review");
    expect(row.claimedByUserId).toBe(authorId);
  });
});
