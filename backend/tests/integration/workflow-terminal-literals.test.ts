/**
 * DB-backed tests for the engine paths that used to compare a task's status
 * with the literals `review` and `done`: signal staleness and the dependency
 * gate (pickup, task_start, claim), the merge and finish paths, the legacy
 * review routes, the status transitions, the next-action hints, the team
 * counters and the project member removal. Every one now reads the review
 * and terminal states of the task's own workflow.
 *
 * The workflows use state names other than review/done: `qa` is the
 * review-like state and `shipped` the terminal one. A second workflow reuses
 * the name `done` as a plain work state, so one name is terminal in the
 * built-in workflow and not in another.
 *
 * The webhook half of the file pins that every webhook-written terminal state
 * clears the work claim and the review claim, and that an agent whose task a
 * webhook closed can claim new work under a workflow that has no `done`.
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
  resolveTeamId: vi.fn().mockResolvedValue({ ok: true, teamId: "team-1" }),
  resolveTeamIdErrorBody: vi.fn(),
}));
vi.mock("../../src/services/team-access.js", () => accessMocks);

const audit = vi.hoisted(() => ({ logAuditEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/audit.js")>()),
  logAuditEvent: audit.logAuditEvent,
}));
const signals = vi.hoisted(() => ({
  emitReviewSignal: vi.fn().mockResolvedValue(undefined),
  emitChangesRequestedSignal: vi.fn().mockResolvedValue(undefined),
  emitTaskApprovedSignal: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/review-signal.js", () => signals);
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
const github = vi.hoisted(() => ({ performPrMerge: vi.fn() }));
vi.mock("../../src/services/github-merge.js", () => ({ performPrMerge: github.performPrMerge }));
vi.mock("../../src/services/github-delegation.js", () => ({
  findDelegationUser: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../src/services/board-default.js", () => ({
  ensureDefaultBoardForProject: vi.fn().mockResolvedValue(undefined),
}));
// The prMerged post-check after a merge passes unless a test makes it fail.
const postCheck = vi.hoisted(() => ({ prMergedFails: false }));
vi.mock("../../src/services/transition-rules.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/services/transition-rules.js")>();
  return {
    ...original,
    evaluateTransitionRules: (...args: Parameters<typeof original.evaluateTransitionRules>) => {
      const [rules] = args;
      if (rules?.length === 1 && rules[0] === "prMerged") {
        return Promise.resolve({ failed: postCheck.prMergedFails ? ["prMerged"] : [], unknown: [], errors: {} });
      }
      return original.evaluateTransitionRules(...args);
    },
  };
});

import { taskRouter } from "../../src/routes/tasks.js";
import { githubRouter } from "../../src/routes/github.js";
import { projectInviteAdminRouter } from "../../src/routes/invites.js";
import { handleIssuesEvent, handlePullRequestEvent } from "../../src/services/github-webhook.js";
import { GroundingAccessError, isInReviewState, resolveTaskMergeTarget, type GroundingTask } from "../../src/services/grounding-context.js";
import { resolveDirectGroundingTarget } from "../../src/services/grounding-direct-context.js";

/**
 * open -> build -> qa -> shipped. `qa` is review-like (it leads to the terminal
 * `shipped` and is no direct target of the initial state); `build` also has an
 * edge to `shipped` (the autoMerge edge) but is a direct target of `open`.
 */
const QA_DEFINITION: WorkflowDefinitionShape = {
  initialState: "open",
  states: [
    { name: "open", label: "Open", terminal: false },
    { name: "build", label: "Build", terminal: false },
    { name: "qa", label: "QA", terminal: false },
    { name: "shipped", label: "Shipped", terminal: true },
  ],
  transitions: [
    { from: "open", to: "build" },
    { from: "build", to: "qa", requires: ["branchPresent", "prPresent"] },
    { from: "build", to: "shipped", requires: ["branchPresent", "prPresent", "prMerged"] },
    { from: "qa", to: "shipped", requires: ["prMerged"] },
    { from: "qa", to: "build" },
  ],
};

/** `done` is a plain work state here; the terminal state is `shipped`. */
const DONE_IS_WORK_DEFINITION: WorkflowDefinitionShape = {
  initialState: "open",
  states: [
    { name: "open", label: "Open", terminal: false },
    { name: "build", label: "Build", terminal: false },
    { name: "done", label: "Done", terminal: false },
    { name: "shipped", label: "Shipped", terminal: true },
  ],
  transitions: [
    { from: "open", to: "build" },
    { from: "build", to: "done" },
    { from: "done", to: "shipped" },
  ],
};

/**
 * The four built-in names with free edges, accepted by the workflow API (the
 * PATCH route still takes only those names): `in_progress` is the review-like
 * state, `review` is a direct target of the initial state.
 */
