/**
 * DB-backed test for agent-tasks task ddb2417e: a workflow definition stored
 * before the state vocabulary was locked can carry `backlog` as its
 * initialState and as an edge endpoint (the retired coding-agent template:
 * initialState backlog, edge spec -> backlog). Stored definitions are read
 * without re-validation, so none of the status writers other than the three
 * human verbs (promote, demote, discard) may reach backlog through one.
 *
 * Real routes against a real database (the `groundingPostgres` helper):
 *   - POST /tasks/:id/transition spec -> backlog is refused;
 *   - POST /tasks/:id/abandon and /release reset a legacy initialState of
 *     backlog to open, never to backlog;
 *   - POST /tasks/:id/finish (review request_changes) never picks an edge
 *     into backlog as its target;
 *   - controls: valid workflows behave as before and the human promote,
 *     demote and discard still work.
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
let reviewerTokenId: string;
let human: Actor;
let agent: Actor;
let reviewer: Actor;

// The stored shape of the retired coding-agent template, trimmed: initialState
// backlog, a backlog state, and edges out of and into backlog.
const legacyDefinition = {
  initialState: "backlog",
  states: [
    { name: "backlog", label: "Backlog", terminal: false },
    { name: "spec", label: "Spec", terminal: false },
    { name: "implement", label: "Implement", terminal: false },
    { name: "review", label: "Review", terminal: false },
    { name: "done", label: "Done", terminal: true },
  ],
  transitions: [
    { from: "backlog", to: "spec", label: "Start scoping" },
    { from: "spec", to: "backlog", label: "Release" },
    { from: "spec", to: "implement", label: "Spec complete" },
    { from: "implement", to: "review", label: "Ready for review" },
    { from: "review", to: "backlog", label: "Send back" },
    { from: "review", to: "implement", label: "Request changes" },
    { from: "review", to: "done", label: "Approve" },
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

function post(actor: Actor, path: string, body?: unknown) {
  return makeApp(actor).request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

function patchStatus(actor: Actor, taskId: string, status: string) {
  return makeApp(actor).request(`/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

async function seedProject(definition: Record<string, unknown> | null) {
  const projectId = randomUUID();
  await db.project.create({ data: { id: projectId, teamId, name: "P", slug: randomUUID() } });
  if (definition) {
    await db.workflow.create({
      data: { projectId, name: "stored", isDefault: true, definition: definition as object },
    });
  }
  return projectId;
}

async function seedTask(projectId: string, overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  await db.task.create({
    data: {
      id,
      projectId,
      title: `Task ${id.slice(0, 8)}`,
      description: "Seeded task.",
      status: "open",
      createdByUserId: userId,
      ...overrides,
    },
  });
  return id;
}

const statusOf = async (taskId: string) => (await db.task.findUniqueOrThrow({ where: { id: taskId } })).status;

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
  await db.team.create({ data: { id: teamId, name: "Legacy", slug: randomUUID() } });
  await db.teamMember.create({ data: { teamId, userId, role: "ADMIN" } });
  const scopes = ["tasks:read", "tasks:claim", "tasks:transition", "tasks:update"];
  agentTokenId = randomUUID();
  await db.agentToken.create({
    data: { id: agentTokenId, teamId, createdById: userId, name: "author", tokenHash: randomUUID(), scopes },
  });
  reviewerTokenId = randomUUID();
  await db.agentToken.create({
    data: { id: reviewerTokenId, teamId, createdById: userId, name: "reviewer", tokenHash: randomUUID(), scopes },
  });
  human = { type: "human", userId, teamId };
  agent = { type: "agent", tokenId: agentTokenId, teamId, userId, scopes };
  reviewer = { type: "agent", tokenId: reviewerTokenId, teamId, userId, scopes };
});

describe("a stored legacy workflow definition cannot move a task into backlog", () => {
  it("POST /transition along a stored edge into backlog is refused and the row is unchanged", async () => {
    const projectId = await seedProject(legacyDefinition);
    const taskId = await seedTask(projectId, { status: "spec" });

    const res = await post(human, `/tasks/${taskId}/transition`, { status: "backlog" });

    expect(res.status).toBe(400);
    expect(await statusOf(taskId)).toBe("spec");
  });

  it("POST /transition along a stored edge that is not into backlog still works", async () => {
    const projectId = await seedProject(legacyDefinition);
    const taskId = await seedTask(projectId, { status: "spec" });

    const res = await post(human, `/tasks/${taskId}/transition`, { status: "implement" });

    expect(res.status).toBe(200);
    expect(await statusOf(taskId)).toBe("implement");
  });

  it("POST /abandon of a claimed task resets it to open, not to a stored initialState of backlog", async () => {
    const projectId = await seedProject(legacyDefinition);
    const taskId = await seedTask(projectId, { status: "spec", claimedByAgentId: agentTokenId, claimedAt: new Date() });

    const res = await post(agent, `/tasks/${taskId}/abandon`);

    expect(res.status).toBe(200);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("open");
    expect(row.claimedByAgentId).toBeNull();
  });

  it("POST /release of a claimed task resets it to open, not to a stored initialState of backlog", async () => {
    const projectId = await seedProject(legacyDefinition);
    const taskId = await seedTask(projectId, { status: "implement", claimedByAgentId: agentTokenId, claimedAt: new Date() });

    const res = await post(agent, `/tasks/${taskId}/release`);

    expect(res.status).toBe(200);
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe("open");
    expect(row.claimedByAgentId).toBeNull();
  });

  it("a per-task legacy workflow (task.workflowId) is sanitized the same way as a project default", async () => {
    // /transition loads the attached workflow row with the task, so this is
    // the route that reads the task-attached branch of the resolver.
    const projectId = await seedProject(null);
    const workflow = await db.workflow.create({
      data: { projectId, name: "attached", isDefault: false, definition: legacyDefinition },
    });
    const taskId = await seedTask(projectId, { status: "spec", workflowId: workflow.id });

    const res = await post(human, `/tasks/${taskId}/transition`, { status: "backlog" });

    expect(res.status).toBe(400);
    expect(await statusOf(taskId)).toBe("spec");
  });

  it("task_finish request_changes never targets a stored edge into backlog", async () => {
    const projectId = await seedProject(legacyDefinition);
    const taskId = await seedTask(projectId, {
      status: "review",
      claimedByAgentId: agentTokenId,
      claimedAt: new Date(),
      reviewClaimedByAgentId: reviewerTokenId,
      reviewClaimedAt: new Date(),
      branchName: "b",
      prUrl: "https://github.com/acme/repo/pull/1",
      prNumber: 1,
    });

    const res = await post(reviewer, `/tasks/${taskId}/finish`, { outcome: "request_changes", result: "needs work" });

    expect(res.status).toBe(200);
    expect(await statusOf(taskId)).not.toBe("backlog");
    expect(await statusOf(taskId)).toBe("implement");
  });

  it("an admin restore (PATCH abandoned -> backlog) is refused for a legacy initialState of backlog", async () => {
    const projectId = await seedProject(legacyDefinition);
    const taskId = await seedTask(projectId, { status: "abandoned" });

    const res = await patchStatus(human, taskId, "backlog");

    expect(res.status).toBe(400);
    expect(await statusOf(taskId)).toBe("abandoned");
  });

  it("the restore target of an abandoned task is open, not the stored backlog", async () => {
    const projectId = await seedProject(legacyDefinition);
    const taskId = await seedTask(projectId, { status: "abandoned" });

    const res = await patchStatus(human, taskId, "open");

    expect(res.status).toBe(200);
    expect(await statusOf(taskId)).toBe("open");
  });
});

describe("controls: valid workflows and the three human verbs", () => {
  it("with no stored workflow, /abandon and /release reset to open and /transition follows the default edges", async () => {
    const projectId = await seedProject(null);
    const abandoned = await seedTask(projectId, { status: "in_progress", claimedByAgentId: agentTokenId, claimedAt: new Date() });
    const released = await seedTask(projectId, { status: "in_progress", claimedByAgentId: agentTokenId, claimedAt: new Date() });
    const moved = await seedTask(projectId, { status: "open" });

    expect((await post(agent, `/tasks/${abandoned}/abandon`)).status).toBe(200);
    expect((await post(agent, `/tasks/${released}/release`)).status).toBe(200);
    expect((await post(human, `/tasks/${moved}/transition`, { status: "in_progress" })).status).toBe(200);

    expect(await statusOf(abandoned)).toBe("open");
    expect(await statusOf(released)).toBe("open");
    expect(await statusOf(moved)).toBe("in_progress");
  });

  it("a valid stored custom workflow is used exactly as stored", async () => {
    const projectId = await seedProject({
      initialState: "open",
      states: [
        { name: "open", label: "Open", terminal: false },
        { name: "in_progress", label: "In progress", terminal: false },
        { name: "review", label: "Review", terminal: false },
        { name: "done", label: "Done", terminal: true },
      ],
      transitions: [
        { from: "open", to: "in_progress" },
        { from: "in_progress", to: "done" },
      ],
    });
    const allowed = await seedTask(projectId, { status: "open" });
    const refused = await seedTask(projectId, { status: "open" });

    expect((await post(human, `/tasks/${allowed}/transition`, { status: "in_progress" })).status).toBe(200);
    expect((await post(human, `/tasks/${refused}/transition`, { status: "review" })).status).toBe(400);
    expect(await statusOf(allowed)).toBe("in_progress");
    expect(await statusOf(refused)).toBe("open");
  });

  it("the human verbs still work on a project that stores a legacy definition: promote, demote, discard", async () => {
    const projectId = await seedProject(legacyDefinition);
    const promoted = await seedTask(projectId, { status: "backlog" });
    const demoted = await seedTask(projectId, { status: "open" });
    const discarded = await seedTask(projectId, { status: "backlog" });

    expect((await patchStatus(human, promoted, "open")).status).toBe(200);
    expect((await patchStatus(human, demoted, "backlog")).status).toBe(200);
    expect((await patchStatus(human, discarded, "abandoned")).status).toBe(200);

    expect(await statusOf(promoted)).toBe("open");
    expect(await statusOf(demoted)).toBe("backlog");
    expect(await statusOf(discarded)).toBe("abandoned");
  });
});
