/**
 * DB-backed test: a work-claim task_finish (no autoMerge) moves the task along
 * an edge that exists from the task's CURRENT state, on a stored workflow with
 * several work states and several review-like states.
 *
 * Shape (the multi-work-state workflow of the tests):
 *
 *   open -> work -> scratch -> other -> spec_check -> shipped
 *             \-> qa (requires branchPresent) -> shipped
 *
 * `spec_check` is the first review-like state in state order, but only `other`
 * reaches it. `work` (what task_start moves the task to) reaches `qa`
 * directly, and only that edge carries a gate. `scratch` has no edge into any
 * review-like state.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";
import type { WorkflowDefinitionShape } from "../../src/services/default-workflow.js";
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
  resolveTeamId: vi.fn(),
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

/* eslint-disable @typescript-eslint/no-explicit-any */
let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
let teamId: string;
let userId: string;
let agent: Actor;

const MULTI_DEFINITION: WorkflowDefinitionShape = {
  initialState: "open",
  states: [
    { name: "open", label: "Open", terminal: false },
    { name: "work", label: "Work", terminal: false },
    { name: "scratch", label: "Scratch", terminal: false },
    { name: "other", label: "Other", terminal: false },
    { name: "spec_check", label: "Spec check", terminal: false },
    { name: "qa", label: "QA", terminal: false },
    { name: "shipped", label: "Shipped", terminal: true },
  ],
  transitions: [
    { from: "open", to: "work" },
    { from: "work", to: "scratch" },
    { from: "scratch", to: "other" },
    { from: "work", to: "qa", requires: ["branchPresent"] },
    { from: "other", to: "spec_check" },
    { from: "spec_check", to: "shipped" },
    { from: "qa", to: "shipped" },
  ],
};

/** No review-like state: the only work state ends the task. */
const NO_REVIEW_DEFINITION: WorkflowDefinitionShape = {
  initialState: "open",
  states: [
    { name: "open", label: "Open", terminal: false },
    { name: "work", label: "Work", terminal: false },
    { name: "shipped", label: "Shipped", terminal: true },
  ],
  transitions: [
    { from: "open", to: "work" },
    { from: "work", to: "shipped" },
  ],
};

function makeApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("groundingRemoteTargetGuard", null);
    await next();
  });
  app.route("/api", taskRouter);
  return app;
}

