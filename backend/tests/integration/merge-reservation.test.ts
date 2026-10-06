/**
 * DB-backed tests for the persisted merge reservation (agent-tasks eb08742f).
 *
 * The paths that merge a PR on GitHub read the task, evaluate the
 * distinct-reviewer / self-merge gates, call GitHub (irreversible) and only
 * then write. A review lock released between the gate and the merge used to let
 * the merge land. The merge now takes a leased reservation on the task right
 * before the GitHub call, and every claim and status writer refuses with
 * `409 merge_in_progress` while it is live.
 *
 * The interleavings are deterministic, not timing based. The GitHub merge is a
 * stand-in (`performPrMerge`) that runs the merge-reservation hook the real
 * function runs right before its fetch, and then, still "inside the GitHub
 * call", fires the request under test through a real handler against the real
 * database. A writer that is not refused would change the row exactly the way
 * the race does.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";
import { groundingPostgres } from "../helpers/grounding-postgres.js";

const shared = vi.hoisted(() => ({
  db: undefined as PrismaClient | undefined,
  // Runs once, right after the handler under test first reads the task row
  // (the window between the gate and the merge call).
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

// The GitHub merge call. The stand-in runs the same hook the real function
// runs right before its fetch (so the reservation is taken exactly where the
// handlers take it) and lets a test run code "inside the GitHub call".
const github = vi.hoisted(() => ({
  performPrMerge: vi.fn(),
  /** How many times the stand-in reached the point of calling GitHub. */
  githubCalls: 0,
  /** Runs inside the GitHub call, after the reservation was taken. */
  insideMerge: null as (() => Promise<void>) | null,
  /** What the GitHub call answers. */
  answer: { ok: true, sha: "deadbeef", alreadyMerged: false } as
    | { ok: true; sha: string; alreadyMerged: boolean }
    | { ok: false; error: string; message: string; status: number; outcomeUnknown?: true },
  throws: null as Error | null,
}));
vi.mock("../../src/services/github-merge.js", () => ({ performPrMerge: github.performPrMerge }));
vi.mock("../../src/services/github-delegation.js", () => ({
  findDelegationUser: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../src/services/transition-rules.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/services/transition-rules.js")>();
  return {
    ...original,
    evaluateTransitionRules: (...args: Parameters<typeof original.evaluateTransitionRules>) => {
      const [rules] = args;
      // The prMerged post-check after the merge passes.
      if (rules?.length === 1 && rules[0] === "prMerged") {
        return Promise.resolve({ failed: [], unknown: [], errors: {} });
      }
      return original.evaluateTransitionRules(...args);
    },
  };
});

// Observes what each release found: 0 means the write that recorded the merge
// had already cleared the reservation, 1 means the release itself had to.
const releases = vi.hoisted(() => ({ found: [] as number[] }));
vi.mock("../../src/services/task-merge-reservation.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/services/task-merge-reservation.js")>();
  return {
    ...original,
    releaseMergeReservation: async (...args: Parameters<typeof original.releaseMergeReservation>) => {
      const found = await original.releaseMergeReservation(...args);
      releases.found.push(found);
      return found;
    },
  };
});

import { taskRouter } from "../../src/routes/tasks.js";
import { githubRouter } from "../../src/routes/github.js";
import { projectInviteAdminRouter } from "../../src/routes/invites.js";
import { logAuditEvent } from "../../src/services/audit.js";
import { reserveTaskForMerge } from "../../src/services/task-status-cas.js";
import { MERGE_RESERVATION_TTL_MS, releaseMergeReservation } from "../../src/services/task-merge-reservation.js";

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
let teamId: string;
let projectId: string;

let author: Actor; // holds the work claim
let reviewer: Actor; // holds the review lock, merges
let reviewer2: Actor;
let admin: Actor;
let authorId: string;
let reviewerId: string;
let reviewer2Id: string;
let adminId: string;

const JSON_HEADERS = { "content-type": "application/json" };
const PR_FIELDS = { branchName: "feat/x", prUrl: "https://github.com/acme/thing/pull/1", prNumber: 1 };

function makeApp(actor: Actor, ...mounts: Array<Hono<{ Variables: AppVariables }>>) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("groundingRemoteTargetGuard", null);
    await next();
  });
  for (const router of mounts.length ? mounts : [taskRouter]) app.route("/", router);
  return app;
}

