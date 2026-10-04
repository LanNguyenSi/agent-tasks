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
  // Runs once, right after the first task list query the predicate accepts
  // (the webhook handlers find their tasks with findMany, not findUnique).
  afterTaskList: null as { matches: (args: { where?: Record<string, unknown> }) => boolean; run: () => Promise<void> } | null,
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
              if (method === "findMany" && typeof member === "function") {
                return async (...args: unknown[]) => {
                  const rows = await (member as (...a: unknown[]) => Promise<unknown>).apply(delegate, args);
                  const hook = shared.afterTaskList;
                  if (hook && hook.matches((args[0] ?? {}) as { where?: Record<string, unknown> })) {
                    shared.afterTaskList = null;
                    await hook.run();
                  }
                  return rows;
                };
              }
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
import { emitReviewSignal, emitTaskApprovedSignal } from "../../src/services/review-signal.js";
import { githubRouter } from "../../src/routes/github.js";
import { handleIssuesEvent, handlePullRequestEvent, handlePullRequestReviewEvent } from "../../src/services/github-webhook.js";
import { applyGithubObservedContext } from "../../src/services/grounding-github-observation-context.js";

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
  shared.afterTaskList = null;
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
    expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "task.merge_webhook_first" }));
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

    // The PR is merged by then, so the answer says so instead of the plain
    // "reload and retry" conflict, and the merge sha is on record.
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; mergeSha: string };
    expect(body.error).toBe("merged_but_status_changed");
    expect(body.mergeSha).toBe("deadbeef");
    expect(github.performPrMerge).toHaveBeenCalledTimes(1);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("in_progress");
    expect(row.autoMergeSha).toBeNull();
    expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "task.merged" }));
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.merged_status_conflict",
        taskId,
        payload: expect.objectContaining({ mergeSha: "deadbeef", via: "task_merge", currentStatus: "in_progress" }),
      }),
    );
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
    expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "task.merge_webhook_first" }));
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

    const res = await postJson(`/tasks/${taskId}/review`, { action: "approve", comment: "LGTM" });

    expect(res.status).toBe(409);
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("in_progress");
    expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "task.reviewed" }));
    // The review did not happen, so its comment must not be on the timeline.
    expect(await db.comment.findMany({ where: { taskId } })).toEqual([]);
  });

  it("without a race it lands (done)", async () => {
    const claimantId = await seedUser();
    const taskId = await seedTask({
      status: "review",
      claimedByUserId: claimantId,
      claimedAt: new Date(),
      ...PR_FIELDS,
    });

    const res = await postJson(`/tasks/${taskId}/review`, { action: "approve", comment: "LGTM" });

    expect(res.status).toBe(200);
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("done");
    // The comment is stored and the response, read after the write, carries it.
    const stored = await db.comment.findMany({ where: { taskId } });
    expect(stored.map((comment) => comment.content)).toEqual(["[Approved] LGTM"]);
    const body = (await res.json()) as { task: { status: string; comments: Array<{ content: string }> } };
    expect(body.task.status).toBe("done");
    expect(body.task.comments.map((comment) => comment.content)).toEqual(["[Approved] LGTM"]);
  });
});

// ---------------------------------------------------------------------------
// The PR-merge webhook of the system itself landing between the GitHub merge
// and the guarded write.
// ---------------------------------------------------------------------------

const MERGE_PR = { branchName: "feat/x", prUrl: "https://github.com/acme/thing/pull/1", prNumber: 1 };

async function autonomousProject() {
  await db.project.update({ where: { id: projectId }, data: { githubRepo: "acme/thing", governanceMode: "AUTONOMOUS", soloMode: true } });
}

/** The two writers a merged-PR event can reach: the legacy handler and the Grounding observation adapter. */
const WEBHOOK_WRITERS: Array<[string, (taskId: string) => Promise<void>]> = [
  [
    "handlePullRequestEvent",
    async () => {
      await handlePullRequestEvent({
        action: "closed",
        repository: { full_name: "acme/thing" },
        pull_request: {
          number: 1,
          html_url: MERGE_PR.prUrl,
          merged: true,
          merged_by: { login: "bot" },
          head: { ref: MERGE_PR.branchName },
        },
      } as never);
    },
  ],
  [
    "applyGithubObservedContext",
    async (taskId) => {
      await db.$transaction(async (tx) => {
        const row = await tx.task.findUniqueOrThrow({ where: { id: taskId }, include: { project: true } });
        await applyGithubObservedContext(tx, [{ task: row as never, patch: { status: "done" } }], {
          deliveryId: randomUUID(),
          reason: "pull_request.closed",
        });
      });
    },
  ],
];

/** performPrMerge stand-in: GitHub merges, then the merged-PR event is processed before the handler writes. */
function mergeThenWebhook(webhook: (taskId: string) => Promise<void>, taskId: string) {
  github.performPrMerge.mockImplementation(async () => {
    await webhook(taskId);
    return { ok: true, sha: "deadbeef", alreadyMerged: false };
  });
}

