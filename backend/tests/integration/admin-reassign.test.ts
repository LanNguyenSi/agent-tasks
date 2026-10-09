/**
 * DB-backed tests for the project-admin claim handoff:
 * `GET /projects/:id/eligible-actors` and `POST /tasks/:id/admin-reassign`.
 *
 * The unit suites mock the database and the access helpers; this file runs the
 * real queries (the eligible-set filters, the single-active-claim lookup, the
 * holder-pinned write) and the real authorization helpers against Postgres.
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
import { projectRouter } from "../../src/routes/projects.js";
import { logAuditEvent } from "../../src/services/audit.js";

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
let teamId: string;
let projectId: string;

let adminId: string; // team ADMIN
let memberId: string; // team HUMAN_MEMBER
let memberTwoId: string; // team HUMAN_MEMBER
let projectOnlyId: string; // PROJECT_CONTRIBUTOR, no team membership
let projectAdminId: string; // PROJECT_ADMIN, no team membership
let viewerId: string; // PROJECT_VIEWER, no team membership
let outsiderId: string; // no access at all

const actorOf = (userId: string): Actor => ({ type: "human", userId });

function makeApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("groundingRemoteTargetGuard", null);
    await next();
  });
  app.route("/", taskRouter);
  app.route("/", projectRouter);
  return app;
}

const reassign = (actor: Actor, taskId: string, body: Record<string, unknown>) =>
  makeApp(actor).request(`/tasks/${taskId}/admin-reassign`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const eligibleActors = (actor: Actor, id = projectId) => makeApp(actor).request(`/projects/${id}/eligible-actors`);

async function seedUser(label: string) {
  const id = randomUUID();
  await db.user.create({ data: { id, login: `${label}-${id}`, name: label } });
  return id;
}

async function seedToken(overrides: { revokedAt?: Date | null; expiresAt?: Date | null; teamId?: string } = {}) {
  const id = randomUUID();
  await db.agentToken.create({
    data: { id, teamId: overrides.teamId ?? teamId, createdById: adminId, name: `agent-${id.slice(0, 8)}`, tokenHash: id, scopes: ["tasks:claim"], ...overrides },
  });
  return id;
}

async function seedTask(overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  await db.task.create({
    data: { id, projectId, title: `Task ${id.slice(0, 8)}`, description: "d", status: "in_progress", createdByUserId: adminId, ...overrides },
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
  memberId = await seedUser("member");
  memberTwoId = await seedUser("member-two");
  projectOnlyId = await seedUser("project-only");
  projectAdminId = await seedUser("project-admin");
  viewerId = await seedUser("viewer");
  outsiderId = await seedUser("outsider");
  teamId = randomUUID();
  await db.team.create({ data: { id: teamId, name: "Reassign", slug: randomUUID() } });
  for (const [userId, role] of [[adminId, "ADMIN"], [memberId, "HUMAN_MEMBER"], [memberTwoId, "HUMAN_MEMBER"]] as const) {
    await db.teamMember.create({ data: { teamId, userId, role } });
  }
  projectId = randomUUID();
  await db.project.create({ data: { id: projectId, teamId, name: "Reassign", slug: randomUUID(), governanceMode: "REQUIRES_DISTINCT_REVIEWER", requireDistinctReviewer: true, soloMode: false } });
  for (const [userId, role] of [[projectOnlyId, "PROJECT_CONTRIBUTOR"], [projectAdminId, "PROJECT_ADMIN"], [viewerId, "PROJECT_VIEWER"]] as const) {
    await db.projectMember.create({ data: { projectId, userId, role, invitedById: adminId } });
  }
});

describe("GET /projects/:id/eligible-actors against Postgres", () => {
  it("returns team members, non-viewer project members and live team tokens, once each", async () => {
    const live = await seedToken();
    const future = await seedToken({ expiresAt: new Date(Date.now() + 86_400_000) });
    await seedToken({ revokedAt: new Date() });
    await seedToken({ expiresAt: new Date(Date.now() - 86_400_000) });
    const otherTeam = randomUUID();
    await db.team.create({ data: { id: otherTeam, name: "Other", slug: randomUUID() } });
    await seedToken({ teamId: otherTeam });
    // A team member who is also a project member is listed once, as a team member.
    await db.projectMember.create({ data: { projectId, userId: memberId, role: "PROJECT_CONTRIBUTOR", invitedById: adminId } });

    const res = await eligibleActors(actorOf(adminId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { humans: Array<{ userId: string; name: string; source: string; role: string }>; agents: Array<{ tokenId: string; name: string }> };

    expect(body.humans.map((h) => h.userId).sort()).toEqual([adminId, memberId, memberTwoId, projectOnlyId, projectAdminId].sort());
    expect(body.humans.find((h) => h.userId === viewerId)).toBeUndefined();
    expect(body.humans.find((h) => h.userId === outsiderId)).toBeUndefined();
    expect(body.humans.find((h) => h.userId === memberId)).toMatchObject({ source: "team", role: "HUMAN_MEMBER", name: "member" });
    expect(body.humans.find((h) => h.userId === projectOnlyId)).toMatchObject({ source: "project", role: "PROJECT_CONTRIBUTOR" });
    expect(body.humans.find((h) => h.userId === projectAdminId)).toMatchObject({ source: "project", role: "PROJECT_ADMIN" });
    expect(body.agents.map((a) => a.tokenId).sort()).toEqual([live, future].sort());
    expect(Object.keys(body.agents[0]!).sort()).toEqual(["name", "tokenId"]);
  });

  it("is available to a project-only PROJECT_ADMIN and refused to a contributor, a viewer, an outsider and an agent", async () => {
    expect((await eligibleActors(actorOf(projectAdminId))).status).toBe(200);
    expect((await eligibleActors(actorOf(projectOnlyId))).status).toBe(403);
    expect((await eligibleActors(actorOf(memberId))).status).toBe(403);
    expect((await eligibleActors(actorOf(viewerId))).status).toBe(403);
    expect((await eligibleActors(actorOf(outsiderId))).status).toBe(403);
    const agent: Actor = { type: "agent", tokenId: await seedToken(), teamId, userId: adminId, scopes: ["tasks:read"] };
    expect((await eligibleActors(agent)).status).toBe(403);
  });

  it("404s an unknown project", async () => {
    expect((await eligibleActors(actorOf(adminId), randomUUID())).status).toBe(404);
  });
});

describe("POST /tasks/:id/admin-reassign against Postgres", () => {
  it("lets a project-only PROJECT_ADMIN hand a work claim to a project-only contributor, refreshing claimedAt and clearing the agent column", async () => {
    const tokenId = await seedToken();
    const longAgo = new Date(Date.now() - 86_400_000);
    const taskId = await seedTask({ claimedByAgentId: tokenId, claimedAt: longAgo });

    const res = await reassign(actorOf(projectAdminId), taskId, { claim: "work", target: { type: "human", id: projectOnlyId }, reason: "handoff" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      task: { status: "in_progress", claimedByUserId: projectOnlyId, claimedByAgentId: null },
      reassigned: { claim: "work", priorHolder: { type: "agent", id: tokenId }, newHolder: { type: "human", id: projectOnlyId } },
    });
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.claimedAt!.getTime()).toBeGreaterThan(longAgo.getTime());
    expect(row.status).toBe("in_progress");
    expect(logAuditEvent).toHaveBeenCalledTimes(1);
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.claim_reassigned",
        actorId: projectAdminId,
        payload: { claim: "work", priorHolder: { type: "agent", id: tokenId }, newHolder: { type: "human", id: projectOnlyId }, reason: "handoff" },
      }),
    );
  });

  it("refuses a team member, a project contributor and an outsider with 403 and changes nothing", async () => {
    const taskId = await seedTask({ claimedByUserId: memberId, claimedAt: new Date() });
    for (const userId of [memberTwoId, projectOnlyId, viewerId, outsiderId]) {
      const res = await reassign(actorOf(userId), taskId, { claim: "work", target: { type: "human", id: memberTwoId } });
      expect(res.status).toBe(403);
    }
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).claimedByUserId).toBe(memberId);
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it("refuses a target outside the eligible set: a viewer, an outsider, a revoked token, an expired token", async () => {
    const taskId = await seedTask({ claimedByUserId: memberId, claimedAt: new Date() });
    const revoked = await seedToken({ revokedAt: new Date() });
    const expired = await seedToken({ expiresAt: new Date(Date.now() - 1000) });
    for (const target of [
      { type: "human", id: viewerId },
      { type: "human", id: outsiderId },
      { type: "agent", id: revoked },
      { type: "agent", id: expired },
    ]) {
      const res = await reassign(actorOf(adminId), taskId, { claim: "work", target });
      expect(res.status).toBe(400);
    }
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).claimedByUserId).toBe(memberId);
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it("rejects an AGENT target that holds another active claim (work or review) with the activeClaim shape; a HUMAN target is exempt", async () => {
    const busyAuthor = await seedToken();
    const busyReviewer = await seedToken();
    const authorTask = await seedTask({ title: "Agent authoring", claimedByAgentId: busyAuthor, claimedAt: new Date() });
    const reviewTask = await seedTask({ title: "Agent reviewing", status: "review", claimedByUserId: memberTwoId, reviewClaimedByAgentId: busyReviewer, reviewClaimedAt: new Date() });
    const movable = await seedTask({ claimedByUserId: memberId, claimedAt: new Date() });

    const asAuthor = await reassign(actorOf(adminId), movable, { claim: "work", target: { type: "agent", id: busyAuthor } });
    expect(asAuthor.status).toBe(409);
    expect(await asAuthor.json()).toMatchObject({ error: "already_claimed", activeClaim: { taskId: authorTask, title: "Agent authoring", role: "author" } });

    const asReviewer = await reassign(actorOf(adminId), movable, { claim: "work", target: { type: "agent", id: busyReviewer } });
    expect(asReviewer.status).toBe(409);
    expect(await asReviewer.json()).toMatchObject({ error: "already_claimed", activeClaim: { taskId: reviewTask, title: "Agent reviewing", role: "reviewer" } });
    expect((await db.task.findUniqueOrThrow({ where: { id: movable } })).claimedByUserId).toBe(memberId);

    // The same tasks do not block a human target, and a done task's claim does not count for an agent.
    expect((await reassign(actorOf(adminId), movable, { claim: "work", target: { type: "human", id: memberTwoId } })).status).toBe(200);
    const finished = await seedToken();
    await seedTask({ status: "done", claimedByAgentId: finished });
    expect((await reassign(actorOf(adminId), movable, { claim: "work", target: { type: "agent", id: finished } })).status).toBe(200);
    expect((await db.task.findUniqueOrThrow({ where: { id: movable } })).claimedByAgentId).toBe(finished);
  });

  it("does not count the task being reassigned as the agent's other claim", async () => {
    const agentId = await seedToken();
    // The agent holds the review claim on this very task and nothing else; the
    // work claim moves to it. Without the exclusion of the task being moved,
    // the agent's own review claim here would read as "another active claim".
    const taskId = await seedTask({ status: "review", claimedByUserId: memberId, claimedAt: new Date(), reviewClaimedByAgentId: agentId, reviewClaimedAt: new Date() });
    await db.project.update({ where: { id: projectId }, data: { governanceMode: "AUTONOMOUS", requireDistinctReviewer: false, soloMode: true } });
    const res = await reassign(actorOf(adminId), taskId, { claim: "work", target: { type: "agent", id: agentId } });
    expect(res.status).toBe(200);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.claimedByAgentId).toBe(agentId);
    expect(row.reviewClaimedByAgentId).toBe(agentId);
  });

  it("refuses to hand the review claim to the work claimant when a distinct reviewer is required, and allows it otherwise", async () => {
    const taskId = await seedTask({ status: "review", claimedByUserId: memberId, reviewClaimedByUserId: memberTwoId, reviewClaimedAt: new Date() });
    const refused = await reassign(actorOf(adminId), taskId, { claim: "review", target: { type: "human", id: memberId } });
    expect(refused.status).toBe(409);
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).reviewClaimedByUserId).toBe(memberTwoId);

    await db.project.update({ where: { id: projectId }, data: { governanceMode: "AUTONOMOUS", requireDistinctReviewer: false, soloMode: true } });
    const allowed = await reassign(actorOf(adminId), taskId, { claim: "review", target: { type: "human", id: memberId } });
    expect(allowed.status).toBe(200);
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).reviewClaimedByUserId).toBe(memberId);
  });

  it("refuses to hand the work claim to the current review holder when a distinct reviewer is required, and allows it otherwise", async () => {
    const reviewerAgent = await seedToken();
    const taskId = await seedTask({ status: "review", claimedByUserId: memberId, claimedAt: new Date(), reviewClaimedByUserId: memberTwoId, reviewClaimedAt: new Date() });
    const refused = await reassign(actorOf(adminId), taskId, { claim: "work", target: { type: "human", id: memberTwoId } });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { message: string }).message).toMatch(/distinct reviewer/);
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).claimedByUserId).toBe(memberId);

    // An agent review holder is refused the work claim too.
    const agentReviewed = await seedTask({ status: "review", claimedByUserId: memberId, claimedAt: new Date(), reviewClaimedByAgentId: reviewerAgent, reviewClaimedAt: new Date() });
    const refusedAgent = await reassign(actorOf(adminId), agentReviewed, { claim: "work", target: { type: "agent", id: reviewerAgent } });
    expect(refusedAgent.status).toBe(409);
    expect((await db.task.findUniqueOrThrow({ where: { id: agentReviewed } })).claimedByUserId).toBe(memberId);
    expect(logAuditEvent).not.toHaveBeenCalled();

    await db.project.update({ where: { id: projectId }, data: { governanceMode: "AUTONOMOUS", requireDistinctReviewer: false, soloMode: true } });
    const allowed = await reassign(actorOf(adminId), taskId, { claim: "work", target: { type: "human", id: memberTwoId } });
    expect(allowed.status).toBe(200);
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).claimedByUserId).toBe(memberTwoId);
  });

  it("409s for a claim with no holder and for a target that already holds it, writing nothing", async () => {
    const unclaimed = await seedTask({ status: "open" });
    const held = await seedTask({ claimedByUserId: memberId, claimedAt: new Date() });
    expect((await reassign(actorOf(adminId), unclaimed, { claim: "work", target: { type: "human", id: memberId } })).status).toBe(409);
    expect((await reassign(actorOf(adminId), held, { claim: "review", target: { type: "human", id: memberId } })).status).toBe(409);
    expect((await reassign(actorOf(adminId), held, { claim: "work", target: { type: "human", id: memberId } })).status).toBe(409);
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it("answers 409 merge_in_progress and leaves the claim alone while a merge reservation is live", async () => {
    const taskId = await seedTask({ claimedByUserId: memberId, claimedAt: new Date(), mergeReservedAt: new Date(), mergeReservedByUserId: memberTwoId });
    const res = await reassign(actorOf(adminId), taskId, { claim: "work", target: { type: "human", id: memberTwoId } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("merge_in_progress");
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).claimedByUserId).toBe(memberId);
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it("loses the holder-pinned write to a concurrent hand-off and never overwrites the new holder", async () => {
    const taskId = await seedTask({ claimedByUserId: memberId, claimedAt: new Date() });
    // The claim changes hands right after the route first reads the task.
    const real = shared.db!;
    const original = real.task.findUnique.bind(real.task);
    let moved = false;
    const spy = vi.spyOn(real.task, "findUnique").mockImplementation(((...args: Parameters<typeof original>) => {
      const result = original(...args);
      if (moved) return result;
      moved = true;
      return (async () => {
        const row = await result;
        await real.task.update({ where: { id: taskId }, data: { claimedByUserId: projectOnlyId } });
        return row;
      })();
    }) as never);
    try {
      const res = await reassign(actorOf(adminId), taskId, { claim: "work", target: { type: "human", id: memberTwoId } });
      expect(res.status).toBe(409);
    } finally {
      spy.mockRestore();
    }
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).claimedByUserId).toBe(projectOnlyId);
    expect(logAuditEvent).not.toHaveBeenCalled();
  });
});