const IN_PROGRESS_IS_REVIEW_DEFINITION: WorkflowDefinitionShape = {
  initialState: "open",
  states: [
    { name: "open", label: "Open", terminal: false },
    { name: "in_progress", label: "In progress", terminal: false },
    { name: "review", label: "In review", terminal: false },
    { name: "done", label: "Done", terminal: true },
  ],
  transitions: [
    { from: "open", to: "review" },
    { from: "review", to: "in_progress" },
    { from: "in_progress", to: "done" },
    { from: "in_progress", to: "review" },
  ],
};

const PR_FIELDS = { branchName: "feat/x", prUrl: "https://github.com/acme/thing/pull/1", prNumber: 1 };
const JSON_HEADERS = { "content-type": "application/json" };
const NO_CLAIMS = {
  claimedByUserId: null,
  claimedByAgentId: null,
  claimedAt: null,
  reviewClaimedByUserId: null,
  reviewClaimedByAgentId: null,
  reviewClaimedAt: null,
};

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
let teamId: string;
let projectId: string;
let workflowId: string;
let authorId: string;
let reviewerId: string;
let adminId: string;
let author: Actor;
let reviewer: Actor;
let admin: Actor;

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
const send = (actor: Actor, method: string, path: string, body?: Record<string, unknown>) =>
  makeApp(actor).request(path, { method, headers: JSON_HEADERS, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const post = (actor: Actor, path: string, body: Record<string, unknown> = {}) => send(actor, "POST", path, body);

async function seedUser() {
  const id = randomUUID();
  await db.user.create({ data: { id, login: `u-${id}` } });
  return id;
}

async function seedProject(overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  await db.project.create({
    data: { id, teamId, name: `P-${id.slice(0, 8)}`, slug: randomUUID(), githubRepo: "acme/thing", ...overrides },
  });
  return id;
}

async function seedWorkflow(project: string, definition: WorkflowDefinitionShape, isDefault = false) {
  const id = randomUUID();
  await db.workflow.create({ data: { id, projectId: project, name: `W-${id.slice(0, 8)}`, definition: definition as never, isDefault } });
  return id;
}

async function seedTask(overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  await db.task.create({
    data: {
      id,
      projectId,
      workflowId,
      title: `Task ${id.slice(0, 8)}`,
      description: "A task for the terminal-literal tests.",
      status: "open",
      createdByUserId: adminId,
      ...overrides,
    },
  });
  return id;
}

async function seedAgent(scopes: string[] = ["tasks:read", "tasks:claim", "tasks:transition", "tasks:update", "github:pr_merge"]) {
  const tokenId = randomUUID();
  await db.agentToken.create({
    data: { id: tokenId, teamId, createdById: adminId, name: `agent-${tokenId.slice(0, 8)}`, tokenHash: tokenId, scopes },
  });
  return { type: "agent", tokenId, teamId, userId: adminId, scopes } as Actor & { type: "agent" };
}

const distinctReviewerProject = () =>
  db.project.update({ where: { id: projectId }, data: { governanceMode: "REQUIRES_DISTINCT_REVIEWER", requireDistinctReviewer: true, soloMode: false } });
const autonomousProject = () =>
  db.project.update({ where: { id: projectId }, data: { governanceMode: "AUTONOMOUS", requireDistinctReviewer: false, soloMode: true } });

/** A task in `qa`: the author holds the work claim, the reviewer the review lock. */
const seedQaTask = (overrides: Record<string, unknown> = {}) =>
  seedTask({
    status: "qa",
    claimedByUserId: authorId,
    claimedAt: new Date(),
    reviewClaimedByUserId: reviewerId,
    reviewClaimedAt: new Date(),
    ...PR_FIELDS,
    ...overrides,
  });

const row = (id: string) => db.task.findUniqueOrThrow({ where: { id } });
const auditCalls = (action: string) =>
  audit.logAuditEvent.mock.calls.map(([event]) => event as { action: string; payload: Record<string, unknown> }).filter((e) => e.action === action);

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
  postCheck.prMergedFails = false;
  github.performPrMerge.mockResolvedValue({ ok: true, sha: "deadbeef", alreadyMerged: false });
  accessMocks.hasProjectAccess.mockResolvedValue(true);
  accessMocks.hasProjectRole.mockResolvedValue(true);
  accessMocks.isProjectAdmin.mockResolvedValue(true);
  accessMocks.requireProjectWrite.mockResolvedValue(true);

  authorId = await seedUser();
  reviewerId = await seedUser();
  adminId = await seedUser();
  teamId = randomUUID();
  await db.team.create({ data: { id: teamId, name: "Terminal literals", slug: randomUUID() } });
  for (const [userId, role] of [[authorId, "HUMAN_MEMBER"], [reviewerId, "HUMAN_MEMBER"], [adminId, "ADMIN"]] as const) {
    await db.teamMember.create({ data: { teamId, userId, role } });
  }
  accessMocks.resolveTeamId.mockResolvedValue({ ok: true, teamId });
  projectId = await seedProject();
  workflowId = await seedWorkflow(projectId, QA_DEFINITION);
  author = { type: "human", userId: authorId, teamId };
  reviewer = { type: "human", userId: reviewerId, teamId };
  admin = { type: "human", userId: adminId, teamId };
  await distinctReviewerProject();
});

