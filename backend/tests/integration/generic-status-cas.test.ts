/**
 * DB-backed race tests for the generic status write (agent-tasks task
 * e4e27a39): PATCH /tasks/:id with a status and POST /tasks/:id/transition
 * only write while the row still has the status the handler validated.
 *
 * The same seam covers the rest of the status-write class (agent-tasks task
 * f1c8c7c1): the distinct-reviewer decision and the done write are atomic (a
 * review lock released between them must not let a non-claimant's approval
 * through), a status round trip between the read and the write is rejected,
 * and every other handler that writes a status (/finish in all four forms,
 * /merge, /review) compare-and-swaps the same way.
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
  // Runs once, right after the handler under test first reads the task row.
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

// /merge and the autoMerge forms of /finish merge a PR on GitHub before they
// write; the race tests stand in for that call.
const github = vi.hoisted(() => ({
  performPrMerge: vi.fn(),
  // When set, the prMerged post-check of the /finish recovery path passes.
  prMergedPostCheckPasses: false,
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
      if (github.prMergedPostCheckPasses && rules?.length === 1 && rules[0] === "prMerged") {
        return Promise.resolve({ failed: [], unknown: [], errors: {} });
      }
      return original.evaluateTransitionRules(...args);
    },
  };
});

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
  github.prMergedPostCheckPasses = false;
  github.performPrMerge.mockResolvedValue({ ok: true, sha: "deadbeef", alreadyMerged: false });
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

// ---------------------------------------------------------------------------
// The distinct-reviewer decision and the done write are atomic.
// ---------------------------------------------------------------------------

async function seedUser() {
  const id = randomUUID();
  await db.user.create({ data: { id, login: `u-${id}` } });
  return id;
}

async function requireDistinctReviewer() {
  await db.project.update({ where: { id: projectId }, data: { governanceMode: "REQUIRES_DISTINCT_REVIEWER" } });
}

const PR_FIELDS = { branchName: "feat/x", prUrl: "https://github.com/acme/thing/pull/1", prNumber: 1 };

describe.each([
  ["PATCH /tasks/:id", (taskId: string) => patchStatus(taskId, "done")],
  ["POST /tasks/:id/transition", (taskId: string) => transition(taskId, "done")],
])("distinct-reviewer gate and the done write are atomic: %s", (_label, approve) => {
  async function seedReviewedTask() {
    await requireDistinctReviewer();
    const claimantId = await seedUser();
    const reviewerId = await seedUser();
    const taskId = await seedTask({
      status: "review",
      claimedByUserId: claimantId,
      claimedAt: new Date(),
      reviewClaimedByUserId: reviewerId,
      reviewClaimedAt: new Date(),
      ...PR_FIELDS,
    });
    return { taskId, claimantId, reviewerId };
  }

  it("control: a non-claimant approving while the review lock is held writes done", async () => {
    const { taskId } = await seedReviewedTask();

    const res = await approve(taskId);

    expect(res.status).toBe(200);
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("done");
  });

  it("control: serialized, a review lock that is already released is a 403 and nothing is written", async () => {
    const { taskId } = await seedReviewedTask();
    await db.task.update({ where: { id: taskId }, data: { reviewClaimedByUserId: null, reviewClaimedAt: null } });

    const res = await approve(taskId);

    expect(res.status).toBe(403);
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("review");
  });

  it("a review lock released between the gate and the write answers 409 and does not write done", async () => {
    const { taskId } = await seedReviewedTask();
    shared.afterTaskRead = async () => {
      await db.task.update({ where: { id: taskId }, data: { reviewClaimedByUserId: null, reviewClaimedAt: null } });
    };

    const res = await approve(taskId);

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("conflict");
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("review");
    expect(row.reviewClaimedByUserId).toBeNull();
    expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "task.transitioned" }));
  });

  it("a review lock handed to the claimant between the gate and the write answers 409 and does not write done", async () => {
    const { taskId, claimantId } = await seedReviewedTask();
    shared.afterTaskRead = async () => {
      await db.task.update({ where: { id: taskId }, data: { reviewClaimedByUserId: claimantId } });
    };

    const res = await approve(taskId);

    expect(res.status).toBe(409);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("review");
    expect(row.reviewClaimedByUserId).toBe(claimantId);
  });

  it("the work claim handed to the approver between the gate and the write answers 409 and does not write done", async () => {
    const { taskId } = await seedReviewedTask();
    shared.afterTaskRead = async () => {
      await db.task.update({ where: { id: taskId }, data: { claimedByUserId: userId } });
    };

    const res = await approve(taskId);

    expect(res.status).toBe(409);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("review");
    expect(row.claimedByUserId).toBe(userId);
  });
});

// ---------------------------------------------------------------------------
// A status round trip between the read and the write is not "unchanged".
// ---------------------------------------------------------------------------

describe.each([
  ["PATCH /tasks/:id", (taskId: string) => patchStatus(taskId, "done")],
  ["POST /tasks/:id/transition", (taskId: string) => transition(taskId, "done")],
])("status round trip between the read and the write: %s", (_label, approve) => {
  it("review -> in_progress -> review in the window makes the stale review -> done answer 409", async () => {
    // Work claim held by the actor, no review lock: after the round trip the
    // row has the same status and the same claim columns as when it was read,
    // so only the status version tells the two states apart.
    const taskId = await seedTask({
      status: "review",
      claimedByUserId: userId,
      claimedAt: new Date(),
      ...PR_FIELDS,
    });
    let legs: number[] = [];
    shared.afterTaskRead = async () => {
      legs = [(await transition(taskId, "in_progress")).status, (await transition(taskId, "review")).status];
    };

    const res = await approve(taskId);

    expect(legs).toEqual([200, 200]);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("conflict");
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("review");
    expect(row.claimedByUserId).toBe(userId);
  });

  it("the same round trip while nothing else moves lets the write land", async () => {
    const taskId = await seedTask({
      status: "review",
      claimedByUserId: userId,
      claimedAt: new Date(),
      ...PR_FIELDS,
    });
    expect((await transition(taskId, "in_progress")).status).toBe(200);
    expect((await transition(taskId, "review")).status).toBe(200);

    const res = await approve(taskId);

    expect(res.status).toBe(200);
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("done");
  });
});

describe("every status write bumps the status version", () => {
  it("transition, PATCH and a status-less PATCH: the first two add one each, the last adds none", async () => {
    const taskId = await seedTask({ status: "open" });
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).statusVersion).toBe(0);

    expect((await transition(taskId, "in_progress")).status).toBe(200);
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).statusVersion).toBe(1);

    await db.task.update({ where: { id: taskId }, data: PR_FIELDS });
    expect((await patchStatus(taskId, "review")).status).toBe(200);
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).statusVersion).toBe(2);

    const titleOnly = await makeApp(human).request(`/tasks/${taskId}`, {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ title: "Only the title" }),
    });
    expect(titleOnly.status).toBe(200);
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).statusVersion).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The other handlers that write a status compare-and-swap it too.
// ---------------------------------------------------------------------------

function postJson(path: string, body: Record<string, unknown>, actor: Actor = human) {
  return makeApp(actor).request(path, {
    method: "POST",
    headers: PATCH_HEADERS,
    body: JSON.stringify(body),
  });
}

/** Moves the task to another status from inside the read-to-write window. */
function moveDuringRead(taskId: string, status: string) {
  shared.afterTaskRead = async () => {
    await db.task.update({ where: { id: taskId }, data: { status } });
  };
}