describe.each(WEBHOOK_WRITERS)(
  "the PR-merge webhook (%s) moves the task to done between the GitHub merge and the handler's write",
  (_writer, webhook) => {
    beforeEach(autonomousProject);

    it("POST /tasks/:id/merge: completes against the webhook-moved row (200, claims cleared, sha stored, merge audit)", async () => {
      const claimantId = await seedUser();
      const taskId = await seedTask({ status: "review", claimedByUserId: claimantId, claimedAt: new Date(), ...MERGE_PR });
      mergeThenWebhook(webhook, taskId);

      const res = await postJson(`/tasks/${taskId}/merge`, {});

      expect(res.status).toBe(200);
      const body = (await res.json()) as { merged: boolean; sha: string; task: { status: string } };
      expect(body.merged).toBe(true);
      expect(body.sha).toBe("deadbeef");
      expect(body.task.status).toBe("done");
      const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
      expect(row.status).toBe("done");
      expect(row.claimedByUserId).toBeNull();
      expect(row.claimedAt).toBeNull();
      expect(row.autoMergeSha).toBe("deadbeef");
      expect(logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: "task.merged", taskId, payload: expect.objectContaining({ sha: "deadbeef" }) }),
      );
      expect(logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: "task.merge_webhook_first", taskId, payload: expect.objectContaining({ mergeSha: "deadbeef" }) }),
      );
      expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "task.merged_status_conflict" }));
    });

    it("POST /tasks/:id/finish Mode A autoMerge: completes (200, claim cleared, sha and result stored, auto-merge audit)", async () => {
      const taskId = await seedTask({ status: "in_progress", claimedByUserId: userId, claimedAt: new Date(), ...MERGE_PR });
      mergeThenWebhook(webhook, taskId);

      const res = await postJson(`/tasks/${taskId}/finish`, { autoMerge: true, result: "shipped" });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { kind: string; autoMergeSha: string };
      expect(body.kind).toBe("work");
      expect(body.autoMergeSha).toBe("deadbeef");
      const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
      expect(row.status).toBe("done");
      expect(row.claimedByUserId).toBeNull();
      expect(row.autoMergeSha).toBe("deadbeef");
      expect(row.result).toBe("shipped");
      expect(logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: "task.auto_merged", taskId, payload: expect.objectContaining({ mode: "A", autoMergeSha: "deadbeef" }) }),
      );
    });

    it("POST /tasks/:id/finish Mode B autoMerge (review lock holder approves): completes (200, both claims cleared, sha stored, audit)", async () => {
      const claimantId = await seedUser();
      const taskId = await seedTask({
        status: "review",
        claimedByUserId: claimantId,
        claimedAt: new Date(),
        reviewClaimedByUserId: userId,
        reviewClaimedAt: new Date(),
        ...MERGE_PR,
      });
      mergeThenWebhook(webhook, taskId);

      const res = await postJson(`/tasks/${taskId}/finish`, { outcome: "approve", autoMerge: true });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { kind: string; autoMergeSha: string };
      expect(body.kind).toBe("review");
      expect(body.autoMergeSha).toBe("deadbeef");
      const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
      expect(row.status).toBe("done");
      expect(row.claimedByUserId).toBeNull();
      expect(row.reviewClaimedByUserId).toBeNull();
      expect(row.autoMergeSha).toBe("deadbeef");
      expect(logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: "task.auto_merged", taskId, payload: expect.objectContaining({ mode: "B", autoMergeSha: "deadbeef" }) }),
      );
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "task.reviewed", taskId }));
    });

    it("POST /tasks/:id/finish self-approve autoMerge (work claim holder on a review task): completes (200, claim cleared, sha stored)", async () => {
      const taskId = await seedTask({ status: "review", claimedByUserId: userId, claimedAt: new Date(), ...MERGE_PR });
      mergeThenWebhook(webhook, taskId);

      const res = await postJson(`/tasks/${taskId}/finish`, { outcome: "approve", autoMerge: true });

      expect(res.status).toBe(200);
      const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
      expect(row.status).toBe("done");
      expect(row.claimedByUserId).toBeNull();
      expect(row.autoMergeSha).toBe("deadbeef");
      expect(logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: "task.auto_merged", taskId, payload: expect.objectContaining({ mode: "B_self_approve", autoMergeSha: "deadbeef" }) }),
      );
    });

    it("POST /tasks/:id/finish autoMerge recovery (merged earlier, PR event lands before the write): completes (200, claim cleared)", async () => {
      github.prMergedPostCheckPasses = true;
      const taskId = await seedTask({
        status: "in_progress",
        claimedByUserId: userId,
        claimedAt: new Date(),
        autoMergeSha: "cafebabe",
        ...MERGE_PR,
      });
      shared.afterTaskRead = () => webhook(taskId);

      const res = await postJson(`/tasks/${taskId}/finish`, { autoMerge: true, result: "shipped" });

      expect(res.status).toBe(200);
      const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
      expect(row.status).toBe("done");
      expect(row.claimedByUserId).toBeNull();
      expect(row.autoMergeSha).toBe("cafebabe");
      expect(row.result).toBe("shipped");
    });
  },
);

describe("a change other than the webhook's done after the GitHub merge answers merged_but_status_changed", () => {
  beforeEach(autonomousProject);

  /** performPrMerge stand-in: GitHub merges, then the task is moved elsewhere before the handler writes. */
  function mergeThenMove(taskId: string, status: string) {
    github.performPrMerge.mockImplementation(async () => {
      await db.task.update({ where: { id: taskId }, data: { status } });
      return { ok: true, sha: "deadbeef", alreadyMerged: false };
    });
  }

  it.each([
    ["/merge", "review", {}, "merge"],
    ["/finish Mode A", "in_progress", { autoMerge: true, result: "shipped" }, "finish"],
  ] as const)("%s: 409 merged_but_status_changed with the sha, nothing written, an operator audit event", async (_label, status, body, verb) => {
    const claimantId = await seedUser();
    const taskId = await seedTask({
      status,
      claimedByUserId: status === "review" ? claimantId : userId,
      claimedAt: new Date(),
      ...MERGE_PR,
    });
    mergeThenMove(taskId, status === "review" ? "in_progress" : "open");

    const res = await postJson(`/tasks/${taskId}/${verb}`, body);

    expect(res.status).toBe(409);
    const answer = (await res.json()) as { error: string; mergeSha: string; currentStatus: string };
    expect(answer.error).toBe("merged_but_status_changed");
    expect(answer.mergeSha).toBe("deadbeef");
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe(status === "review" ? "in_progress" : "open");
    expect(row.autoMergeSha).toBeNull();
    expect(row.result).toBeNull();
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.merged_status_conflict",
        taskId,
        payload: expect.objectContaining({ mergeSha: "deadbeef", currentStatus: answer.currentStatus }),
      }),
    );
  });
});