// ---------------------------------------------------------------------------
// Pickup: signal staleness and the dependency gate.
// ---------------------------------------------------------------------------

describe("pickup: signal staleness follows the task's workflow", () => {
  async function seedSignal(taskId: string, project: string, recipient: Actor & { type: "agent" }, type: string, createdAt: Date) {
    return (
      await db.signal.create({
        data: { type, taskId, projectId: project, recipientAgentId: recipient.tokenId, context: {}, createdAt },
      })
    ).id;
  }
  const pickup = (actor: Actor) => post(actor, "/tasks/pickup");

  it("drops a review_needed signal for a task in the workflow's terminal state and delivers the one for a review-like state", async () => {
    const worker = await seedAgent();
    const shipped = await seedTask({ status: "shipped" });
    const qa = await seedTask({ status: "qa" });
    await seedSignal(shipped, projectId, worker, "review_needed", new Date(1000));
    const wanted = await seedSignal(qa, projectId, worker, "review_needed", new Date(2000));

    const body = await (await pickup(worker)).json();
    expect(body.kind).toBe("signal");
    expect(body.signal.id).toBe(wanted);
  });

  it("delivers an outcome notification for a task in the terminal state", async () => {
    const worker = await seedAgent();
    const shipped = await seedTask({ status: "shipped" });
    const approved = await seedSignal(shipped, projectId, worker, "task_approved", new Date(1000));

    const body = await (await pickup(worker)).json();
    expect(body.kind).toBe("signal");
    expect(body.signal.id).toBe(approved);
  });

  it("judges a state name by each task's own workflow: `done` is terminal in the built-in workflow and a work state in another", async () => {
    const worker = await seedAgent();
    const builtinProject = await seedProject();
    const workProject = await seedProject();
    const workWf = await seedWorkflow(workProject, DONE_IS_WORK_DEFINITION);
    const builtinDone = await seedTask({ projectId: builtinProject, workflowId: null, status: "done" });
    const workDone = await seedTask({ projectId: workProject, workflowId: workWf, status: "done" });
    await seedSignal(builtinDone, builtinProject, worker, "review_needed", new Date(1000));
    const wanted = await seedSignal(workDone, workProject, worker, "review_needed", new Date(2000));

    const body = await (await pickup(worker)).json();
    expect(body.kind).toBe("signal");
    expect(body.signal.id).toBe(wanted);
  });
});

