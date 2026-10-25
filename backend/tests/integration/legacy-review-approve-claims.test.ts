/**
 * DB-backed test for the legacy POST /tasks/:id/review route.
 *
 * Approve lands the task in a terminal state of its own workflow and must
 * leave no claim behind: work claim and review lock are cleared in the same
 * write, as task_finish and the raw transition do. Request-changes keeps the
 * work claim (the author resumes) and clears only the review lock.
 *
 * The pinned workflow names its terminal state `shipped` and its review-like
 * state `qa`, so the terminal decision must come from the task's own workflow
 * and not from the literal `done`.
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

function reviewer(id: string): Actor {
  const scopes = ["tasks:read", "tasks:claim", "tasks:transition", "tasks:update"];
  return { type: "agent", tokenId: id, teamId, userId, scopes };
}

let reviewerTokenId: string;

async function seedReviewTask(opts: { pinned: boolean }) {
  const projectId = randomUUID();
  await db.project.create({ data: { id: projectId, teamId, name: "P", slug: randomUUID(), requireDistinctReviewer: true } });
  const workflow = opts.pinned
    ? await db.workflow.create({ data: { projectId, name: "pinned", isDefault: false, definition: pinnedDefinition } })
    : null;
  const taskId = randomUUID();
  await db.task.create({
    data: {
      id: taskId,
      projectId,
      title: `Task ${taskId.slice(0, 8)}`,
      description: "Seeded task.",
      status: opts.pinned ? "qa" : "review",
      workflowId: workflow?.id ?? null,
      createdByUserId: userId,
      claimedByAgentId: agentTokenId,
      claimedAt: new Date(),
      reviewClaimedByAgentId: reviewerTokenId,
      reviewClaimedAt: new Date(),
    },
  });
  return taskId;
}

async function review(taskId: string, action: "approve" | "request_changes") {
  const res = await makeApp(reviewer(reviewerTokenId)).request(`/tasks/${taskId}/review`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, comment: "ok" }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
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
  await db.team.create({ data: { id: teamId, name: "Review", slug: randomUUID() } });
  await db.teamMember.create({ data: { teamId, userId, role: "ADMIN" } });
  const scopes = ["tasks:read", "tasks:claim", "tasks:transition", "tasks:update"];
  agentTokenId = randomUUID();
  await db.agentToken.create({ data: { id: agentTokenId, teamId, createdById: userId, name: "author", tokenHash: randomUUID(), scopes } });
  reviewerTokenId = randomUUID();
  await db.agentToken.create({ data: { id: reviewerTokenId, teamId, createdById: userId, name: "reviewer", tokenHash: randomUUID(), scopes } });
});

describe("POST /tasks/:id/review", () => {
  it("approve on the built-in workflow clears the work claim and the review lock", async () => {
    const taskId = await seedReviewTask({ pinned: false });

    const { status } = await review(taskId, "approve");

    expect(status).toBe(200);
    const row = await rowOf(taskId);
    expect(row.status).toBe("done");
    expect(row.claimedByAgentId).toBeNull();
    expect(row.claimedByUserId).toBeNull();
    expect(row.claimedAt).toBeNull();
    expect(row.reviewClaimedByAgentId).toBeNull();
    expect(row.reviewClaimedByUserId).toBeNull();
    expect(row.reviewClaimedAt).toBeNull();
  });

  it("approve on a pinned workflow clears both claims when it lands in that workflow's terminal state", async () => {
    const taskId = await seedReviewTask({ pinned: true });

    const { status } = await review(taskId, "approve");

    expect(status).toBe(200);
    const row = await rowOf(taskId);
    expect(row.status).toBe("shipped");
    expect(row.claimedByAgentId).toBeNull();
    expect(row.claimedAt).toBeNull();
    expect(row.reviewClaimedByAgentId).toBeNull();
    expect(row.reviewClaimedAt).toBeNull();
  });

  it("request_changes keeps the work claim and clears only the review lock", async () => {
    const taskId = await seedReviewTask({ pinned: false });

    const { status } = await review(taskId, "request_changes");

    expect(status).toBe(200);
    const row = await rowOf(taskId);
    expect(row.status).toBe("in_progress");
    expect(row.claimedByAgentId).toBe(agentTokenId);
    expect(row.claimedAt).not.toBeNull();
    expect(row.reviewClaimedByAgentId).toBeNull();
    expect(row.reviewClaimedByUserId).toBeNull();
    expect(row.reviewClaimedAt).toBeNull();
  });
});