describe("the post-merge loss reports what the row looks like when the last write lost", () => {
  beforeEach(autonomousProject);

  /** A write that sets a status, as every real status writer does: it bumps the status version too. */
  function moveTo(taskId: string, data: Record<string, unknown>) {
    return db.task.update({ where: { id: taskId }, data: { ...data, statusVersion: { increment: 1 } } });
  }

  it("the fresh-row retry loses to a reopen: the 409 body and the audit event carry the reopened status, not the stale done", async () => {
    const claimantId = await seedUser();
    const taskId = await seedTask({ status: "review", claimedByUserId: claimantId, claimedAt: new Date(), ...MERGE_PR });
    github.performPrMerge.mockImplementation(async () => {
      // The webhook completes the task, and the task is reopened again after the
      // handler has re-read that done row and before its retry writes.
      await moveTo(taskId, { status: "done" });
      shared.afterTaskRead = async () => {
        await moveTo(taskId, { status: "open" });
      };
      return { ok: true, sha: "deadbeef", alreadyMerged: false };
    });

    const res = await postJson(`/tasks/${taskId}/merge`, {});

    expect(res.status).toBe(409);
    const answer = (await res.json()) as { error: string; currentStatus: string; message: string };
    expect(answer.error).toBe("merged_but_status_changed");
    expect(answer.currentStatus).toBe("open");
    expect(answer.message).toContain("changed to 'open'");
    expect(answer.message).not.toContain("'done'");
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("open");
    expect(row.autoMergeSha).toBeNull();
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.merged_status_conflict",
        taskId,
        payload: expect.objectContaining({ currentStatus: "open", reason: "status_changed" }),
      }),
    );
  });

  it("a status change says which status the task changed to, and tells the operator to reconcile by hand", async () => {
    const claimantId = await seedUser();
    const taskId = await seedTask({ status: "review", claimedByUserId: claimantId, claimedAt: new Date(), ...MERGE_PR });
    github.performPrMerge.mockImplementation(async () => {
      await moveTo(taskId, { status: "in_progress" });
      return { ok: true, sha: "deadbeef", alreadyMerged: false };
    });

    const res = await postJson(`/tasks/${taskId}/merge`, {});

    expect(res.status).toBe(409);
    const answer = (await res.json()) as { message: string };
    expect(answer.message).toContain("status changed to 'in_progress'");
    expect(answer.message).toContain("reconcile it by hand");
    expect(answer.message).not.toContain("safe");
  });

  it("only a claim moved (status and version as read): the message says so and that retrying the request is safe", async () => {
    const claimantId = await seedUser();
    const otherId = await seedUser();
    const taskId = await seedTask({ status: "review", claimedByUserId: claimantId, claimedAt: new Date(), ...MERGE_PR });
    github.performPrMerge.mockImplementation(async () => {
      await db.task.update({ where: { id: taskId }, data: { claimedByUserId: otherId } });
      return { ok: true, sha: "deadbeef", alreadyMerged: false };
    });

    const res = await postJson(`/tasks/${taskId}/merge`, {});

    expect(res.status).toBe(409);
    const answer = (await res.json()) as { error: string; message: string; currentStatus: string };
    expect(answer.error).toBe("merged_but_status_changed");
    expect(answer.currentStatus).toBe("review");
    expect(answer.message).toContain("a claim on the task moved");
    expect(answer.message).toContain("Retrying the same request is safe");
    expect(answer.message).not.toContain("reconcile");
    expect(answer.message).not.toContain("status changed");
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.merged_status_conflict",
        taskId,
        payload: expect.objectContaining({ reason: "claim_moved", currentStatus: "review" }),
      }),
    );
  });
});