describe("the dependency gate follows the blocker's workflow", () => {
  async function blockedBy(blockerStatus: string, blockerOverrides: Record<string, unknown> = {}) {
    const blocker = await seedTask({ status: blockerStatus, ...blockerOverrides });
    const dependent = await seedTask();
    await db.task.update({ where: { id: dependent }, data: { blockedBy: { connect: { id: blocker } } } });
    return { blocker, dependent };
  }

  describe("task_pickup", () => {
    it("offers a task whose blocker is in the workflow's terminal state, or abandoned", async () => {
      const worker = await seedAgent();
      const { dependent } = await blockedBy("shipped");
      const body = await (await post(worker, "/tasks/pickup")).json();
      expect(body.kind).toBe("work");
      expect(body.task.id).toBe(dependent);

      const second = await seedAgent();
      const abandoned = await blockedBy("abandoned");
      const taken = await (await post(second, "/tasks/pickup")).json();
      expect(taken.task.id).not.toBe(abandoned.blocker);
    });

    it("holds a task back while its blocker is in a work state", async () => {
      const worker = await seedAgent();
      await blockedBy("build");
      expect(await (await post(worker, "/tasks/pickup")).json()).toMatchObject({ kind: "idle" });
    });

    it("does not read a blocker in a state named `done` as resolved when that state is no terminal state of its workflow", async () => {
      const worker = await seedAgent();
      const workProject = await seedProject();
      const workWf = await seedWorkflow(workProject, DONE_IS_WORK_DEFINITION);
      const blocker = await seedTask({ projectId: workProject, workflowId: workWf, status: "done" });
      const dependent = await seedTask({ projectId: workProject, workflowId: workWf });
      await db.task.update({ where: { id: dependent }, data: { blockedBy: { connect: { id: blocker } } } });
      expect(await (await post(worker, "/tasks/pickup")).json()).toMatchObject({ kind: "idle" });

      await db.task.update({ where: { id: blocker }, data: { status: "shipped" } });
      expect((await (await post(worker, "/tasks/pickup")).json()).task.id).toBe(dependent);
    });

    it("applies the same rule to the review pool", async () => {
      const worker = await seedAgent();
      const blocker = await seedTask({ status: "build" });
      const otherAgent = await seedAgent();
      const reviewTask = await seedTask({ status: "qa", createdByAgentId: otherAgent.tokenId });
      await db.task.update({ where: { id: reviewTask }, data: { blockedBy: { connect: { id: blocker } } } });
      expect(await (await post(worker, "/tasks/pickup")).json()).toMatchObject({ kind: "idle" });

      await db.task.update({ where: { id: blocker }, data: { status: "shipped" } });
      const body = await (await post(worker, "/tasks/pickup")).json();
      expect(body.kind).toBe("review");
      expect(body.task.id).toBe(reviewTask);
    });
  });

  for (const [name, path] of [["task_start", "start"], ["claim", "claim"]] as const) {
    describe(name, () => {
      it("is refused while a blocker is in a work state and answers with the blocker", async () => {
        const worker = await seedAgent();
        const { blocker, dependent } = await blockedBy("build");
        const res = await post(worker, `/tasks/${dependent}/${path}`);
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({
          error: "blocked",
          message: "Task is blocked by unresolved dependencies",
          blockedBy: [{ id: blocker, title: expect.any(String), status: "build" }],
        });
      });

      it("goes ahead once the blocker is in the workflow's terminal state", async () => {
        const worker = await seedAgent();
        const { dependent } = await blockedBy("shipped");
        const res = await post(worker, `/tasks/${dependent}/${path}`);
        expect(res.status).toBe(200);
        expect((await row(dependent)).claimedByAgentId).toBe(worker.tokenId);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// task_merge
// ---------------------------------------------------------------------------

describe("POST /tasks/:id/merge on a custom vocabulary", () => {
  it("merges a task in the review-like state and writes the workflow's terminal state, clearing both claims", async () => {
    const taskId = await seedQaTask();
    const res = await post(reviewer, `/tasks/${taskId}/merge`);
    expect(res.status).toBe(200);
    expect(await row(taskId)).toMatchObject({ status: "shipped", autoMergeSha: "deadbeef", ...NO_CLAIMS });
  });

  it("keeps the terminal state of an already finished task on the idempotent retry", async () => {
    const taskId = await seedTask({ status: "shipped", ...PR_FIELDS });
    const res = await post(reviewer, `/tasks/${taskId}/merge`);
    expect(res.status).toBe(200);
    expect((await row(taskId)).status).toBe("shipped");
  });

  it("holds a task in the review-like state to the distinct-reviewer gate", async () => {
    const taskId = await seedQaTask({ reviewClaimedByUserId: null, reviewClaimedAt: null });
    const res = await post(reviewer, `/tasks/${taskId}/merge`);
    expect(res.status).toBe(403);
    expect(github.performPrMerge).not.toHaveBeenCalled();
    expect((await row(taskId)).status).toBe("qa");
  });

  it("refuses a state of the workflow that is neither review-like nor terminal and names the review state", async () => {
    const taskId = await seedTask({ status: "build", ...PR_FIELDS });
    const res = await post(reviewer, `/tasks/${taskId}/merge`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "bad_state",
      message: "Cannot merge: task is in 'build', expected 'qa'. Transition the task to 'qa' first.",
    });
    expect(auditCalls("task.merge_rejected_bad_status")[0]!.payload).not.toHaveProperty("unknown");
    expect(github.performPrMerge).not.toHaveBeenCalled();
  });

  it("refuses a literal `review` the workflow does not have as an unknown status", async () => {
    const taskId = await seedTask({ status: "review", ...PR_FIELDS });
    const res = await post(reviewer, `/tasks/${taskId}/merge`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "bad_state", message: "Cannot merge: task is in 'review'." });
    expect(auditCalls("task.merge_rejected_bad_status")[0]!.payload).toMatchObject({ unknown: true });
  });
});

describe("POST /github/pull-requests/:n/merge on a custom vocabulary", () => {
  const merge = (actor: Actor, taskId: string) =>
    makeApp(actor, githubRouter).request("/pull-requests/1/merge", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ taskId, owner: "acme", repo: "thing" }),
    });

  it("writes the terminal state of the workflow and clears the work claim and the review claim", async () => {
    const agent = await seedAgent();
    const taskId = await seedQaTask({ reviewClaimedByUserId: null, reviewClaimedByAgentId: agent.tokenId });
    const res = await merge(agent, taskId);
    expect(res.status).toBe(200);
    expect(await row(taskId)).toMatchObject({ status: "shipped", ...NO_CLAIMS });
  });

  it("names the review state of the workflow in the refusal of a state that is neither review-like nor terminal", async () => {
    const agent = await seedAgent();
    const taskId = await seedTask({ status: "build", ...PR_FIELDS });
    const res = await merge(agent, taskId);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toContain("expected 'qa'");
    expect(auditCalls("task.merge_rejected_bad_status")[0]!.payload).not.toHaveProperty("unknown");
  });
});

// ---------------------------------------------------------------------------
// task_finish
// ---------------------------------------------------------------------------

describe("POST /tasks/:id/finish on a custom vocabulary", () => {
  it("review approve moves a `qa` task to the terminal state and audits the state it came from", async () => {
    const taskId = await seedQaTask();
    const res = await post(reviewer, `/tasks/${taskId}/finish`, { outcome: "approve" });
    expect(res.status).toBe(200);
    expect(await row(taskId)).toMatchObject({ status: "shipped", ...NO_CLAIMS });
    expect(auditCalls("task.reviewed")[0]!.payload).toMatchObject({ from: "qa", to: "shipped", via: "task_finish" });
  });

  describe("autoMerge after a review approve (Mode B)", () => {
    it("fails the prMerged post-check of the qa -> shipped edge", async () => {
      const taskId = await seedQaTask();
      postCheck.prMergedFails = true;
      const res = await post(reviewer, `/tasks/${taskId}/finish`, { outcome: "approve", autoMerge: true });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { message: string }).message).toContain("post-check failed");
    });

    it("merges and moves the task to the terminal state", async () => {
      const taskId = await seedQaTask();
      const res = await post(reviewer, `/tasks/${taskId}/finish`, { outcome: "approve", autoMerge: true });
      expect(res.status).toBe(200);
      expect(await row(taskId)).toMatchObject({ status: "shipped", autoMergeSha: "deadbeef", ...NO_CLAIMS });
    });
  });

  describe("autoMerge from the work claim (Mode A)", () => {
    const seedBuild = (overrides: Record<string, unknown> = {}) =>
      seedTask({ status: "build", claimedByUserId: authorId, claimedAt: new Date(), ...PR_FIELDS, ...overrides });

    it("targets the terminal state the workflow reaches from the current one, not the literal `done`", async () => {
      await autonomousProject();
      const taskId = await seedBuild();
      const res = await post(author, `/tasks/${taskId}/finish`, { autoMerge: true });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ kind: "work", targetStatus: "shipped", autoMergeSha: "deadbeef" });
      expect(await row(taskId)).toMatchObject({ status: "shipped", ...NO_CLAIMS });
    });

    it("fails the prMerged post-check of the edge it merged over", async () => {
      await autonomousProject();
      const taskId = await seedBuild();
      postCheck.prMergedFails = true;
      const res = await post(author, `/tasks/${taskId}/finish`, { autoMerge: true });
      expect(res.status).toBe(502);
    });

    it("answers a replay on a finished task with the terminal state it is in", async () => {
      await autonomousProject();
      const taskId = await seedBuild({ status: "shipped", autoMergeSha: "already-merged" });
      const res = await post(author, `/tasks/${taskId}/finish`, { autoMerge: true });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ kind: "work", targetStatus: "shipped", autoMergeSha: "already-merged" });
      expect(github.performPrMerge).not.toHaveBeenCalled();
    });

    it("completes a merge whose status write never landed: terminal state, both claims cleared, audit from the state it was in", async () => {
      await autonomousProject();
      const taskId = await seedBuild({
        autoMergeSha: "merged-earlier",
        reviewClaimedByUserId: reviewerId,
        reviewClaimedAt: new Date(),
      });
      const res = await post(author, `/tasks/${taskId}/finish`, { autoMerge: true });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ kind: "work", targetStatus: "shipped", autoMergeSha: "merged-earlier" });
      expect(await row(taskId)).toMatchObject({ status: "shipped", ...NO_CLAIMS });
      expect(github.performPrMerge).not.toHaveBeenCalled();
      expect(auditCalls("task.transitioned")[0]!.payload).toMatchObject({ from: "build", to: "shipped", recovery: true });
    });
  });
});