async function send(actor: Actor, method: string, path: string, body?: Record<string, unknown>): Promise<Response> {
  return makeApp(actor).request(path, {
    method,
    headers: JSON_HEADERS,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const post = (actor: Actor, path: string, body: Record<string, unknown> = {}) => send(actor, "POST", path, body);

async function seedUser() {
  const id = randomUUID();
  await db.user.create({ data: { id, login: `u-${id}` } });
  return id;
}

async function seedTask(overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  await db.task.create({
    data: {
      id,
      projectId,
      title: `Task ${id.slice(0, 8)}`,
      description: "A task for the merge reservation tests.",
      status: "open",
      createdByUserId: adminId,
      ...overrides,
    },
  });
  return id;
}

/** A task in review: the author holds the work claim, the reviewer the review lock. */
function seedReviewTask(overrides: Record<string, unknown> = {}) {
  return seedTask({
    status: "review",
    claimedByUserId: authorId,
    claimedAt: new Date(),
    reviewClaimedByUserId: reviewerId,
    reviewClaimedAt: new Date(),
    ...PR_FIELDS,
    ...overrides,
  });
}

async function distinctReviewerProject() {
  await db.project.update({
    where: { id: projectId },
    data: { githubRepo: "acme/thing", governanceMode: "REQUIRES_DISTINCT_REVIEWER", requireDistinctReviewer: true, soloMode: false },
  });
}
async function autonomousProject() {
  await db.project.update({
    where: { id: projectId },
    data: { githubRepo: "acme/thing", governanceMode: "AUTONOMOUS", requireDistinctReviewer: false, soloMode: true },
  });
}

async function seedAgent(scopes: string[]) {
  const tokenId = randomUUID();
  await db.agentToken.create({
    data: { id: tokenId, teamId, createdById: reviewerId, name: `agent-${tokenId.slice(0, 8)}`, tokenHash: tokenId, scopes },
  });
  return { type: "agent", tokenId, teamId, userId: reviewerId, scopes } as Actor;
}

const MERGE_SCOPES = ["tasks:transition", "tasks:claim", "tasks:update", "github:pr_merge"];

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
  releases.found = [];
  github.githubCalls = 0;
  github.insideMerge = null;
  github.answer = { ok: true, sha: "deadbeef", alreadyMerged: false };
  github.throws = null;
  github.performPrMerge.mockImplementation(async (_task, _method, _actor, _guard, beforeGithubMerge?: () => Promise<unknown>) => {
    const refusal = beforeGithubMerge ? await beforeGithubMerge() : null;
    if (refusal) return refusal;
    github.githubCalls += 1;
    if (github.insideMerge) {
      const run = github.insideMerge;
      github.insideMerge = null;
      await run();
    }
    if (github.throws) throw github.throws;
    return github.answer;
  });
  accessMocks.hasProjectAccess.mockResolvedValue(true);
  accessMocks.hasProjectRole.mockResolvedValue(true);
  accessMocks.isProjectAdmin.mockResolvedValue(true);
  accessMocks.requireProjectWrite.mockResolvedValue(true);

  authorId = await seedUser();
  reviewerId = await seedUser();
  reviewer2Id = await seedUser();
  adminId = await seedUser();
  teamId = randomUUID();
  await db.team.create({ data: { id: teamId, name: "Merge reservation", slug: randomUUID() } });
  for (const [userId, role] of [[authorId, "HUMAN_MEMBER"], [reviewerId, "HUMAN_MEMBER"], [reviewer2Id, "HUMAN_MEMBER"], [adminId, "ADMIN"]] as const) {
    await db.teamMember.create({ data: { teamId, userId, role } });
  }
  projectId = randomUUID();
  await db.project.create({ data: { id: projectId, teamId, name: "Merge reservation", slug: randomUUID() } });
  author = { type: "human", userId: authorId, teamId };
  reviewer = { type: "human", userId: reviewerId, teamId };
  reviewer2 = { type: "human", userId: reviewer2Id, teamId };
  admin = { type: "human", userId: adminId, teamId };
  await distinctReviewerProject();
});

// ---------------------------------------------------------------------------
// The reservation itself: take, refuse, expire, release.
// ---------------------------------------------------------------------------

describe("reserveTaskForMerge / releaseMergeReservation", () => {
  async function snapshotOf(taskId: string) {
    return db.task.findUniqueOrThrow({ where: { id: taskId } });
  }

  it("takes the reservation on a matching row: holder and lease start are stored, the status version and updatedAt are untouched", async () => {
    const taskId = await seedReviewTask();
    const before = await snapshotOf(taskId);

    const outcome = await reserveTaskForMerge(db, before, reviewer);

    expect(outcome.ok).toBe(true);
    const row = await snapshotOf(taskId);
    expect(row.mergeReservedByUserId).toBe(reviewerId);
    expect(row.mergeReservedByAgentId).toBeNull();
    expect(row.mergeReservedAt).toBeInstanceOf(Date);
    expect(row.statusVersion).toBe(before.statusVersion);
    // Reservation bookkeeping is not a change of the task.
    expect(row.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it("stores an agent holder in the agent column", async () => {
    const agent = await seedAgent(MERGE_SCOPES);
    const taskId = await seedReviewTask();

    expect((await reserveTaskForMerge(db, await snapshotOf(taskId), agent)).ok).toBe(true);

    const row = await snapshotOf(taskId);
    expect(row.mergeReservedByAgentId).toBe((agent as { tokenId: string }).tokenId);
    expect(row.mergeReservedByUserId).toBeNull();
  });

  it.each([
    ["the status", (id: string) => db.task.update({ where: { id }, data: { status: "in_progress" } })],
    ["the status version", (id: string) => db.task.update({ where: { id }, data: { statusVersion: { increment: 1 } } })],
    ["the work claim user", (id: string) => db.task.update({ where: { id }, data: { claimedByUserId: reviewer2Id } })],
    ["the work claim agent", async (id: string) => {
      const agent = await seedAgent(MERGE_SCOPES);
      await db.task.update({ where: { id }, data: { claimedByUserId: null, claimedByAgentId: (agent as { tokenId: string }).tokenId } });
    }],
    ["the review lock user", (id: string) => db.task.update({ where: { id }, data: { reviewClaimedByUserId: reviewer2Id } })],
    ["the review lock agent", async (id: string) => {
      const agent = await seedAgent(MERGE_SCOPES);
      await db.task.update({ where: { id }, data: { reviewClaimedByUserId: null, reviewClaimedByAgentId: (agent as { tokenId: string }).tokenId } });
    }],
    ["the review lock (released)", (id: string) => db.task.update({ where: { id }, data: { reviewClaimedByUserId: null, reviewClaimedAt: null } })],
  ])("is refused as changed when %s moved since the gates read the row, and writes nothing", async (_label, move) => {
    const taskId = await seedReviewTask();
    const read = await snapshotOf(taskId);
    await move(taskId);

    const outcome = await reserveTaskForMerge(db, read, reviewer);

    expect(outcome).toEqual({ ok: false, reason: "changed" });
    const row = await snapshotOf(taskId);
    expect(row.mergeReservedAt).toBeNull();
    expect(row.mergeReservedByUserId).toBeNull();
    expect(row.mergeReservedByAgentId).toBeNull();
  });

  it("a second merge cannot reserve a task whose reservation is live: merge_in_progress, and the first reservation stays", async () => {
    const taskId = await seedReviewTask();
    const read = await snapshotOf(taskId);
    expect((await reserveTaskForMerge(db, read, reviewer)).ok).toBe(true);
    const first = await snapshotOf(taskId);

    const second = await reserveTaskForMerge(db, read, reviewer2);

    expect(second.ok).toBe(false);
    if (second.ok || second.reason !== "merge_in_progress") throw new Error(`expected merge_in_progress, got ${JSON.stringify(second)}`);
    expect(second.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(second.retryAfterSeconds).toBeLessThanOrEqual(MERGE_RESERVATION_TTL_MS / 1000);
    const row = await snapshotOf(taskId);
    expect(row.mergeReservedByUserId).toBe(reviewerId);
    expect(row.mergeReservedAt?.getTime()).toBe(first.mergeReservedAt?.getTime());
  });

  it("a lapsed reservation counts as absent: the next merge takes it over", async () => {
    const taskId = await seedReviewTask();
    const read = await snapshotOf(taskId);
    const lapsed = new Date(Date.now() - MERGE_RESERVATION_TTL_MS - 1000);
    expect((await reserveTaskForMerge(db, read, reviewer, lapsed)).ok).toBe(true);

    const outcome = await reserveTaskForMerge(db, read, reviewer2);

    expect(outcome.ok).toBe(true);
    const row = await snapshotOf(taskId);
    expect(row.mergeReservedByUserId).toBe(reviewer2Id);
    expect(row.mergeReservedAt!.getTime()).toBeGreaterThan(lapsed.getTime());
  });

  it("releases only the reservation it holds: a stale token leaves another merge's reservation alone", async () => {
    const taskId = await seedReviewTask();
    const read = await snapshotOf(taskId);
    const lapsed = new Date(Date.now() - MERGE_RESERVATION_TTL_MS - 1000);
    const stale = await reserveTaskForMerge(db, read, reviewer, lapsed);
    const current = await reserveTaskForMerge(db, read, reviewer2);
    if (!stale.ok || !current.ok) throw new Error("setup: both reservations should have been taken");

    expect(await releaseMergeReservation(db, taskId, stale.reservation)).toBe(0);
    expect((await snapshotOf(taskId)).mergeReservedByUserId).toBe(reviewer2Id);

    expect(await releaseMergeReservation(db, taskId, current.reservation)).toBe(1);
    const row = await snapshotOf(taskId);
    expect(row.mergeReservedAt).toBeNull();
    expect(row.mergeReservedByUserId).toBeNull();
    expect(row.mergeReservedByAgentId).toBeNull();
  });

  // Agent holders: both USER columns stay NULL throughout, so only the agent
  // column comparison of the take can see the change.
  describe("agent-held claims bind the take on their own columns", () => {
    async function seedAgentHeldReviewTask() {
      const workAgent = await seedAgent(MERGE_SCOPES);
      const reviewAgent = await seedAgent(MERGE_SCOPES);
      const taskId = await seedReviewTask({
        claimedByUserId: null,
        claimedByAgentId: (workAgent as { tokenId: string }).tokenId,
        reviewClaimedByUserId: null,
        reviewClaimedByAgentId: (reviewAgent as { tokenId: string }).tokenId,
      });
      return { taskId, workAgent, reviewAgent };
    }

    it.each([
      ["only the work claim agent", "claimedByAgentId"],
      ["only the review lock agent", "reviewClaimedByAgentId"],
    ] as const)("is refused as changed when %s moved to another agent since the gates read the row", async (_label, column) => {
      const { taskId } = await seedAgentHeldReviewTask();
      const read = await snapshotOf(taskId);
      const other = await seedAgent(MERGE_SCOPES);
      await db.task.update({ where: { id: taskId }, data: { [column]: (other as { tokenId: string }).tokenId } });
      const moved = await snapshotOf(taskId);
      // Nothing but the one agent column differs from what the gates read.
      expect(moved.claimedByUserId).toBeNull();
      expect(moved.reviewClaimedByUserId).toBeNull();
      expect(moved.status).toBe(read.status);
      expect(moved.statusVersion).toBe(read.statusVersion);

      const outcome = await reserveTaskForMerge(db, read, reviewer);

      expect(outcome).toEqual({ ok: false, reason: "changed" });
      expect(await reservationOf(taskId)).toMatchObject(NO_RESERVATION);
    });

    it("takes the reservation while both agent claims are as the gates read them", async () => {
      const { taskId } = await seedAgentHeldReviewTask();

      const outcome = await reserveTaskForMerge(db, await snapshotOf(taskId), reviewer);

      expect(outcome.ok).toBe(true);
    });
  });

  it("the lease boundary is in SQL too: a reservation exactly TTL old is taken over, one a millisecond younger holds", async () => {
    const taskId = await seedReviewTask();
    const read = await snapshotOf(taskId);
    const start = new Date("2026-10-06T12:00:00.000Z");
    expect((await reserveTaskForMerge(db, read, reviewer, start)).ok).toBe(true);

    const justBefore = await reserveTaskForMerge(db, read, reviewer2, new Date(start.getTime() + MERGE_RESERVATION_TTL_MS - 1));
    expect(justBefore).toMatchObject({ ok: false, reason: "merge_in_progress" });
    expect((await reservationOf(taskId)).mergeReservedByUserId).toBe(reviewerId);

    const atTtl = new Date(start.getTime() + MERGE_RESERVATION_TTL_MS);
    const taken = await reserveTaskForMerge(db, read, reviewer2, atTtl);
    expect(taken.ok).toBe(true);
    const row = await reservationOf(taskId);
    expect(row.mergeReservedByUserId).toBe(reviewer2Id);
    expect(row.mergeReservedAt?.getTime()).toBe(atTtl.getTime());
  });

  it("the same actor's old release cannot clear the new reservation it took over a lapsed one with: the lease start is part of the token", async () => {
    const taskId = await seedReviewTask();
    const read = await snapshotOf(taskId);
    const lapsed = new Date(Date.now() - MERGE_RESERVATION_TTL_MS - 1000);
    const old = await reserveTaskForMerge(db, read, reviewer, lapsed);
    const fresh = await reserveTaskForMerge(db, read, reviewer);
    if (!old.ok || !fresh.ok) throw new Error("setup: both reservations should have been taken");
    // Same holder, different lease start.
    expect(old.reservation.byUserId).toBe(fresh.reservation.byUserId);
    expect(old.reservation.at.getTime()).not.toBe(fresh.reservation.at.getTime());

    expect(await releaseMergeReservation(db, taskId, old.reservation)).toBe(0);

    const row = await reservationOf(taskId);
    expect(row.mergeReservedAt?.getTime()).toBe(fresh.reservation.at.getTime());
    expect(row.mergeReservedByUserId).toBe(reviewerId);
  });

  it.each([
    ["another user", (taskId: string) => db.task.update({ where: { id: taskId }, data: { mergeReservedByUserId: reviewer2Id } })],
    ["another agent", async (taskId: string) => {
      const agent = await seedAgent(MERGE_SCOPES);
      await db.task.update({ where: { id: taskId }, data: { mergeReservedByUserId: null, mergeReservedByAgentId: (agent as { tokenId: string }).tokenId } });
    }],
  ])("a release does not clear a reservation with the same lease start but held by %s: the holder is part of the token", async (_label, rehold) => {
    const taskId = await seedReviewTask();
    const read = await snapshotOf(taskId);
    const outcome = await reserveTaskForMerge(db, read, reviewer);
    if (!outcome.ok) throw new Error("setup: the reservation should have been taken");
    await rehold(taskId);
    const before = await reservationOf(taskId);

    expect(await releaseMergeReservation(db, taskId, outcome.reservation)).toBe(0);

    expect(await reservationOf(taskId)).toEqual(before);
  });

  it("a release does not clear a reservation held by another AGENT with the same lease start and no user holder", async () => {
    const agentA = await seedAgent(MERGE_SCOPES);
    const agentB = await seedAgent(MERGE_SCOPES);
    const taskId = await seedReviewTask();
    const outcome = await reserveTaskForMerge(db, await snapshotOf(taskId), agentA);
    if (!outcome.ok) throw new Error("setup: the reservation should have been taken");
    expect(outcome.reservation.byUserId).toBeNull();
    await db.task.update({ where: { id: taskId }, data: { mergeReservedByAgentId: (agentB as { tokenId: string }).tokenId } });

    expect(await releaseMergeReservation(db, taskId, outcome.reservation)).toBe(0);

    expect((await reservationOf(taskId)).mergeReservedByAgentId).toBe((agentB as { tokenId: string }).tokenId);
  });

  it("releasing leaves updatedAt alone", async () => {
    const taskId = await seedReviewTask();
    const read = await snapshotOf(taskId);
    const outcome = await reserveTaskForMerge(db, read, reviewer);
    if (!outcome.ok) throw new Error("setup: reservation should have been taken");

    await releaseMergeReservation(db, taskId, outcome.reservation);

    expect((await snapshotOf(taskId)).updatedAt.getTime()).toBe(read.updatedAt.getTime());
  });
});

// ---------------------------------------------------------------------------
// The merge paths: reserve before the GitHub call; released after a refused merge or a lost post-merge write, kept until the lease lapses after an unknown GitHub outcome or a thrown handler.
// ---------------------------------------------------------------------------

type ReservationColumns = { mergeReservedAt: Date | null; mergeReservedByUserId: string | null; mergeReservedByAgentId: string | null };
async function reservationOf(taskId: string): Promise<ReservationColumns> {
  return db.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { mergeReservedAt: true, mergeReservedByUserId: true, mergeReservedByAgentId: true },
  });
}
const NO_RESERVATION = { mergeReservedAt: null, mergeReservedByUserId: null, mergeReservedByAgentId: null };

interface MergePath {
  name: string;
  /** Seeds the project and a task that passes the path's gates. */
  seed: () => Promise<{ taskId: string; holderUserId: string | null; holderAgentId: string | null }>;
  /** Fires the request. */
  run: (taskId: string) => Promise<Response>;
  /** The status code of the success answer. */
  okStatus: number;
}

let mergeAgent: Actor;

const MERGE_PATHS: MergePath[] = [
  {
    name: "POST /tasks/:id/merge",
    seed: async () => {
      await distinctReviewerProject();
      return { taskId: await seedReviewTask(), holderUserId: reviewerId, holderAgentId: null };
    },
    run: (taskId) => post(reviewer, `/tasks/${taskId}/merge`),
    okStatus: 200,
  },
  {
    name: "POST /tasks/:id/finish (review-finish, autoMerge)",
    seed: async () => {
      await distinctReviewerProject();
      return { taskId: await seedReviewTask(), holderUserId: reviewerId, holderAgentId: null };
    },
    run: (taskId) => post(reviewer, `/tasks/${taskId}/finish`, { outcome: "approve", autoMerge: true }),
    okStatus: 200,
  },
  {
    name: "POST /tasks/:id/finish (self-approve, autoMerge)",
    seed: async () => {
      // A project without the distinct-reviewer rule: the work claim holder approves its own task.
      await db.project.update({ where: { id: projectId }, data: { githubRepo: "acme/thing", governanceMode: "AWAITS_CONFIRMATION", requireDistinctReviewer: false, soloMode: false } });
      return {
        taskId: await seedReviewTask({ reviewClaimedByUserId: null, reviewClaimedAt: null }),
        holderUserId: authorId,
        holderAgentId: null,
      };
    },
    run: (taskId) => post(author, `/tasks/${taskId}/finish`, { outcome: "approve", autoMerge: true }),
    okStatus: 200,
  },
  {
    name: "POST /tasks/:id/finish (work-finish, autoMerge)",
    seed: async () => {
      await autonomousProject();
      return {
        taskId: await seedTask({ status: "in_progress", claimedByUserId: authorId, claimedAt: new Date(), ...PR_FIELDS }),
        holderUserId: authorId,
        holderAgentId: null,
      };
    },
    run: (taskId) => post(author, `/tasks/${taskId}/finish`, { autoMerge: true, result: "Done." }),
    okStatus: 200,
  },
  {
    name: "POST /github/pull-requests/:n/merge",
    seed: async () => {
      await distinctReviewerProject();
      const agent = await seedAgent(MERGE_SCOPES);
      mergeAgent = agent;
      return {
        taskId: await seedReviewTask(),
        holderUserId: null,
        holderAgentId: (agent as { tokenId: string }).tokenId,
      };
    },
    run: async (taskId) =>
      makeApp(mergeAgent, githubRouter).request("/pull-requests/1/merge", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ taskId, owner: "acme", repo: "thing" }),
      }),
    okStatus: 200,
  },
];
describe.each(MERGE_PATHS)("$name reserves the task for the merge", (path) => {
  it("holds the reservation (merging actor, fresh lease) while GitHub is called and clears it in the write that records the merge", async () => {
    const { taskId, holderUserId, holderAgentId } = await path.seed();
    let during: ReservationColumns | null = null;
    github.insideMerge = async () => {
      during = await reservationOf(taskId);
    };

    const res = await path.run(taskId);

    expect(res.status).toBe(path.okStatus);
    expect(github.githubCalls).toBe(1);
    expect(during).not.toBeNull();
    expect(during!.mergeReservedByUserId).toBe(holderUserId);
    expect(during!.mergeReservedByAgentId).toBe(holderAgentId);
    expect(Math.abs(Date.now() - during!.mergeReservedAt!.getTime())).toBeLessThan(MERGE_RESERVATION_TTL_MS);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("done");
    expect(row).toMatchObject(NO_RESERVATION);
    // The write that recorded the merge cleared the reservation itself: the
    // release at the end of the request found nothing left to give back.
    expect(releases.found).toEqual([0]);
  });

  it("gives the reservation back when GitHub refuses the merge", async () => {
    const { taskId } = await path.seed();
    github.answer = { ok: false, error: "github_error", message: "GitHub API error: not mergeable", status: 405 };
    let during: ReservationColumns | null = null;
    github.insideMerge = async () => {
      during = await reservationOf(taskId);
    };

    const res = await path.run(taskId);

    expect(res.status).toBe(405);
    expect(during!.mergeReservedAt).not.toBeNull();
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).not.toBe("done");
    expect(row).toMatchObject(NO_RESERVATION);
    expect(releases.found).toEqual([1]);
  });

  it("keeps the reservation when the merge handler throws after taking it: GitHub may still be merging, so it lapses with its lease", async () => {
    const { taskId, holderUserId, holderAgentId } = await path.seed();
    github.throws = new Error("socket hang up");

    const res = await path.run(taskId);

    expect(res.status).toBe(500);
    // The old expectation (released at request end) is wrong now: a handler
    // that died after the reservation may have left a merge in flight, and
    // releasing would let claim writers in under it.
    const held = await reservationOf(taskId);
    expect(held.mergeReservedAt).not.toBeNull();
    expect(held.mergeReservedByUserId).toBe(holderUserId);
    expect(held.mergeReservedByAgentId).toBe(holderAgentId);
    expect(releases.found).toEqual([]);
  });

  it("keeps the reservation when the GitHub call ends with an unknown outcome (fetch threw, reset or timed out), and a second merge is refused with Retry-After", async () => {
    const { taskId, holderUserId, holderAgentId } = await path.seed();
    github.answer = { ok: false, error: "github_error", message: "GitHub API unreachable: The operation was aborted due to timeout", status: 502, outcomeUnknown: true };

    const res = await path.run(taskId);

    expect(res.status).toBe(502);
    const held = await reservationOf(taskId);
    expect(held.mergeReservedAt).not.toBeNull();
    expect(held.mergeReservedByUserId).toBe(holderUserId);
    expect(held.mergeReservedByAgentId).toBe(holderAgentId);
    expect(releases.found).toEqual([]);
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).not.toBe("done");

    const second = await path.run(taskId);

    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string; retryAfterSeconds?: number };
    expect(body.error).toBe("merge_in_progress");
    expect(body.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(Number(second.headers.get("Retry-After"))).toBe(body.retryAfterSeconds);
    expect(github.githubCalls).toBe(1);
  });

  it("answers a documented 409 grounding_github_fence_conflict, not 500, when the reservation write hits an active repository fence", async () => {
    const { taskId } = await path.seed();
    const intentId = randomUUID();
    await db.groundingGithubFenceIntent.create({ data: { id: intentId, repo: "acme/thing", kind: "MERGE", taskId: null, state: "ACTIVE" } });
    await db.groundingGithubRepositoryFence.upsert({ where: { repo: "acme/thing" }, create: { repo: "acme/thing", ownerId: intentId }, update: { ownerId: intentId } });
    let res: Response;
    try {
      res = await path.run(taskId);
    } finally {
      await db.groundingGithubRepositoryFence.update({ where: { repo: "acme/thing" }, data: { ownerId: null } });
      await db.groundingGithubFenceIntent.update({ where: { id: intentId }, data: { state: "RELEASED" } });
    }

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("grounding_github_fence_conflict");
    expect(github.githubCalls).toBe(0);
    expect(await reservationOf(taskId)).toMatchObject(NO_RESERVATION);
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).not.toBe("done");
  });

  it("a reservation kept after an unknown outcome stops blocking once its lease lapses: the next merge proceeds", async () => {
    const { taskId } = await path.seed();
    github.answer = { ok: false, error: "github_error", message: "GitHub API unreachable: timeout", status: 502, outcomeUnknown: true };
    expect((await path.run(taskId)).status).toBe(502);
    const kept = await reservationOf(taskId);
    expect(kept.mergeReservedAt).not.toBeNull();
    // Lease lapses.
    await db.task.update({ where: { id: taskId }, data: { mergeReservedAt: new Date(kept.mergeReservedAt!.getTime() - MERGE_RESERVATION_TTL_MS - 1000) } });
    github.answer = { ok: true, sha: "deadbeef", alreadyMerged: false };
    const second = await path.run(taskId);
    expect(second.status).toBe(path.okStatus);
    expect(github.githubCalls).toBe(2);
    expect(await reservationOf(taskId)).toMatchObject(NO_RESERVATION);
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("done");
  });

  it("gives the reservation back when the post-merge write loses (the task moved after the lease): merged_but_status_changed", async () => {
    const { taskId } = await path.seed();
    github.insideMerge = async () => {
      // A writer that is not subject to the reservation (the lease lapsed, or a
      // webhook) moves the task while GitHub merges.
      await db.task.update({ where: { id: taskId }, data: { status: "in_progress", statusVersion: { increment: 1 } } });
    };

    const res = await path.run(taskId);

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("merged_but_status_changed");
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("in_progress");
    expect(row).toMatchObject(NO_RESERVATION);
    expect(releases.found).toEqual([1]);
  });

  it("a claim that moved under the reservation (a writer the lease no longer covered) is reported as a moved claim, not as another merge", async () => {
    const { taskId } = await path.seed();
    github.insideMerge = async () => {
      await db.task.update({ where: { id: taskId }, data: { claimedByUserId: reviewer2Id, claimedByAgentId: null } });
    };

    const res = await path.run(taskId);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("merged_but_status_changed");
    expect(body.message).toMatch(/claim on the task moved/);
    expect(body.message).not.toMatch(/another merge/);
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.merged_status_conflict", payload: expect.objectContaining({ reason: "claim_moved" }) }),
    );
    expect(await reservationOf(taskId)).toMatchObject(NO_RESERVATION);
  });

  it("refuses a second merge of the task while the first holds the reservation: 409 merge_in_progress, GitHub is called once", async () => {
    const { taskId } = await path.seed();
    let secondStatus = 0;
    let secondBody: { error?: string } = {};
    github.insideMerge = async () => {
      const second = await path.run(taskId);
      secondStatus = second.status;
      secondBody = (await second.json()) as { error?: string };
    };

    const res = await path.run(taskId);

    expect(res.status).toBe(path.okStatus);
    expect(secondStatus).toBe(409);
    expect(secondBody.error).toBe("merge_in_progress");
    expect(github.githubCalls).toBe(1);
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("done");
  });

  it("a review lock released between the gate and the merge refuses the merge instead of letting it land: 409, GitHub is never called", async () => {
    const { taskId } = await path.seed();
    // The window the reservation closes: after the handler read the task and
    // evaluated the gates, before the merge call.
    shared.afterTaskRead = async () => {
      await db.task.update({
        where: { id: taskId },
        data: { reviewClaimedByUserId: null, reviewClaimedByAgentId: null, reviewClaimedAt: null, claimedByUserId: reviewer2Id },
      });
    };

    const res = await path.run(taskId);

    expect(res.status).toBe(409);
    expect(github.githubCalls).toBe(0);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).not.toBe("done");
    expect(row).toMatchObject(NO_RESERVATION);
  });
});