describe("a non-webhook writer set done between the GitHub merge and the handler's write", () => {
  beforeEach(autonomousProject);

  /** The merged-PR event does not come from the webhook: an approval or admin write set done and its own result. */
  function mergeThenOtherWriterDone(taskId: string, result: string | null) {
    const seen = { versionBeforeRetry: -1 };
    github.performPrMerge.mockImplementation(async () => {
      const row = await db.task.update({
        where: { id: taskId },
        data: { status: "done", result, claimedByUserId: null, claimedAt: null, statusVersion: { increment: 1 } },
      });
      seen.versionBeforeRetry = row.statusVersion;
      return { ok: true, sha: "deadbeef", alreadyMerged: false };
    });
    return seen;
  }

  it("the other writer's result is kept, the merge sha is stored, and the audit event carries the prior status and version", async () => {
    const taskId = await seedTask({ status: "in_progress", claimedByUserId: userId, claimedAt: new Date(), ...MERGE_PR });
    const seen = mergeThenOtherWriterDone(taskId, "approved by the reviewer");

    const res = await postJson(`/tasks/${taskId}/finish`, { autoMerge: true, result: "shipped by the claimant" });

    expect(res.status).toBe(200);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("done");
    expect(row.result).toBe("approved by the reviewer");
    expect(row.autoMergeSha).toBe("deadbeef");
    expect(row.claimedByUserId).toBeNull();
    // The retry's own write bumped the version once more.
    expect(row.statusVersion).toBe(seen.versionBeforeRetry + 1);
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.merge_webhook_first",
        taskId,
        payload: expect.objectContaining({
          mergeSha: "deadbeef",
          priorStatus: "done",
          priorStatusVersion: seen.versionBeforeRetry,
          resultKept: true,
        }),
      }),
    );
  });

  it("a result that is still null is written by the retry (resultKept false in the audit event)", async () => {
    const taskId = await seedTask({ status: "in_progress", claimedByUserId: userId, claimedAt: new Date(), ...MERGE_PR });
    const seen = mergeThenOtherWriterDone(taskId, null);

    const res = await postJson(`/tasks/${taskId}/finish`, { autoMerge: true, result: "shipped by the claimant" });

    expect(res.status).toBe(200);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.result).toBe("shipped by the claimant");
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.merge_webhook_first",
        payload: expect.objectContaining({ priorStatus: "done", priorStatusVersion: seen.versionBeforeRetry, resultKept: false }),
      }),
    );
  });

  /** A review task whose lock holder (the test user) approves with autoMerge; a second approval lands inside the merge. */
  async function reviewTaskApprovedTwice() {
    const claimantId = await seedUser();
    const taskId = await seedTask({
      status: "review",
      claimedByUserId: claimantId,
      claimedAt: new Date(),
      reviewClaimedByUserId: userId,
      reviewClaimedAt: new Date(),
      ...MERGE_PR,
    });
    const inner = { status: 0, versionAfter: -1 };
    github.performPrMerge.mockImplementation(async () => {
      // A real concurrent approval: it clears the lock, stores its own result
      // and sends its own approval signal before this request writes.
      const res = await postJson(`/tasks/${taskId}/finish`, { outcome: "approve", result: "approved by the second reviewer" });
      inner.status = res.status;
      inner.versionAfter = (await db.task.findUniqueOrThrow({ where: { id: taskId } })).statusVersion;
      return { ok: true, sha: "deadbeef", alreadyMerged: false };
    });
    return { taskId, claimantId, inner };
  }

  it("a concurrent approval inside the merge: this request completes, keeps its result, and both approvals signal (the audit event marks the overlap)", async () => {
    const { taskId, inner } = await reviewTaskApprovedTwice();

    const res = await postJson(`/tasks/${taskId}/finish`, { outcome: "approve", autoMerge: true, result: "approved by the first reviewer" });

    expect(res.status).toBe(200);
    expect(inner.status).toBe(200);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("done");
    expect(row.result).toBe("approved by the second reviewer");
    expect(row.autoMergeSha).toBe("deadbeef");
    expect(row.statusVersion).toBe(inner.versionAfter + 1);
    // One signal from the concurrent approval, one from this request.
    expect(emitTaskApprovedSignal).toHaveBeenCalledTimes(2);
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.merge_webhook_first",
        taskId,
        payload: expect.objectContaining({
          priorStatus: "done",
          priorStatusVersion: inner.versionAfter,
          resultKept: true,
        }),
      }),
    );
  });

  it("when the other writer's result was kept, this request's approval signal carries the stored result, not the discarded one", async () => {
    const { taskId } = await reviewTaskApprovedTwice();

    const res = await postJson(`/tasks/${taskId}/finish`, { outcome: "approve", autoMerge: true, result: "approved by the first reviewer" });

    expect(res.status).toBe(200);
    const comments = vi.mocked(emitTaskApprovedSignal).mock.calls.map((call) => call[5]);
    expect(comments).toEqual(["approved by the second reviewer", "approved by the second reviewer"]);
  });

  it("a result still null is written by the retry and the signal carries the caller's own result", async () => {
    const claimantId = await seedUser();
    const taskId = await seedTask({
      status: "review",
      claimedByUserId: claimantId,
      claimedAt: new Date(),
      reviewClaimedByUserId: userId,
      reviewClaimedAt: new Date(),
      ...MERGE_PR,
    });
    mergeThenOtherWriterDone(taskId, null);

    const res = await postJson(`/tasks/${taskId}/finish`, { outcome: "approve", autoMerge: true, result: "approved by the first reviewer" });

    expect(res.status).toBe(200);
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).result).toBe("approved by the first reviewer");
    expect(vi.mocked(emitTaskApprovedSignal).mock.calls.map((call) => call[5])).toEqual(["approved by the first reviewer"]);
  });

  it("self-approve autoMerge: the signal carries the stored result when the other writer's was kept", async () => {
    const taskId = await seedTask({ status: "review", claimedByUserId: userId, claimedAt: new Date(), ...MERGE_PR });
    mergeThenOtherWriterDone(taskId, "result of the other writer");

    const res = await postJson(`/tasks/${taskId}/finish`, { outcome: "approve", autoMerge: true, result: "the claimant's own result" });

    expect(res.status).toBe(200);
    expect(vi.mocked(emitTaskApprovedSignal).mock.calls.map((call) => call[5])).toEqual(["result of the other writer"]);
  });

  it("a result stored between the fresh-row read and the retry is not overwritten: the retry drops its own and says the result was kept", async () => {
    const taskId = await seedTask({ status: "in_progress", claimedByUserId: userId, claimedAt: new Date(), ...MERGE_PR });
    github.performPrMerge.mockImplementation(async () => {
      // The other writer sets done without a result; a result-only write then
      // lands after the handler re-read that row and before its retry writes.
      await db.task.update({
        where: { id: taskId },
        data: { status: "done", result: null, claimedByUserId: null, claimedAt: null, statusVersion: { increment: 1 } },
      });
      shared.afterTaskRead = async () => {
        await db.task.update({ where: { id: taskId }, data: { result: "late edit" } });
      };
      return { ok: true, sha: "deadbeef", alreadyMerged: false };
    });

    const res = await postJson(`/tasks/${taskId}/finish`, { autoMerge: true, result: "shipped by the claimant" });

    expect(res.status).toBe(200);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("done");
    expect(row.result).toBe("late edit");
    expect(row.autoMergeSha).toBe("deadbeef");
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.merge_webhook_first",
        taskId,
        payload: expect.objectContaining({ priorStatus: "done", resultKept: true }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// The webhook observation writer and the status version.
// ---------------------------------------------------------------------------

async function observeStatus(taskId: string, status: string) {
  await db.$transaction(async (tx) => {
    const row = await tx.task.findUniqueOrThrow({ where: { id: taskId }, include: { project: true } });
    await applyGithubObservedContext(tx, [{ task: row as never, patch: { status } }], {
      deliveryId: randomUUID(),
      reason: "pull_request.synchronize",
    });
  });
}

describe("the Grounding webhook observation writer bumps the status version", () => {
  it("an observed status write adds one", async () => {
    const taskId = await seedTask({ status: "review", claimedByUserId: userId, claimedAt: new Date(), ...PR_FIELDS });

    await observeStatus(taskId, "in_progress");

    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("in_progress");
    expect(row.statusVersion).toBe(1);
  });

  it("an observed write without a status leaves the version alone", async () => {
    const taskId = await seedTask({ status: "review", claimedByUserId: userId, claimedAt: new Date(), ...PR_FIELDS });

    await db.$transaction(async (tx) => {
      const row = await tx.task.findUniqueOrThrow({ where: { id: taskId }, include: { project: true } });
      await applyGithubObservedContext(tx, [{ task: row as never, patch: { prNumber: 2 } }], {
        deliveryId: randomUUID(),
        reason: "pull_request.edited",
      });
    });

    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.prNumber).toBe(2);
    expect(row.statusVersion).toBe(0);
  });

  it.each([
    ["PATCH /tasks/:id", (taskId: string) => patchStatus(taskId, "done")],
    ["POST /tasks/:id/transition", (taskId: string) => transition(taskId, "done")],
  ])("a review -> in_progress -> review round trip made of observed writes makes the stale %s answer 409", async (_label, approve) => {
    const taskId = await seedTask({ status: "review", claimedByUserId: userId, claimedAt: new Date(), ...PR_FIELDS });
    shared.afterTaskRead = async () => {
      await observeStatus(taskId, "in_progress");
      await observeStatus(taskId, "review");
    };

    const res = await approve(taskId);

    expect(res.status).toBe(409);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("review");
    expect(row.statusVersion).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Every writer of a task status bumps the status version by exactly one.
// ---------------------------------------------------------------------------

describe("every status writer adds one to the status version", () => {
  const AGENT_SCOPES = ["tasks:transition", "tasks:claim", "tasks:update", "github:pr_merge"];

  async function seedAgent() {
    const tokenId = randomUUID();
    await db.agentToken.create({
      data: { id: tokenId, teamId, createdById: userId, name: `agent-${tokenId.slice(0, 8)}`, tokenHash: tokenId, scopes: AGENT_SCOPES },
    });
    return { type: "agent", tokenId, teamId, userId, scopes: AGENT_SCOPES } as Actor;
  }

  const OTHER_CLAIMANT = async () => seedUser();

  // [writer, seed overrides, request, expected status after]
  const WRITERS: Array<{
    name: string;
    expectedStatus: string;
    run: () => Promise<{ taskId: string; res: Response }>;
  }> = [
    {
      name: "POST /tasks/:id/start",
      expectedStatus: "in_progress",
      run: async () => {
        const taskId = await seedTask({ status: "open" });
        return { taskId, res: await postJson(`/tasks/${taskId}/start`, {}) };
      },
    },
    {
      name: "POST /tasks/:id/claim",
      expectedStatus: "in_progress",
      run: async () => {
        const taskId = await seedTask({ status: "open" });
        return { taskId, res: await postJson(`/tasks/${taskId}/claim`, {}) };
      },
    },
    {
      name: "POST /tasks/:id/release",
      expectedStatus: "open",
      run: async () => {
        const taskId = await seedTask({ status: "in_progress", claimedByUserId: userId, claimedAt: new Date() });
        return { taskId, res: await postJson(`/tasks/${taskId}/release`, {}) };
      },
    },
    {
      name: "POST /tasks/:id/abandon",
      expectedStatus: "open",
      run: async () => {
        const taskId = await seedTask({ status: "in_progress", claimedByUserId: userId, claimedAt: new Date() });
        return { taskId, res: await postJson(`/tasks/${taskId}/abandon`, {}) };
      },
    },
    {
      name: "POST /tasks/:id/creator-abandon",
      expectedStatus: "abandoned",
      run: async () => {
        const agent = await seedAgent();
        const taskId = await seedTask({ status: "open", createdByUserId: null, createdByAgentId: (agent as { tokenId: string }).tokenId });
        return { taskId, res: await postJson(`/tasks/${taskId}/creator-abandon`, {}, agent) };
      },
    },
    {
      name: "POST /tasks/:id/finish (work finish, compare-and-swap helper)",
      expectedStatus: "review",
      run: async () => {
        const taskId = await seedTask({ status: "in_progress", claimedByUserId: userId, claimedAt: new Date(), ...PR_FIELDS });
        return { taskId, res: await postJson(`/tasks/${taskId}/finish`, { result: "Done." }) };
      },
    },
    {
      name: "POST /tasks/:id/review (compare-and-swap helper)",
      expectedStatus: "done",
      run: async () => {
        const claimant = await OTHER_CLAIMANT();
        const taskId = await seedTask({ status: "review", claimedByUserId: claimant, claimedAt: new Date(), ...PR_FIELDS });
        return { taskId, res: await postJson(`/tasks/${taskId}/review`, { action: "approve" }) };
      },
    },
    {
      name: "POST /tasks/:id/merge (compare-and-swap helper)",
      expectedStatus: "done",
      run: async () => {
        const claimant = await OTHER_CLAIMANT();
        const taskId = await seedTask({ status: "review", claimedByUserId: claimant, claimedAt: new Date(), ...PR_FIELDS });
        return { taskId, res: await postJson(`/tasks/${taskId}/merge`, {}) };
      },
    },
    {
      name: "POST /pull-requests/:prNumber/merge (legacy GitHub route)",
      expectedStatus: "done",
      run: async () => {
        await autonomousProject();
        const agent = await seedAgent();
        const claimant = await OTHER_CLAIMANT();
        const taskId = await seedTask({ status: "review", claimedByUserId: claimant, claimedAt: new Date(), ...MERGE_PR });
        const app = new Hono<{ Variables: AppVariables }>();
        app.use("*", async (c, next) => {
          c.set("actor", agent);
          c.set("groundingRemoteTargetGuard", null);
          await next();
        });
        app.route("/", githubRouter);
        const res = await app.request("/pull-requests/1/merge", {
          method: "POST",
          headers: PATCH_HEADERS,
          body: JSON.stringify({ taskId, owner: "acme", repo: "thing" }),
        });
        return { taskId, res };
      },
    },
    {
      name: "the legacy PR-merge webhook (handlePullRequestEvent)",
      expectedStatus: "done",
      run: async () => {
        await autonomousProject();
        const taskId = await seedTask({ status: "review", claimedByUserId: userId, claimedAt: new Date(), ...MERGE_PR });
        await WEBHOOK_WRITERS[0][1](taskId);
        return { taskId, res: new Response(null, { status: 200 }) };
      },
    },
    {
      name: "the Grounding webhook observation writer (applyGithubObservedContext)",
      expectedStatus: "done",
      run: async () => {
        const taskId = await seedTask({ status: "review", claimedByUserId: userId, claimedAt: new Date(), ...MERGE_PR });
        await WEBHOOK_WRITERS[1][1](taskId);
        return { taskId, res: new Response(null, { status: 200 }) };
      },
    },
  ];

  it.each(WRITERS.map((writer) => [writer.name, writer] as const))("%s", async (_name, writer) => {
    const { taskId, res } = await writer.run();

    expect(res.status).toBe(200);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe(writer.expectedStatus);
    expect(row.statusVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The claim-guarded writers (agent-tasks task 21446d1a): /start, /claim,
// /release, /abandon, creator-abandon, unabandon and demote validate against
// the row they read. Each one's own guard (an unclaimed row, the claim holder)
// still matches after a status round trip, so only the status version tells
// the stale write from a fresh one.
// ---------------------------------------------------------------------------

/**
 * From inside the read-to-write window the task leaves `status` for `through`
 * and comes back to `back`, each leg a real status write that bumps the status
 * version. Claim columns end up as they were read (the extras undo themselves).
 */
function roundTripDuringRead(
  taskId: string,
  legs: { through: string; throughData?: Record<string, unknown>; back: string; backData?: Record<string, unknown> },
) {
  shared.afterTaskRead = async () => {
    await db.task.update({
      where: { id: taskId },
      data: { status: legs.through, statusVersion: { increment: 1 }, ...legs.throughData },
    });
    await db.task.update({
      where: { id: taskId },
      data: { status: legs.back, statusVersion: { increment: 1 }, ...legs.backData },
    });
  };
}

const CLAIMED_BY_OTHER = async () => ({ claimedByUserId: await seedUser(), claimedAt: new Date() });
const CLAIM_CLEARED = { claimedByUserId: null, claimedByAgentId: null, claimedAt: null };

async function expectUnchangedAfterLostRace(taskId: string, expected: { status: string; claimedByUserId?: string | null }) {
  const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  expect(row.status).toBe(expected.status);
  expect(row.statusVersion).toBe(2);
  if (expected.claimedByUserId !== undefined) expect(row.claimedByUserId).toBe(expected.claimedByUserId);
  expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "task.claimed" }));
  expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "task.released" }));
}

describe("claim-guarded status writers compare the status version", () => {
  it("POST /tasks/:id/start: open -> in_progress -> open in the window makes the stale claim answer 409 and writes no claim", async () => {
    const taskId = await seedTask({ status: "open" });
    roundTripDuringRead(taskId, { through: "in_progress", throughData: await CLAIMED_BY_OTHER(), back: "open", backData: CLAIM_CLEARED });

    const res = await postJson(`/tasks/${taskId}/start`, {});

    expect(res.status).toBe(409);
    await expectUnchangedAfterLostRace(taskId, { status: "open", claimedByUserId: null });
  });

  it("POST /tasks/:id/claim: open -> in_progress -> open in the window makes the stale claim answer 409 and writes no claim", async () => {
    const taskId = await seedTask({ status: "open" });
    roundTripDuringRead(taskId, { through: "in_progress", throughData: await CLAIMED_BY_OTHER(), back: "open", backData: CLAIM_CLEARED });

    const res = await postJson(`/tasks/${taskId}/claim`, {});

    expect(res.status).toBe(409);
    await expectUnchangedAfterLostRace(taskId, { status: "open", claimedByUserId: null });
  });

  it("POST /tasks/:id/release: in_progress -> review -> in_progress in the window makes the stale release answer 409 and keeps the claim", async () => {
    const taskId = await seedTask({ status: "in_progress", claimedByUserId: userId, claimedAt: new Date() });
    roundTripDuringRead(taskId, { through: "review", back: "in_progress" });

    const res = await postJson(`/tasks/${taskId}/release`, {});

    expect(res.status).toBe(409);
    await expectUnchangedAfterLostRace(taskId, { status: "in_progress", claimedByUserId: userId });
  });

  it("POST /tasks/:id/abandon: a status change in the window answers 409 and neither resets the status nor drops the claim", async () => {
    const taskId = await seedTask({ status: "in_progress", claimedByUserId: userId, claimedAt: new Date() });
    // The holder keeps the work claim while the task moves on to review; an
    // abandon validated against in_progress must not reset it to open.
    shared.afterTaskRead = async () => {
      await db.task.update({ where: { id: taskId }, data: { status: "review", statusVersion: { increment: 1 } } });
    };

    const res = await postJson(`/tasks/${taskId}/abandon`, {});

    expect(res.status).toBe(409);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("review");
    expect(row.statusVersion).toBe(1);
    expect(row.claimedByUserId).toBe(userId);
    expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "task.released" }));
  });

  it("POST /tasks/:id/abandon: a round trip back to the same status in the window is also 409", async () => {
    const taskId = await seedTask({ status: "in_progress", claimedByUserId: userId, claimedAt: new Date() });
    roundTripDuringRead(taskId, { through: "review", back: "in_progress" });

    const res = await postJson(`/tasks/${taskId}/abandon`, {});

    expect(res.status).toBe(409);
    await expectUnchangedAfterLostRace(taskId, { status: "in_progress", claimedByUserId: userId });
  });

  it("POST /tasks/:id/creator-abandon: open -> in_progress -> open in the window makes the stale abandon answer 409", async () => {
    const tokenId = randomUUID();
    const scopes = ["tasks:update"];
    await db.agentToken.create({
      data: { id: tokenId, teamId, createdById: userId, name: `agent-${tokenId.slice(0, 8)}`, tokenHash: tokenId, scopes },
    });
    const agent = { type: "agent", tokenId, teamId, userId, scopes } as Actor;
    const taskId = await seedTask({ status: "open", createdByUserId: null, createdByAgentId: tokenId });
    roundTripDuringRead(taskId, { through: "in_progress", throughData: await CLAIMED_BY_OTHER(), back: "open", backData: CLAIM_CLEARED });

    const res = await postJson(`/tasks/${taskId}/creator-abandon`, {}, agent);

    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toBe(
      "Task must be open and unclaimed to creator-abandon, or it changed before the request completed",
    );
    await expectUnchangedAfterLostRace(taskId, { status: "open", claimedByUserId: null });
    expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "task.creator_abandoned" }));
  });

  it("PATCH /tasks/:id unabandon: abandoned -> open -> abandoned in the window makes the stale restore answer 409", async () => {
    const taskId = await seedTask({ status: "abandoned" });
    roundTripDuringRead(taskId, { through: "open", back: "abandoned" });

    const res = await patchStatus(taskId, "open", { title: "Restored" });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain("or it changed before the request completed");
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("abandoned");
    expect(row.statusVersion).toBe(2);
    expect(row.title).not.toBe("Restored");
    expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "task.unabandoned" }));
  });

  it("PATCH /tasks/:id demote: open -> in_progress -> open in the window makes the stale demote answer 409", async () => {
    const taskId = await seedTask({ status: "open" });
    roundTripDuringRead(taskId, { through: "in_progress", throughData: await CLAIMED_BY_OTHER(), back: "open", backData: CLAIM_CLEARED });

    const res = await patchStatus(taskId, "backlog");

    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain("or it changed before the request completed");
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("open");
    expect(row.statusVersion).toBe(2);
    expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "task.backlog_demoted" }));
  });
});