describe("POST /tasks/:id/finish compare-and-swaps its status write", () => {
  it("review-finish approve: a status change in the window answers 409, nothing is written, no review audit", async () => {
    const claimantId = await seedUser();
    const taskId = await seedTask({
      status: "review",
      claimedByUserId: claimantId,
      claimedAt: new Date(),
      reviewClaimedByUserId: userId,
      reviewClaimedAt: new Date(),
      ...PR_FIELDS,
    });
    moveDuringRead(taskId, "in_progress");

    const res = await postJson(`/tasks/${taskId}/finish`, { outcome: "approve" });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("conflict");
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("in_progress");
    expect(row.reviewClaimedByUserId).toBe(userId);
    expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "task.reviewed" }));
  });

  it("review-finish approve: without a race it lands (done, both claims cleared)", async () => {
    const claimantId = await seedUser();
    const taskId = await seedTask({
      status: "review",
      claimedByUserId: claimantId,
      claimedAt: new Date(),
      reviewClaimedByUserId: userId,
      reviewClaimedAt: new Date(),
      ...PR_FIELDS,
    });

    const res = await postJson(`/tasks/${taskId}/finish`, { outcome: "approve" });

    expect(res.status).toBe(200);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("done");
    expect(row.claimedByUserId).toBeNull();
    expect(row.reviewClaimedByUserId).toBeNull();
  });

  it("self-approve (work claim holder on a review task): a status change in the window answers 409 and writes nothing", async () => {
    const taskId = await seedTask({
      status: "review",
      claimedByUserId: userId,
      claimedAt: new Date(),
      ...PR_FIELDS,
    });
    moveDuringRead(taskId, "in_progress");

    const res = await postJson(`/tasks/${taskId}/finish`, { outcome: "approve" });

    expect(res.status).toBe(409);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("in_progress");
    expect(row.claimedByUserId).toBe(userId);
    expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "task.reviewed" }));
  });

  it("autoMerge recovery (merged earlier, task still in_progress): a status change in the window answers 409 and keeps the claim", async () => {
    github.prMergedPostCheckPasses = true;
    const taskId = await seedTask({
      status: "in_progress",
      claimedByUserId: userId,
      claimedAt: new Date(),
      autoMergeSha: "cafebabe",
      ...PR_FIELDS,
    });
    moveDuringRead(taskId, "review");

    const res = await postJson(`/tasks/${taskId}/finish`, { autoMerge: true });

    expect(res.status).toBe(409);
    expect(github.performPrMerge).not.toHaveBeenCalled();
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("review");
    expect(row.claimedByUserId).toBe(userId);
    expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "task.transitioned" }));
  });

  it("autoMerge recovery: without a race it lands (done, claim cleared)", async () => {
    github.prMergedPostCheckPasses = true;
    const taskId = await seedTask({
      status: "in_progress",
      claimedByUserId: userId,
      claimedAt: new Date(),
      autoMergeSha: "cafebabe",
      ...PR_FIELDS,
    });

    const res = await postJson(`/tasks/${taskId}/finish`, { autoMerge: true });

    expect(res.status).toBe(200);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("done");
    expect(row.claimedByUserId).toBeNull();
  });

  it("work-finish (in_progress -> review): a status change in the window answers 409 and writes nothing", async () => {
    const taskId = await seedTask({
      status: "in_progress",
      claimedByUserId: userId,
      claimedAt: new Date(),
      ...PR_FIELDS,
    });
    moveDuringRead(taskId, "open");

    const res = await postJson(`/tasks/${taskId}/finish`, { result: "Done." });

    expect(res.status).toBe(409);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("open");
    expect(row.result).toBeNull();
    expect(emitReviewSignal).not.toHaveBeenCalled();
    expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "task.transitioned" }));
  });

  it("work-finish: without a race it lands (review, the result stored)", async () => {
    const taskId = await seedTask({
      status: "in_progress",
      claimedByUserId: userId,
      claimedAt: new Date(),
      ...PR_FIELDS,
    });

    const res = await postJson(`/tasks/${taskId}/finish`, { result: "Done." });

    expect(res.status).toBe(200);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("review");
    expect(row.result).toBe("Done.");
  });
});