// ---------------------------------------------------------------------------
// Every claim and status writer refuses while a merge holds the task.
// ---------------------------------------------------------------------------

/** Runs `writer` while GitHub is being called for a /merge of `taskId`. */
async function mergeWhile(taskId: string, writer: () => Promise<Response>, merger: Actor = reviewer) {
  const seen: { res?: Response; body?: Record<string, unknown>; rowDuring?: Awaited<ReturnType<typeof db.task.findUniqueOrThrow>> } = {};
  github.insideMerge = async () => {
    seen.res = await writer();
    seen.body = (await seen.res.clone().json().catch(() => ({}))) as Record<string, unknown>;
    seen.rowDuring = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  };
  const mergeRes = await post(merger, `/tasks/${taskId}/merge`);
  return { mergeRes, ...seen };
}

function expectRefused(
  result: Awaited<ReturnType<typeof mergeWhile>>,
  before: { status: string; statusVersion: number; claimedByUserId: string | null; reviewClaimedByUserId: string | null },
  { retryAfter = true }: { retryAfter?: boolean } = {},
) {
  expect(result.res?.status).toBe(409);
  expect(result.body?.error).toBe("merge_in_progress");
  // The writers that answer from their own conditional write say when to retry.
  if (retryAfter) expect(result.res?.headers.get("retry-after")).toMatch(/^\d+$/);
  // The refused writer changed nothing the merge gates decided from.
  expect(result.rowDuring).toMatchObject({
    status: before.status,
    statusVersion: before.statusVersion,
    claimedByUserId: before.claimedByUserId,
    reviewClaimedByUserId: before.reviewClaimedByUserId,
  });
  // And the merge went on to record itself.
  expect(result.mergeRes.status).toBe(200);
}