// ---------------------------------------------------------------------------
// The legacy GitHub webhook writers decide a target from the status they read.
// A write that lost its compare-and-swap re-reads the row and decides again.
// ---------------------------------------------------------------------------

describe("legacy GitHub webhook status writers do not write over a concurrent change", () => {
  const PR_EVENT_BASE = {
    repository: { full_name: "acme/thing" },
    pull_request: {
      number: 1,
      title: "Fix",
      body: null,
      html_url: MERGE_PR.prUrl,
      state: "closed" as const,
      merged: true,
      merged_by: { login: "bot" },
      head: { ref: MERGE_PR.branchName },
    },
  };

  /** After the handler's by-PR-number lookup the task is moved on by another writer (a version-bumping write). */
  function moveAfterPrLookup(taskId: string, status: string) {
    shared.afterTaskList = {
      // Earlier tests' projects share the repository name, so the handler
      // looks tasks up in each of them: only this test's project counts.
      matches: (args) => args.where?.projectId === projectId && args.where?.prNumber !== undefined,
      run: async () => {
        await db.task.update({ where: { id: taskId }, data: { status, statusVersion: { increment: 1 } } });
      },
    };
  }

  beforeEach(async () => {
    await db.project.update({ where: { id: projectId }, data: { githubRepo: "acme/thing" } });
  });

  it("PR merged (confirmation required): a task approved to done in the window stays done and is not handed back to review", async () => {
    const taskId = await seedTask({ status: "in_progress", claimedByUserId: userId, claimedAt: new Date(), ...MERGE_PR });
    moveAfterPrLookup(taskId, "done");

    await handlePullRequestEvent({ ...PR_EVENT_BASE, action: "closed" } as never);

    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("done");
    expect(row.statusVersion).toBe(1);
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.transitioned",
        taskId,
        payload: expect.objectContaining({ event: "pr_merged", from: "done", to: "done" }),
      }),
    );
  });

  it("PR merged (confirmation required): a task that moved to review in the window is left in review", async () => {
    const taskId = await seedTask({ status: "in_progress", claimedByUserId: userId, claimedAt: new Date(), ...MERGE_PR });
    moveAfterPrLookup(taskId, "review");

    await handlePullRequestEvent({ ...PR_EVENT_BASE, action: "closed" } as never);

    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("review");
    expect(row.statusVersion).toBe(1);
  });

  it("PR merged (autonomous): a task that moved to review in the window is decided again against that row and ends done", async () => {
    await autonomousProject();
    const taskId = await seedTask({ status: "in_progress", claimedByUserId: userId, claimedAt: new Date(), ...MERGE_PR });
    moveAfterPrLookup(taskId, "review");

    await handlePullRequestEvent({ ...PR_EVENT_BASE, action: "closed" } as never);

    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("done");
    // The window's own write and this one: two bumps, nothing lost or doubled.
    expect(row.statusVersion).toBe(2);
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.transitioned",
        taskId,
        payload: expect.objectContaining({ event: "pr_merged", from: "review", to: "done" }),
      }),
    );
  });

  it("changes requested: a task approved to done in the window stays done and is not sent back to in_progress", async () => {
    const taskId = await seedTask({ status: "review", claimedByUserId: userId, claimedAt: new Date(), ...MERGE_PR });
    moveAfterPrLookup(taskId, "done");

    await handlePullRequestReviewEvent({
      action: "submitted",
      repository: PR_EVENT_BASE.repository,
      pull_request: { number: 1, title: "Fix", html_url: MERGE_PR.prUrl, head: { ref: MERGE_PR.branchName } },
      review: { state: "changes_requested", user: { login: "bob" }, html_url: "https://review" },
    } as never);

    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("done");
    expect(row.statusVersion).toBe(1);
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.reviewed",
        taskId,
        payload: expect.not.objectContaining({ to: "in_progress" }),
      }),
    );
  });

  it("issue closed: a task demoted to backlog in the window is not moved to done", async () => {
    const taskId = await seedTask({ status: "in_progress", title: "[GH #7] Something", claimedByUserId: userId, claimedAt: new Date() });
    shared.afterTaskList = {
      matches: (args) =>
        args.where?.projectId === projectId &&
        typeof (args.where?.title as { contains?: string } | undefined)?.contains === "string",
      run: async () => {
        await db.task.update({ where: { id: taskId }, data: { status: "backlog", statusVersion: { increment: 1 } } });
      },
    };

    await handleIssuesEvent({
      action: "closed",
      repository: PR_EVENT_BASE.repository,
      issue: { number: 7, title: "Something", body: null, html_url: "https://github.com/acme/thing/issues/7", state: "closed" },
    } as never);

    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("backlog");
    expect(row.statusVersion).toBe(1);
    expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "task.transitioned", taskId }));
  });
});