describe("POST /tasks/:id/merge compare-and-swaps its done write", () => {
  it("a status change in the window (after the PR merge) answers 409 and writes nothing", async () => {
    const claimantId = await seedUser();
    const taskId = await seedTask({
      status: "review",
      claimedByUserId: claimantId,
      claimedAt: new Date(),
      ...PR_FIELDS,
    });
    moveDuringRead(taskId, "in_progress");

    const res = await postJson(`/tasks/${taskId}/merge`, {});

    expect(res.status).toBe(409);
    expect(github.performPrMerge).toHaveBeenCalledTimes(1);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("in_progress");
    expect(row.autoMergeSha).toBeNull();
    expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "task.merged" }));
  });

  it("without a race it lands (done, the merge sha stored, claims cleared)", async () => {
    const claimantId = await seedUser();
    const taskId = await seedTask({
      status: "review",
      claimedByUserId: claimantId,
      claimedAt: new Date(),
      ...PR_FIELDS,
    });

    const res = await postJson(`/tasks/${taskId}/merge`, {});

    expect(res.status).toBe(200);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("done");
    expect(row.autoMergeSha).toBe("deadbeef");
    expect(row.claimedByUserId).toBeNull();
  });
});

describe("POST /tasks/:id/review compare-and-swaps its status write", () => {
  it("a status change in the window answers 409 and writes nothing", async () => {
    const claimantId = await seedUser();
    const taskId = await seedTask({
      status: "review",
      claimedByUserId: claimantId,
      claimedAt: new Date(),
      ...PR_FIELDS,
    });
    moveDuringRead(taskId, "in_progress");

    const res = await postJson(`/tasks/${taskId}/review`, { action: "approve" });

    expect(res.status).toBe(409);
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("in_progress");
    expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "task.reviewed" }));
  });

  it("without a race it lands (done)", async () => {
    const claimantId = await seedUser();
    const taskId = await seedTask({
      status: "review",
      claimedByUserId: claimantId,
      claimedAt: new Date(),
      ...PR_FIELDS,
    });

    const res = await postJson(`/tasks/${taskId}/review`, { action: "approve" });

    expect(res.status).toBe(200);
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("done");
  });
});