async function call(method: string, path: string, body: unknown = {}) {
  const res = await makeApp(agent).request(`/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function seedWorkflowTask(definition: WorkflowDefinitionShape | null, overrides: Record<string, unknown> = {}) {
  const projectId = randomUUID();
  await db.project.create({ data: { id: projectId, teamId, name: "P", slug: randomUUID() } });
  let workflowId: string | null = null;
  if (definition) {
    workflowId = randomUUID();
    await db.workflow.create({ data: { id: workflowId, projectId, name: "multi", isDefault: true, definition: definition as never } });
  }
  const task = await db.task.create({
    data: { projectId, workflowId, title: "T", description: "Seeded.", status: "open", createdByUserId: userId, ...overrides },
  });
  return task.id;
}

const row = (id: string) => db.task.findUniqueOrThrow({ where: { id } });

/** start, then walk the task along the given states with the transition verb. */
async function startAndWalk(taskId: string, ...states: string[]) {
  const start = await call("POST", `/tasks/${taskId}/start`);
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  for (const status of states) {
    const moved = await call("POST", `/tasks/${taskId}/transition`, { status });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  }
  return start;
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
  accessMocks.hasProjectAccess.mockResolvedValue(true);
  accessMocks.hasProjectRole.mockResolvedValue(true);
  accessMocks.isProjectAdmin.mockResolvedValue(true);
  accessMocks.requireProjectWrite.mockResolvedValue(true);

  userId = randomUUID();
  await db.user.create({ data: { id: userId, login: `u-${userId}` } });
  teamId = randomUUID();
  await db.team.create({ data: { id: teamId, name: "Finish target", slug: randomUUID() } });
  await db.teamMember.create({ data: { teamId, userId, role: "ADMIN" } });
  accessMocks.resolveTeamId.mockResolvedValue({ ok: true, teamId });
  const scopes = ["tasks:read", "tasks:claim", "tasks:transition", "tasks:update"];
  const tokenId = randomUUID();
  await db.agentToken.create({
    data: { id: tokenId, teamId, createdById: userId, name: "worker", tokenHash: randomUUID(), scopes },
  });
  agent = { type: "agent", tokenId, teamId, userId, scopes };
});

describe("work-claim finish on a workflow with several work states", () => {
  it("task_start previews the review state and the gates of the edge the finish will use", async () => {
    const taskId = await seedWorkflowTask(MULTI_DEFINITION);
    const start = await call("POST", `/tasks/${taskId}/start`);
    expect(start.status).toBe(200);
    // spec_check (the workflow-wide first review-like state) has no edge from `work`.
    expect(start.body.expectedFinishState).toBe("qa");
    expect(start.body.effectiveGates).toEqual({ finish: ["branchPresent"] });
  });

  it("finishes from the start state into the review state it has an edge to, enforcing THAT edge's gate", async () => {
    const taskId = await seedWorkflowTask(MULTI_DEFINITION);
    const start = await startAndWalk(taskId);

    // The `work -> qa` edge requires branchPresent, the edge into spec_check requires nothing.
    const blocked = await call("POST", `/tasks/${taskId}/finish`, { result: "done" });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error).toBe("precondition_failed");
    expect(blocked.body.failed.map((f: { rule: string }) => f.rule)).toEqual(["branchPresent"]);
    expect((await row(taskId)).status).toBe("work");

    await db.task.update({ where: { id: taskId }, data: { branchName: "feat/x" } });
    const finished = await call("POST", `/tasks/${taskId}/finish`, { result: "done" });
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);
    expect(finished.body.targetStatus).toBe(start.body.expectedFinishState);
    expect(finished.body.targetStatus).toBe("qa");
    const after = await row(taskId);
    expect(after.status).toBe("qa");
    // A review-like target keeps the work claim, as it does for the built-in review.
    expect(after.claimedByAgentId).toBe(agent.type === "agent" ? agent.tokenId : null);
  });

  it("finishes from the later work state into the review state that state reaches", async () => {
    const taskId = await seedWorkflowTask(MULTI_DEFINITION);
    await startAndWalk(taskId, "scratch", "other");

    const finished = await call("POST", `/tasks/${taskId}/finish`, { result: "done" });
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);
    // The workflow-wide first review-like state is spec_check; `other` reaches exactly it.
    expect(finished.body.targetStatus).toBe("spec_check");
    const after = await row(taskId);
    expect(after.status).toBe("spec_check");
    expect(after.claimedByAgentId).not.toBeNull();
  });

  it("a work state with no edge into a review state keeps the unchanged no_transition answer", async () => {
    const taskId = await seedWorkflowTask(MULTI_DEFINITION);
    await startAndWalk(taskId, "scratch");

    const refused = await call("POST", `/tasks/${taskId}/finish`, { result: "done" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("bad_request");
    expect(refused.body.message).toMatch(/^Transition from 'scratch' to 'spec_check' is not allowed by workflow/);
    const after = await row(taskId);
    expect(after.status).toBe("scratch");
    expect(after.claimedByAgentId).not.toBeNull();
  });

  it("a workflow without a review-like state finishes into the terminal state and releases the claim", async () => {
    const taskId = await seedWorkflowTask(NO_REVIEW_DEFINITION);
    await startAndWalk(taskId);

    const finished = await call("POST", `/tasks/${taskId}/finish`, { result: "done" });
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);
    expect(finished.body.targetStatus).toBe("shipped");
    const after = await row(taskId);
    expect(after.status).toBe("shipped");
    expect(after.claimedByAgentId).toBeNull();
  });

  it("the built-in four-state workflow still finishes in_progress into review", async () => {
    const taskId = await seedWorkflowTask(null, { branchName: "feat/x", prUrl: "https://github.com/acme/thing/pull/1", prNumber: 1 });
    const start = await call("POST", `/tasks/${taskId}/start`);
    expect(start.status).toBe(200);
    expect(start.body.expectedFinishState).toBe("review");

    const finished = await call("POST", `/tasks/${taskId}/finish`, { result: "done" });
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);
    expect(finished.body.targetStatus).toBe("review");
    expect((await row(taskId)).status).toBe("review");
  });
});