// ---------------------------------------------------------------------------
// POST /github/pull-requests/:n/merge (the route MCP pull_requests_merge uses)
// wrote `done` unconditionally after its gate and the GitHub merge.
// ---------------------------------------------------------------------------

describe("POST /github/pull-requests/:n/merge compare-and-swaps its done write", () => {
  const AGENT_SCOPES = ["tasks:transition", "github:pr_merge"];

  async function seedMergeAgent() {
    const tokenId = randomUUID();
    await db.agentToken.create({
      data: { id: tokenId, teamId, createdById: userId, name: `agent-${tokenId.slice(0, 8)}`, tokenHash: tokenId, scopes: AGENT_SCOPES },
    });
    return { type: "agent", tokenId, teamId, userId, scopes: AGENT_SCOPES } as Actor;
  }

  function mergeViaGithubRoute(agent: Actor, taskId: string) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("actor", agent);
      c.set("groundingRemoteTargetGuard", null);
      await next();
    });
    app.route("/", githubRouter);
    return app.request("/pull-requests/1/merge", {
      method: "POST",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ taskId, owner: "acme", repo: "thing" }),
    });
  }

  beforeEach(autonomousProject);

  it("a status change after the GitHub merge answers merged_but_status_changed, writes nothing and leaves the audit event with the merge sha", async () => {
    const agent = await seedMergeAgent();
    const claimantId = await seedUser();
    const taskId = await seedTask({ status: "review", claimedByUserId: claimantId, claimedAt: new Date(), ...MERGE_PR });
    github.performPrMerge.mockImplementation(async () => {
      await db.task.update({ where: { id: taskId }, data: { status: "in_progress", statusVersion: { increment: 1 } } });
      return { ok: true, sha: "deadbeef", alreadyMerged: false };
    });

    const res = await mergeViaGithubRoute(agent, taskId);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; mergeSha: string; currentStatus: string };
    expect(body.error).toBe("merged_but_status_changed");
    expect(body.mergeSha).toBe("deadbeef");
    expect(body.currentStatus).toBe("in_progress");
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("in_progress");
    expect(row.statusVersion).toBe(1);
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.merged_status_conflict",
        taskId,
        payload: expect.objectContaining({ mergeSha: "deadbeef", via: "github_pr_merge", currentStatus: "in_progress" }),
      }),
    );
  });

  it("the system's PR-merge webhook moving the task to done first completes the write: 200 and the webhook-first audit event", async () => {
    const agent = await seedMergeAgent();
    const claimantId = await seedUser();
    const taskId = await seedTask({ status: "review", claimedByUserId: claimantId, claimedAt: new Date(), ...MERGE_PR });
    github.performPrMerge.mockImplementation(async () => {
      await WEBHOOK_WRITERS[0][1](taskId);
      return { ok: true, sha: "deadbeef", alreadyMerged: false };
    });

    const res = await mergeViaGithubRoute(agent, taskId);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { merged: boolean; task: { status: string } };
    expect(body.merged).toBe(true);
    expect(body.task.status).toBe("done");
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("done");
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.merge_webhook_first",
        taskId,
        payload: expect.objectContaining({ mergeSha: "deadbeef", via: "github_pr_merge" }),
      }),
    );
    expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "task.merged_status_conflict" }));
  });

  it.each([
    ["the review lock is released", (_c: string, _r: string, _a: string) => ({ reviewClaimedByUserId: null, reviewClaimedAt: null })],
    ["the review lock is handed to the work claimant", (c: string, _r: string, _a: string) => ({ reviewClaimedByUserId: c })],
    ["the review lock moves to the merging agent", (_c: string, _r: string, a: string) => ({ reviewClaimedByUserId: null, reviewClaimedByAgentId: a })],
    ["the work claim is handed to the reviewer", (_c: string, r: string, _a: string) => ({ claimedByUserId: r })],
    ["the work claim is handed to the merging agent", (_c: string, _r: string, a: string) => ({ claimedByUserId: null, claimedByAgentId: a })],
  ])(
    "only a claim column moves while status and version stay as read (%s): merged_but_status_changed, the row is unchanged and the audit event says claim_moved",
    async (_label, move) => {
      const agent = await seedMergeAgent();
      const claimantId = await seedUser();
      const reviewerId = await seedUser();
      const taskId = await seedTask({
        status: "review",
        claimedByUserId: claimantId,
        claimedAt: new Date(),
        reviewClaimedByUserId: reviewerId,
        reviewClaimedAt: new Date(),
        ...MERGE_PR,
      });
      const before = await db.task.findUniqueOrThrow({ where: { id: taskId } });
      github.performPrMerge.mockImplementation(async () => {
        await db.task.update({ where: { id: taskId }, data: move(claimantId, reviewerId, (agent as { tokenId: string }).tokenId) });
        return { ok: true, sha: "deadbeef", alreadyMerged: false };
      });

      const res = await mergeViaGithubRoute(agent, taskId);

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; mergeSha: string; currentStatus: string };
      expect(body.error).toBe("merged_but_status_changed");
      expect(body.mergeSha).toBe("deadbeef");
      expect(body.currentStatus).toBe("review");
      const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
      expect(row.status).toBe("review");
      expect(row.statusVersion).toBe(before.statusVersion);
      expect(logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "task.merged_status_conflict",
          taskId,
          payload: expect.objectContaining({ reason: "claim_moved", currentStatus: "review", via: "github_pr_merge" }),
        }),
      );
    },
  );

  it("only the agent review-lock column moves (an agent-held review lock is released): merged_but_status_changed with claim_moved, row unchanged", async () => {
    const agent = await seedMergeAgent();
    const reviewingAgent = (await seedMergeAgent()) as { tokenId: string };
    const claimantId = await seedUser();
    const taskId = await seedTask({
      status: "review",
      claimedByUserId: claimantId,
      claimedAt: new Date(),
      reviewClaimedByAgentId: reviewingAgent.tokenId,
      reviewClaimedAt: new Date(),
      ...MERGE_PR,
    });
    const before = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    github.performPrMerge.mockImplementation(async () => {
      await db.task.update({ where: { id: taskId }, data: { reviewClaimedByAgentId: null, reviewClaimedAt: null } });
      return { ok: true, sha: "deadbeef", alreadyMerged: false };
    });

    const res = await mergeViaGithubRoute(agent, taskId);

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("merged_but_status_changed");
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("review");
    expect(row.statusVersion).toBe(before.statusVersion);
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.merged_status_conflict",
        taskId,
        payload: expect.objectContaining({ reason: "claim_moved", via: "github_pr_merge" }),
      }),
    );
  });

  it("without a race it lands: 200, done, no conflict or webhook-first audit event", async () => {
    const agent = await seedMergeAgent();
    const claimantId = await seedUser();
    const taskId = await seedTask({ status: "review", claimedByUserId: claimantId, claimedAt: new Date(), ...MERGE_PR });

    const res = await mergeViaGithubRoute(agent, taskId);

    expect(res.status).toBe(200);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("done");
    expect(row.statusVersion).toBe(1);
    expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "task.merge_webhook_first" }));
    expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: "task.merged_status_conflict" }));
  });
});