// ---------------------------------------------------------------------------
// The legacy review routes
// ---------------------------------------------------------------------------

describe("POST /tasks/:id/review on a custom vocabulary", () => {
  it("approve moves a `qa` task to the workflow's terminal state and audits the state it came from", async () => {
    const taskId = await seedQaTask();
    const res = await post(reviewer, `/tasks/${taskId}/review`, { action: "approve" });
    expect(res.status).toBe(200);
    expect((await row(taskId)).status).toBe("shipped");
    expect(auditCalls("task.reviewed")[0]!.payload).toMatchObject({ reviewAction: "approve", from: "qa", to: "shipped" });
  });

  it("request_changes sends the task to the workflow's request-changes state", async () => {
    const taskId = await seedQaTask();
    const res = await post(reviewer, `/tasks/${taskId}/review`, { action: "request_changes" });
    expect(res.status).toBe(200);
    expect((await row(taskId)).status).toBe("build");
  });

  it("refuses a task that is not in a review-like state, a literal `review` included", async () => {
    const taskId = await seedTask({ status: "review", claimedByUserId: authorId, reviewClaimedByUserId: reviewerId });
    const res = await post(reviewer, `/tasks/${taskId}/review`, { action: "approve" });
    expect(res.status).toBe(400);
  });

  it("review/claim takes the review lock on a review-like state and refuses a literal `review`", async () => {
    const qa = await seedTask({ status: "qa", claimedByUserId: authorId, claimedAt: new Date() });
    expect((await post(reviewer, `/tasks/${qa}/review/claim`)).status).toBe(200);
    expect((await row(qa)).reviewClaimedByUserId).toBe(reviewerId);

    const literal = await seedTask({ status: "review", claimedByUserId: authorId, claimedAt: new Date() });
    expect((await post(reviewer, `/tasks/${literal}/review/claim`)).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Transitions: the distinct-reviewer gate and the review signal
// ---------------------------------------------------------------------------

describe("POST /tasks/:id/transition on a custom vocabulary", () => {
  it("holds qa -> shipped to the distinct-reviewer gate", async () => {
    const taskId = await seedQaTask({ reviewClaimedByUserId: null, reviewClaimedAt: null });
    const res = await post(author, `/tasks/${taskId}/transition`, { status: "shipped" });
    expect(res.status).toBe(403);
    expect((await row(taskId)).status).toBe("qa");
  });

  it("announces a task entering the review-like state to reviewers, and not one that stays in it", async () => {
    const taskId = await seedTask({ status: "build", claimedByUserId: authorId, claimedAt: new Date(), ...PR_FIELDS });
    const res = await post(author, `/tasks/${taskId}/transition`, { status: "qa" });
    expect(res.status).toBe(200);
    expect(signals.emitReviewSignal).toHaveBeenCalledTimes(1);
    expect(signals.emitReviewSignal).toHaveBeenCalledWith(taskId, projectId, authorId, null);
  });
});

describe("PATCH /tasks/:id on a workflow with the built-in names and free edges", () => {
  let freeWorkflow: string;
  beforeEach(async () => {
    freeWorkflow = await seedWorkflow(projectId, IN_PROGRESS_IS_REVIEW_DEFINITION);
  });
  const patch = (taskId: string, body: Record<string, unknown>) => send(admin, "PATCH", `/tasks/${taskId}`, body);

  it("holds in_progress -> done to the distinct-reviewer gate where in_progress is the review-like state", async () => {
    const taskId = await seedTask({ workflowId: freeWorkflow, status: "in_progress", claimedByUserId: adminId, claimedAt: new Date(), ...PR_FIELDS });
    const res = await patch(taskId, { status: "done" });
    expect(res.status).toBe(403);
    expect((await row(taskId)).status).toBe("in_progress");
  });

  it("announces a task entering the review-like state, whatever its name", async () => {
    const taskId = await seedTask({ workflowId: freeWorkflow, status: "review", claimedByUserId: authorId, claimedAt: new Date(), ...PR_FIELDS });
    const res = await patch(taskId, { status: "in_progress" });
    expect(res.status).toBe(200);
    expect(signals.emitReviewSignal).toHaveBeenCalledTimes(1);
  });

  it("does not announce a move into a state that is not review-like, the literal `review` included", async () => {
    const taskId = await seedTask({ workflowId: freeWorkflow, status: "in_progress", claimedByUserId: authorId, claimedAt: new Date(), ...PR_FIELDS });
    const res = await patch(taskId, { status: "review" });
    expect(res.status).toBe(200);
    expect(signals.emitReviewSignal).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Next-action hints, team counters, member removal
// ---------------------------------------------------------------------------

describe("GET /tasks/:id/instructions on a custom vocabulary", () => {
  it("offers review actions and the review hint to a reviewer of a task in the review-like state", async () => {
    const taskId = await seedQaTask({ reviewClaimedByUserId: null, reviewClaimedAt: null });
    const body = await (await send(reviewer, "GET", `/tasks/${taskId}/instructions`)).json();
    expect(body.reviewActions).toEqual(["approve", "request_changes"]);
    expect(body.recommendedAction).toMatch(/^Review the PR/);
    expect(body.agentInstructions).toMatch(/^Review is a code-review state/);
  });

  it("tells the author of such a task to wait for the review", async () => {
    const taskId = await seedQaTask({ reviewClaimedByUserId: null, reviewClaimedAt: null });
    const body = await (await send(author, "GET", `/tasks/${taskId}/instructions`)).json();
    expect(body.reviewActions).toEqual([]);
    expect(body.recommendedAction).toMatch(/^Wait for review/);
  });
});

describe("GET /teams/:teamId/tasks counters on a custom vocabulary", () => {
  it("counts the terminal states of each task's own workflow as done, and leaves finished tasks out of `mine`", async () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await seedTask({ status: "shipped", updatedAt: new Date() });
    await seedTask({ status: "shipped", updatedAt: old });
    await seedTask({ status: "build", claimedByUserId: adminId, claimedAt: new Date() });
    await seedTask({ status: "shipped", claimedByUserId: adminId, claimedAt: new Date() });
    // A literal `done` is no terminal state of this workflow.
    await seedTask({ status: "done" });

    const body = await (await send(admin, "GET", `/teams/${teamId}/tasks`)).json();
    expect(body.counts).toMatchObject({ done: 3, doneRecent: 2, doneOlder: 1, mine: 1 });
  });

  it("keeps `done` as the built-in terminal state for a project without workflow rows", async () => {
    const plain = await seedProject();
    await seedTask({ projectId: plain, workflowId: null, status: "done", claimedByUserId: adminId, claimedAt: new Date() });
    await seedTask({ projectId: plain, workflowId: null, status: "in_progress", claimedByUserId: adminId, claimedAt: new Date() });

    const body = await (await send(admin, "GET", `/teams/${teamId}/tasks?projectId=${plain}`)).json();
    expect(body.counts).toMatchObject({ done: 1, mine: 1 });
  });
});

describe("DELETE /projects/:id/members/:userId on a custom vocabulary", () => {
  it("releases the claims that are still active in the task's own workflow and leaves the finished ones", async () => {
    const memberId = await seedUser();
    await db.projectMember.create({ data: { projectId, userId: memberId, role: "PROJECT_CONTRIBUTOR", invitedById: adminId } });
    const working = await seedTask({ status: "build", claimedByUserId: memberId, claimedAt: new Date() });
    const finished = await seedTask({ status: "shipped", claimedByUserId: memberId, claimedAt: new Date() });
    const reviewing = await seedTask({ status: "qa", reviewClaimedByUserId: memberId, reviewClaimedAt: new Date() });
    const notReviewing = await seedTask({ status: "build", reviewClaimedByUserId: memberId, reviewClaimedAt: new Date() });

    const res = await makeApp(admin, projectInviteAdminRouter).request(`/projects/${projectId}/members/${memberId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await row(working)).toMatchObject({ claimedByUserId: null, claimedAt: null });
    expect(await row(reviewing)).toMatchObject({ reviewClaimedByUserId: null, reviewClaimedAt: null });
    expect((await row(finished)).claimedByUserId).toBe(memberId);
    expect((await row(notReviewing)).reviewClaimedByUserId).toBe(memberId);
  });
});

// ---------------------------------------------------------------------------
// Grounding: the review-state checks of the standalone merge and the direct review
// ---------------------------------------------------------------------------

describe("grounding policies on a custom vocabulary", () => {
  const authority = { canWrite: async () => true, hasRole: async () => true } as never;
  async function groundingTask(id: string): Promise<GroundingTask> {
    return db.task.findUniqueOrThrow({ where: { id }, include: { project: true } });
  }

  it("treats a task in the workflow's review-like state as in review, and one in another state as not", async () => {
    expect(await isInReviewState(db, await groundingTask(await seedQaTask()))).toBe(true);
    expect(await isInReviewState(db, await groundingTask(await seedTask({ status: "build" })))).toBe(false);
    expect(await isInReviewState(db, await groundingTask(await seedTask({ status: "review" })))).toBe(false);
  });

  it("resolves the standalone task merge from the review-like state to the terminal state", async () => {
    const { findDelegationUser } = await import("../../src/services/github-delegation.js");
    vi.mocked(findDelegationUser).mockResolvedValue({ userId: reviewerId, login: "delegate", githubAccessToken: "ghp_x" } as never);
    const task = await groundingTask(await seedQaTask());
    const resolved = await resolveTaskMergeTarget(db, task, reviewer, authority);
    expect(resolved.target).toMatchObject({ from: "qa", to: "shipped", action: "merge" });

    const build = await groundingTask(await seedTask({ status: "build", ...PR_FIELDS }));
    await expect(resolveTaskMergeTarget(db, build, reviewer, authority)).rejects.toMatchObject({ code: "bad_state" });
    expect(GroundingAccessError).toBeDefined();
  });

  it("resolves the direct review endpoint from the review-like state and refuses it from another", async () => {
    const qa = await groundingTask(await seedQaTask());
    const approved = await resolveDirectGroundingTarget(db, qa, reviewer, { version: 1, endpoint: "review", target: "shipped" }, authority);
    expect(approved).toMatchObject({ action: "approve", terminal: true, target: { from: "qa", to: "shipped" } });

    const build = await groundingTask(await seedTask({ status: "build" }));
    await expect(
      resolveDirectGroundingTarget(db, build, reviewer, { version: 1, endpoint: "review", target: "shipped" }, authority),
    ).rejects.toMatchObject({ code: "bad_state" });
  });
});

// ---------------------------------------------------------------------------
// Webhooks: terminal writes clear both claims, and the lockout is gone
// ---------------------------------------------------------------------------

describe("webhook-written terminal states clear the work claim and the review claim", () => {
  const repo = "acme/webhook-thing";
  const issuePayload = (number: number) => ({
    action: "closed" as const,
    issue: { number, title: "Issue", body: null, html_url: `https://github.com/${repo}/issues/${number}`, state: "closed" as const },
    repository: { full_name: repo },
  });
  const mergedPayload = (number: number) => ({
    action: "closed" as const,
    pull_request: {
      number,
      title: "PR",
      body: null,
      html_url: `https://github.com/${repo}/pull/${number}`,
      state: "closed" as const,
      merged: true,
      merged_by: { login: "octocat" },
    },
    repository: { full_name: repo },
  });
  let webhookProject: string;
  beforeEach(async () => {
    webhookProject = await seedProject({ githubRepo: repo, governanceMode: "AUTONOMOUS", soloMode: true, requireDistinctReviewer: false });
  });

  const heldClaims = (agent: string) => ({
    claimedByAgentId: agent,
    claimedAt: new Date(),
    reviewClaimedByUserId: reviewerId,
    reviewClaimedAt: new Date(),
  });

  it("issue closed: a built-in task ends in `done` without claims", async () => {
    const agent = await seedAgent();
    const taskId = await seedTask({ projectId: webhookProject, workflowId: null, status: "in_progress", title: "[GH #7] Something", ...heldClaims(agent.tokenId) });
    await handleIssuesEvent(issuePayload(7));
    expect(await row(taskId)).toMatchObject({ status: "done", ...NO_CLAIMS });
  });

  it("PR merged (autonomous): a task of a custom workflow ends in its terminal state without claims", async () => {
    const agent = await seedAgent();
    const wf = await seedWorkflow(webhookProject, QA_DEFINITION);
    const taskId = await seedTask({ projectId: webhookProject, workflowId: wf, status: "build", prNumber: 9, ...heldClaims(agent.tokenId) });
    await handlePullRequestEvent(mergedPayload(9));
    expect(await row(taskId)).toMatchObject({ status: "shipped", ...NO_CLAIMS });
  });

  it("PR merged (confirmation required): the hand-over to review keeps the work claim", async () => {
    const agent = await seedAgent();
    await db.project.update({ where: { id: webhookProject }, data: { governanceMode: "AWAITS_CONFIRMATION", soloMode: false } });
    const wf = await seedWorkflow(webhookProject, QA_DEFINITION);
    const taskId = await seedTask({ projectId: webhookProject, workflowId: wf, status: "build", prNumber: 10, claimedByAgentId: agent.tokenId, claimedAt: new Date() });
    await handlePullRequestEvent(mergedPayload(10));
    expect(await row(taskId)).toMatchObject({ status: "qa", claimedByAgentId: agent.tokenId });
  });

  it("an agent whose task a webhook closed claims new work after the project moved to a workflow without `done`", async () => {
    const agent = await seedAgent();
    const closed = await seedTask({ projectId: webhookProject, workflowId: null, status: "in_progress", title: "[GH #11] Old work", ...heldClaims(agent.tokenId) });
    await handleIssuesEvent(issuePayload(11));
    expect((await row(closed)).status).toBe("done");

    // The project switches to a workflow whose terminal state is `shipped`: a
    // `done` task is no longer terminal there, so a claim left on it would count.
    await seedWorkflow(webhookProject, QA_DEFINITION, true);
    const next = await seedTask({ projectId: webhookProject, workflowId: null, status: "open" });
    const res = await post(agent, "/tasks/pickup");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("work");
    expect(body.task.id).toBe(next);
  });

  it("without the cleared claim the same switch would lock the agent out (guard for the test above)", async () => {
    const agent = await seedAgent();
    await seedTask({ projectId: webhookProject, workflowId: null, status: "done", ...heldClaims(agent.tokenId) });
    await seedWorkflow(webhookProject, QA_DEFINITION, true);
    expect((await post(agent, "/tasks/pickup")).status).toBe(409);
  });
});