describe("claim and status writers refuse with 409 merge_in_progress while a merge holds the task", () => {
  async function reviewState(taskId: string) {
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    return { status: row.status, statusVersion: row.statusVersion, claimedByUserId: row.claimedByUserId, reviewClaimedByUserId: row.reviewClaimedByUserId };
  }

  const RACES: Array<{ name: string; writer: (taskId: string) => Promise<Response> }> = [
    { name: "POST /tasks/:id/review/release (the reviewer lets go of the lock)", writer: (id) => post(reviewer, `/tasks/${id}/review/release`) },
    { name: "POST /tasks/:id/abandon (a reviewer abandons the review claim)", writer: (id) => post(reviewer, `/tasks/${id}/abandon`) },
    {
      name: "POST /tasks/:id/admin-release (an admin force-releases both claims)",
      writer: (id) => post(admin, `/tasks/${id}/admin-release`, { releaseWorkClaim: true, releaseReviewClaim: true }),
    },
    {
      name: "POST /tasks/:id/admin-release (an admin force-releases only the work claim)",
      writer: (id) => post(admin, `/tasks/${id}/admin-release`, { releaseWorkClaim: true }),
    },
    {
      name: "POST /tasks/:id/admin-release (an admin force-releases only the review lock)",
      writer: (id) => post(admin, `/tasks/${id}/admin-release`, { releaseReviewClaim: true }),
    },
    { name: "POST /tasks/:id/release (the author releases the work claim)", writer: (id) => post(author, `/tasks/${id}/release`) },
    { name: "POST /tasks/:id/review (the reviewer requests changes)", writer: (id) => post(reviewer, `/tasks/${id}/review`, { action: "request_changes" }) },
    { name: "POST /tasks/:id/transition (an admin moves the task back)", writer: (id) => post(admin, `/tasks/${id}/transition`, { status: "in_progress" }) },
    { name: "PATCH /tasks/:id (an admin writes the status)", writer: (id) => send(admin, "PATCH", `/tasks/${id}`, { status: "in_progress" }) },
    {
      name: "POST /tasks/:id/finish (review-finish without autoMerge)",
      writer: (id) => post(reviewer, `/tasks/${id}/finish`, { outcome: "request_changes", result: "Needs work." }),
    },
  ];

  it.each(RACES)("$name", async ({ writer }) => {
    const taskId = await seedReviewTask();
    const before = await reviewState(taskId);

    const result = await mergeWhile(taskId, () => writer(taskId));

    expectRefused(result, before);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("done");
    expect(row).toMatchObject(NO_RESERVATION);
  });

  it("DELETE /projects/:id/members/:userId (removing the claimant releases no claim and keeps the member)", async () => {
    const taskId = await seedReviewTask();
    await db.projectMember.create({ data: { projectId, userId: authorId, role: "PROJECT_CONTRIBUTOR", invitedById: adminId } });
    const before = await reviewState(taskId);

    const result = await mergeWhile(taskId, async () =>
      makeApp(admin, projectInviteAdminRouter).request(`/projects/${projectId}/members/${authorId}`, { method: "DELETE" }),
    );

    expectRefused(result, before, { retryAfter: false });
    // The removal was refused as a whole: the member is still there.
    expect(await db.projectMember.count({ where: { projectId, userId: authorId } })).toBe(1);
  });

  describe("work claim in progress (autoMerge from the work claim)", () => {
    async function seedInProgress() {
      await autonomousProject();
      return seedTask({ status: "in_progress", claimedByUserId: authorId, claimedAt: new Date(), ...PR_FIELDS });
    }
    async function mergeModeAWhile(taskId: string, writer: () => Promise<Response>) {
      const seen: { res?: Response; body?: Record<string, unknown>; rowDuring?: Awaited<ReturnType<typeof db.task.findUniqueOrThrow>> } = {};
      github.insideMerge = async () => {
        seen.res = await writer();
        seen.body = (await seen.res.clone().json().catch(() => ({}))) as Record<string, unknown>;
        seen.rowDuring = await db.task.findUniqueOrThrow({ where: { id: taskId } });
      };
      const mergeRes = await post(author, `/tasks/${taskId}/finish`, { autoMerge: true, result: "Done." });
      return { mergeRes, ...seen };
    }

    it("POST /tasks/:id/abandon (the work claim holder abandons, which would reset the status)", async () => {
      const taskId = await seedInProgress();
      const before = await reviewState(taskId);

      const result = await mergeModeAWhile(taskId, () => post(author, `/tasks/${taskId}/abandon`));

      expectRefused(result, before);
    });

    it("POST /tasks/:id/release (the work claim holder releases)", async () => {
      const taskId = await seedInProgress();
      const before = await reviewState(taskId);

      const result = await mergeModeAWhile(taskId, () => post(author, `/tasks/${taskId}/release`));

      expectRefused(result, before);
    });

    it("POST /tasks/:id/finish without autoMerge (a second work-finish would move the task to review)", async () => {
      const taskId = await seedInProgress();
      const before = await reviewState(taskId);

      const result = await mergeModeAWhile(taskId, () => post(author, `/tasks/${taskId}/finish`, { result: "Done twice." }));

      expectRefused(result, before);
    });
  });

  describe("no review lock yet (a project that lets the work claim holder merge)", () => {
    it.each([
      ["POST /tasks/:id/review/claim (a second reviewer takes the lock)", (id: string) => post(reviewer2, `/tasks/${id}/review/claim`)],
      ["POST /tasks/:id/start (a reviewer starts the review)", (id: string) => post(reviewer2, `/tasks/${id}/start`)],
    ])("%s", async (_label, writer) => {
      await autonomousProject();
      const taskId = await seedReviewTask({ reviewClaimedByUserId: null, reviewClaimedAt: null });
      const before = await reviewState(taskId);

      const result = await mergeWhile(taskId, () => writer(taskId), author);

      expectRefused(result, before);
      // The lock the writer wanted never existed.
      expect(result.rowDuring?.reviewClaimedByUserId).toBeNull();
    });
  });

  it("a live reservation leaves the writers that touch neither claims nor status alone: a title edit lands during the merge", async () => {
    const taskId = await seedReviewTask();

    const result = await mergeWhile(taskId, () => send(admin, "PATCH", `/tasks/${taskId}`, { title: "Renamed while merging" }));

    expect(result.res?.status).toBe(200);
    expect(result.mergeRes.status).toBe(200);
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).title).toBe("Renamed while merging");
  });

  it("a lapsed reservation does not lock the task: the writer succeeds (lazy expiry)", async () => {
    const taskId = await seedReviewTask();
    const read = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    // A handler that died between the reserve and the release long ago.
    const lapsed = new Date(Date.now() - MERGE_RESERVATION_TTL_MS - 1000);
    expect((await reserveTaskForMerge(db, read, reviewer, lapsed)).ok).toBe(true);

    const res = await post(reviewer, `/tasks/${taskId}/review/release`);

    expect(res.status).toBe(200);
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).reviewClaimedByUserId).toBeNull();
  });

  it("a live reservation refuses the writer however it was taken: the same /review/release is 409 until the lease lapses", async () => {
    const taskId = await seedReviewTask();
    const read = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect((await reserveTaskForMerge(db, read, reviewer2)).ok).toBe(true);

    const refused = await post(reviewer, `/tasks/${taskId}/review/release`);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe("merge_in_progress");
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).reviewClaimedByUserId).toBe(reviewerId);

    // The lease lapses (time moves on): the same request now lands.
    await db.task.update({ where: { id: taskId }, data: { mergeReservedAt: new Date(Date.now() - MERGE_RESERVATION_TTL_MS - 1000) } });
    const landed = await post(reviewer, `/tasks/${taskId}/review/release`);
    expect(landed.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Writers whose statuses a merge never reserves still carry the predicate: a
// reservation seeded on a task in their own precondition state refuses them.
// ---------------------------------------------------------------------------

describe("writers of open, backlog and abandoned tasks refuse while a reservation is live", () => {
  async function reserveFor(taskId: string) {
    const read = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    const outcome = await reserveTaskForMerge(db, read, reviewer2);
    if (!outcome.ok) throw new Error("setup: the reservation should have been taken");
  }
  async function expectMergeInProgress(res: Response) {
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("merge_in_progress");
  }

  it("POST /tasks/:id/start (work claim)", async () => {
    const taskId = await seedTask({ status: "open" });
    await reserveFor(taskId);

    await expectMergeInProgress(await post(author, `/tasks/${taskId}/start`));

    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("open");
    expect(row.claimedByUserId).toBeNull();
  });

  it("POST /tasks/:id/claim", async () => {
    const taskId = await seedTask({ status: "open" });
    await reserveFor(taskId);

    await expectMergeInProgress(await post(author, `/tasks/${taskId}/claim`));

    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).claimedByUserId).toBeNull();
  });

  it("POST /tasks/:id/creator-abandon", async () => {
    const agent = await seedAgent(MERGE_SCOPES);
    const taskId = await seedTask({ status: "open", createdByUserId: null, createdByAgentId: (agent as { tokenId: string }).tokenId });
    await reserveFor(taskId);

    await expectMergeInProgress(await post(agent, `/tasks/${taskId}/creator-abandon`));

    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("open");
  });

  it("PATCH /tasks/:id demote (open to backlog)", async () => {
    const taskId = await seedTask({ status: "open" });
    await reserveFor(taskId);

    await expectMergeInProgress(await send(admin, "PATCH", `/tasks/${taskId}`, { status: "backlog" }));

    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("open");
  });

  it("PATCH /tasks/:id unabandon (abandoned to open)", async () => {
    const taskId = await seedTask({ status: "abandoned" });
    await reserveFor(taskId);

    await expectMergeInProgress(await send(admin, "PATCH", `/tasks/${taskId}`, { status: "open" }));

    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("abandoned");
  });

  it("POST /tasks/:id/review/claim", async () => {
    await autonomousProject();
    const taskId = await seedReviewTask({ reviewClaimedByUserId: null, reviewClaimedAt: null });
    await reserveFor(taskId);

    await expectMergeInProgress(await post(reviewer2, `/tasks/${taskId}/review/claim`));

    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).reviewClaimedByUserId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The recovery write of /finish autoMerge (no merge call of its own).
// ---------------------------------------------------------------------------

describe("the autoMerge recovery write of /finish", () => {
  it("refuses while another merge holds the task: merged_but_status_changed that names the merge, and the retry is safe", async () => {
    await autonomousProject();
    const taskId = await seedTask({
      status: "in_progress",
      claimedByUserId: authorId,
      claimedAt: new Date(),
      autoMergeSha: "cafebabe",
      ...PR_FIELDS,
    });
    const read = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect((await reserveTaskForMerge(db, read, reviewer2)).ok).toBe(true);

    const res = await post(author, `/tasks/${taskId}/finish`, { autoMerge: true, result: "Done." });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("merged_but_status_changed");
    expect(body.message).toMatch(/another merge holds the task/);
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.merged_status_conflict", payload: expect.objectContaining({ reason: "merge_in_progress" }) }),
    );
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("in_progress");
  });
});

// ---------------------------------------------------------------------------
// An agent-held review lock that moves to another agent between the gate and
// the merge: only the agent columns change, both user columns stay NULL.
// ---------------------------------------------------------------------------

describe("an agent-held review lock that moves to another agent between the gate and the merge", () => {
  it("refuses POST /tasks/:id/merge: 409, GitHub is never called, no reservation is left", async () => {
    await distinctReviewerProject();
    const mergingAgent = await seedAgent(MERGE_SCOPES);
    const otherAgent = await seedAgent(MERGE_SCOPES);
    const taskId = await seedReviewTask({
      reviewClaimedByUserId: null,
      reviewClaimedByAgentId: (mergingAgent as { tokenId: string }).tokenId,
    });
    shared.afterTaskRead = async () => {
      await db.task.update({ where: { id: taskId }, data: { reviewClaimedByAgentId: (otherAgent as { tokenId: string }).tokenId } });
    };

    const res = await post(mergingAgent, `/tasks/${taskId}/merge`);

    expect(res.status).toBe(409);
    expect(github.githubCalls).toBe(0);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("review");
    expect(row.reviewClaimedByUserId).toBeNull();
    expect(row.reviewClaimedByAgentId).toBe((otherAgent as { tokenId: string }).tokenId);
    expect(row).toMatchObject(NO_RESERVATION);
  });

  it("refuses POST /tasks/:id/merge when only the work claim agent moved", async () => {
    await distinctReviewerProject();
    const workAgent = await seedAgent(MERGE_SCOPES);
    const mergingAgent = await seedAgent(MERGE_SCOPES);
    const otherAgent = await seedAgent(MERGE_SCOPES);
    const taskId = await seedReviewTask({
      claimedByUserId: null,
      claimedByAgentId: (workAgent as { tokenId: string }).tokenId,
      reviewClaimedByUserId: null,
      reviewClaimedByAgentId: (mergingAgent as { tokenId: string }).tokenId,
    });
    shared.afterTaskRead = async () => {
      await db.task.update({ where: { id: taskId }, data: { claimedByAgentId: (otherAgent as { tokenId: string }).tokenId } });
    };

    const res = await post(mergingAgent, `/tasks/${taskId}/merge`);

    expect(res.status).toBe(409);
    expect(github.githubCalls).toBe(0);
    expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({ status: "review", ...NO_RESERVATION });
  });
});

// ---------------------------------------------------------------------------
// DELETE /tasks/:id is a writer too: removing the row under a merge would
// leave the post-merge write with no task to record on.
// ---------------------------------------------------------------------------

describe("DELETE /tasks/:id while a merge holds the task", () => {
  it("is refused with 409 merge_in_progress during the GitHub call and the merge still records itself", async () => {
    const taskId = await seedReviewTask();
    const before = await db.task.findUniqueOrThrow({ where: { id: taskId } });

    const result = await mergeWhile(taskId, () => send(admin, "DELETE", `/tasks/${taskId}`));

    expectRefused(result, { status: before.status, statusVersion: before.statusVersion, claimedByUserId: before.claimedByUserId, reviewClaimedByUserId: before.reviewClaimedByUserId });
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("done");
    expect(row).toMatchObject(NO_RESERVATION);
  });

  it("is refused while a reservation is live and lands once its lease lapsed (lazy expiry)", async () => {
    const taskId = await seedReviewTask();
    const read = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect((await reserveTaskForMerge(db, read, reviewer2)).ok).toBe(true);

    const refused = await send(admin, "DELETE", `/tasks/${taskId}`);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe("merge_in_progress");
    expect(refused.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await db.task.count({ where: { id: taskId } })).toBe(1);

    await db.task.update({ where: { id: taskId }, data: { mergeReservedAt: new Date(Date.now() - MERGE_RESERVATION_TTL_MS - 1000) } });
    const landed = await send(admin, "DELETE", `/tasks/${taskId}`);
    expect(landed.status).toBe(200);
    expect(await db.task.count({ where: { id: taskId } })).toBe(0);
  });

  it("deletes a task without a reservation", async () => {
    const taskId = await seedReviewTask();

    const res = await send(admin, "DELETE", `/tasks/${taskId}`);

    expect(res.status).toBe(200);
    expect(await db.task.count({ where: { id: taskId } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The raw statements bind their timestamps independent of the session time
// zone of the connection. Prisma's own reads and writes treat the
// timestamp(3) columns as UTC; a Date bound raw is converted by the session
// zone, so a connection set to another zone shifts the lease by the offset.
// ---------------------------------------------------------------------------

describe.each(["America/Los_Angeles", "Pacific/Kiritimati", "Europe/Berlin"])("on a connection whose session time zone is %s", (zone) => {
  let tzClient: PrismaClient;
  let appDb: PrismaClient | undefined;

  beforeEach(async () => {
    // One connection, so the SET holds for every statement of the test.
    tzClient = store.connect(1);
    await tzClient.$executeRawUnsafe(`SET TIME ZONE '${zone}'`);
    appDb = shared.db;
    shared.db = tzClient;
  });
  afterEach(async () => {
    shared.db = appDb;
    await tzClient.$disconnect();
  });

  it("reserve, a writer gets 409 merge_in_progress, and the post-merge write lands and clears the reservation", async () => {
    const taskId = await seedReviewTask();
    let during: ReservationColumns | null = null;
    let writerStatus = 0;
    let writerError: string | undefined;
    github.insideMerge = async () => {
      during = await reservationOf(taskId);
      const writer = await post(reviewer, `/tasks/${taskId}/review/release`);
      writerStatus = writer.status;
      writerError = ((await writer.json()) as { error?: string }).error;
    };

    const res = await post(reviewer, `/tasks/${taskId}/merge`);

    expect(res.status).toBe(200);
    // The stored lease start is the real instant, not shifted by the zone offset.
    expect(Math.abs(Date.now() - during!.mergeReservedAt!.getTime())).toBeLessThan(60_000);
    expect(writerStatus).toBe(409);
    expect(writerError).toBe("merge_in_progress");
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("done");
    expect(row).toMatchObject(NO_RESERVATION);
    expect(releases.found).toEqual([0]);
  });

  it("the release of a reservation that was not cleared by the post-merge write finds it by its lease start", async () => {
    const taskId = await seedReviewTask();
    const read = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    const outcome = await reserveTaskForMerge(tzClient, read, reviewer);
    if (!outcome.ok) throw new Error("setup: the reservation should have been taken");
    const stored = await reservationOf(taskId);
    expect(stored.mergeReservedAt?.getTime()).toBe(outcome.reservation.at.getTime());

    expect(await releaseMergeReservation(tzClient, taskId, outcome.reservation)).toBe(1);

    expect(await reservationOf(taskId)).toMatchObject(NO_RESERVATION);
  });

  it("the lease check of the take reads the stored lease start as the same instant: a live reservation is not taken over", async () => {
    const taskId = await seedReviewTask();
    const read = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect((await reserveTaskForMerge(tzClient, read, reviewer)).ok).toBe(true);

    const second = await reserveTaskForMerge(tzClient, read, reviewer2);

    expect(second).toMatchObject({ ok: false, reason: "merge_in_progress" });
  });
});
