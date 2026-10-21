/**
 * DB-backed tests for the status filters that follow each task's own
 * workflow: the review pickup and the single-active-claim check (task_pickup,
 * task_start, admin-reassign) in routes/tasks.ts, and the PR-binding and
 * issue-closed lookups in services/github-webhook.ts.
 *
 * The workflows use state names other than review/done: `qa` is the
 * review-like state and `shipped` the terminal one. A second workflow reuses
 * the name `done` as a plain open state (terminal is `shipped` there), so one
 * state name is terminal in the built-in workflow and non-terminal in
 * another, in projects of the same team and repository.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";
import type { WorkflowDefinitionShape } from "../../src/services/default-workflow.js";
import { groundingPostgres } from "../helpers/grounding-postgres.js";
import { CUSTOM_VOCABULARY_DEFINITION } from "../helpers/custom-vocabulary-workflow.js";

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
import { findTasksByPr, handleIssuesEvent } from "../../src/services/github-webhook.js";

/** open -> build -> done -> shipped: `done` is a review-like work state here, `shipped` is terminal. */
const DONE_IS_OPEN_DEFINITION: WorkflowDefinitionShape = {
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

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
let teamId: string;
let adminId: string;
let author: Actor; // creates the tasks the reviewer may pick up
let worker: Actor; // the agent under test

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

const pickup = (actor: Actor) => makeApp(actor).request("/tasks/pickup", { method: "POST" });
const start = (actor: Actor, taskId: string) => makeApp(actor).request(`/tasks/${taskId}/start`, { method: "POST" });
const reassign = (actor: Actor, taskId: string, body: Record<string, unknown>) =>
  makeApp(actor).request(`/tasks/${taskId}/admin-reassign`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function seedAgent(): Promise<Actor & { type: "agent" }> {
  const scopes = ["tasks:read", "tasks:claim", "tasks:transition"];
  const tokenId = randomUUID();
  await db.agentToken.create({
    data: { id: tokenId, teamId, createdById: adminId, name: `agent-${tokenId.slice(0, 8)}`, tokenHash: tokenId, scopes },
  });
  return { type: "agent", tokenId, teamId, userId: adminId, scopes };
}

async function seedProject(githubRepo: string | null = null) {
  const id = randomUUID();
  await db.project.create({
    data: { id, teamId, name: `P-${id.slice(0, 8)}`, slug: randomUUID(), githubRepo, governanceMode: null, requireDistinctReviewer: false, soloMode: false },
  });
  return id;
}

async function seedWorkflow(projectId: string, definition: WorkflowDefinitionShape, isDefault = false) {
  const id = randomUUID();
  await db.workflow.create({ data: { id, projectId, name: `W-${id.slice(0, 8)}`, definition: definition as never, isDefault } });
  return id;
}

async function seedTask(projectId: string, overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  await db.task.create({
    data: { id, projectId, title: `Task ${id.slice(0, 8)}`, description: "d", status: "open", createdByUserId: adminId, ...overrides },
  });
  return id;
}

const authoredBy = (a: Actor) => ({ createdByAgentId: a.type === "agent" ? a.tokenId : null });
const workedBy = (a: Actor) => ({ claimedByAgentId: a.type === "agent" ? a.tokenId : null, claimedAt: new Date() });
const reviewedBy = (a: Actor) => ({ reviewClaimedByAgentId: a.type === "agent" ? a.tokenId : null, reviewClaimedAt: new Date() });

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
  adminId = randomUUID();
  await db.user.create({ data: { id: adminId, login: `admin-${adminId}`, name: "admin" } });
  teamId = randomUUID();
  await db.team.create({ data: { id: teamId, name: "Filters", slug: randomUUID() } });
  await db.teamMember.create({ data: { teamId, userId: adminId, role: "ADMIN" } });
  author = await seedAgent();
  worker = await seedAgent();
});

describe("review pickup follows the task's workflow", () => {
  it("offers a task in the review-like state of a pinned custom workflow, not one in its terminal state or in a literal `review`", async () => {
    const project = await seedProject();
    const wf = await seedWorkflow(project, CUSTOM_VOCABULARY_DEFINITION);
    await seedTask(project, { status: "shipped", workflowId: wf, ...authoredBy(author) });
    await seedTask(project, { status: "review", workflowId: wf, ...authoredBy(author) });
    expect(await (await pickup(worker)).json()).toEqual({ kind: "idle" });

    const qa = await seedTask(project, { status: "qa", workflowId: wf, ...authoredBy(author) });
    const body = await (await pickup(worker)).json();
    expect(body.kind).toBe("review");
    expect(body.task.id).toBe(qa);
  });

  it("uses the project default workflow for an unpinned task", async () => {
    const project = await seedProject();
    await seedWorkflow(project, CUSTOM_VOCABULARY_DEFINITION, true);
    await seedTask(project, { status: "review", ...authoredBy(author) });
    expect(await (await pickup(worker)).json()).toEqual({ kind: "idle" });

    const qa = await seedTask(project, { status: "qa", ...authoredBy(author) });
    const body = await (await pickup(worker)).json();
    expect(body.kind).toBe("review");
    expect(body.task.id).toBe(qa);
  });

  it("keeps offering `review` for a project without any workflow row (built-in behaviour)", async () => {
    const project = await seedProject();
    const review = await seedTask(project, { status: "review", ...authoredBy(author) });
    await seedTask(project, { status: "done", ...authoredBy(author) });
    const body = await (await pickup(worker)).json();
    expect(body.kind).toBe("review");
    expect(body.task.id).toBe(review);
  });

  it("judges the same state name per project: `done` is review-like in one workflow and terminal in the built-in one", async () => {
    const builtinProject = await seedProject();
    const doneOpenProject = await seedProject();
    const wf = await seedWorkflow(doneOpenProject, DONE_IS_OPEN_DEFINITION);
    await seedTask(builtinProject, { status: "done", ...authoredBy(author) });
    expect(await (await pickup(worker)).json()).toEqual({ kind: "idle" });

    const doneOpen = await seedTask(doneOpenProject, { status: "done", workflowId: wf, ...authoredBy(author) });
    const body = await (await pickup(worker)).json();
    expect(body.kind).toBe("review");
    expect(body.task.id).toBe(doneOpen);
  });

  it("judges pinned tasks of different workflows by their own review-like state only", async () => {
    const project = await seedProject();
    const customWf = await seedWorkflow(project, CUSTOM_VOCABULARY_DEFINITION);
    const doneOpenWf = await seedWorkflow(project, DONE_IS_OPEN_DEFINITION);
    // `done` is no state of the custom workflow and `qa` none of the other.
    await seedTask(project, { status: "done", workflowId: customWf, ...authoredBy(author) });
    await seedTask(project, { status: "qa", workflowId: doneOpenWf, ...authoredBy(author) });
    expect(await (await pickup(worker)).json()).toEqual({ kind: "idle" });

    const doneOpen = await seedTask(project, { status: "done", workflowId: doneOpenWf, ...authoredBy(author) });
    const body = await (await pickup(worker)).json();
    expect(body.kind).toBe("review");
    expect(body.task.id).toBe(doneOpen);
  });

  it("does not let a pinned custom workflow in one project change the built-in review state of another", async () => {
    const customProject = await seedProject();
    await seedWorkflow(customProject, CUSTOM_VOCABULARY_DEFINITION);
    const builtinProject = await seedProject();
    const review = await seedTask(builtinProject, { status: "review", ...authoredBy(author) });
    const body = await (await pickup(worker)).json();
    expect(body.kind).toBe("review");
    expect(body.task.id).toBe(review);
  });
});

describe("single-active-claim check follows the task's workflow", () => {
  // Each site is called with the same claim in place; the task a site creates
  // for its own call is removed again so a successful start or reassign does
  // not leave the agent with a second claim.
  const workerId = () => (worker as { tokenId: string }).tokenId;
  const sites: Record<string, (project: string) => Response | Promise<Response>> = {
    pickup: () => pickup(worker),
    start: async (project) => {
      const target = await seedTask(project);
      const res = await start(worker, target);
      await db.task.delete({ where: { id: target } });
      return res;
    },
    reassign: async (project) => {
      const target = await seedTask(project, { status: "in_progress", claimedByUserId: adminId, claimedAt: new Date() });
      const res = await reassign({ type: "human", userId: adminId }, target, { claim: "work", target: { type: "agent", id: workerId() } });
      await db.task.delete({ where: { id: target } });
      return res;
    },
  };

  for (const [site, call] of Object.entries(sites)) {
    describe(site, () => {
      it("is not blocked by a work claim on a task in its workflow's terminal state, and is blocked by one in a work state", async () => {
        const project = await seedProject();
        const wf = await seedWorkflow(project, CUSTOM_VOCABULARY_DEFINITION);
        const claimed = await seedTask(project, { status: "shipped", workflowId: wf, ...workedBy(worker) });
        expect((await call(project)).status).toBe(200);

        await db.task.update({ where: { id: claimed }, data: { status: "build" } });
        const blocked = await call(project);
        expect(blocked.status).toBe(409);
        expect(await blocked.json()).toMatchObject({ error: "already_claimed", activeClaim: { taskId: claimed, role: "author" } });
      });

      it("is blocked by a review claim on a review-like state, and not by one on a literal `review` the workflow does not have", async () => {
        const project = await seedProject();
        const wf = await seedWorkflow(project, CUSTOM_VOCABULARY_DEFINITION);
        const claimed = await seedTask(project, { status: "review", workflowId: wf, ...reviewedBy(worker) });
        expect((await call(project)).status).toBe(200);

        await db.task.update({ where: { id: claimed }, data: { status: "qa" } });
        const blocked = await call(project);
        expect(blocked.status).toBe(409);
        expect(await blocked.json()).toMatchObject({ error: "already_claimed", activeClaim: { taskId: claimed, role: "reviewer" } });
      });

      it("judges a claimed `done` per workflow: a work claim on it blocks in a workflow where it is not terminal, not in the built-in one", async () => {
        const builtinProject = await seedProject();
        await seedTask(builtinProject, { status: "done", ...workedBy(worker) });
        expect((await call(builtinProject)).status).toBe(200);

        const doneOpenProject = await seedProject();
        const wf = await seedWorkflow(doneOpenProject, DONE_IS_OPEN_DEFINITION);
        const claimed = await seedTask(doneOpenProject, { status: "done", workflowId: wf, ...workedBy(worker) });
        const blocked = await call(builtinProject);
        expect(blocked.status).toBe(409);
        expect(await blocked.json()).toMatchObject({ activeClaim: { taskId: claimed, role: "author" } });
      });

      it("keeps the built-in behaviour: a claim on `done` frees the agent, a work claim on an in_progress task and a review claim on `review` block", async () => {
        const project = await seedProject();
        const done = await seedTask(project, { status: "done", ...workedBy(worker) });
        expect((await call(project)).status).toBe(200);

        await db.task.update({ where: { id: done }, data: { status: "in_progress" } });
        expect((await call(project)).status).toBe(409);

        await db.task.update({ where: { id: done }, data: { status: "review", claimedByAgentId: null, claimedAt: null, ...reviewedBy(worker) } });
        const blocked = await call(project);
        expect(blocked.status).toBe(409);
        expect(await blocked.json()).toMatchObject({ activeClaim: { role: "reviewer" } });
      });
    });
  }

  it("pickup still offers an open task as work once the only claim is on a terminal task of a custom workflow", async () => {
    const project = await seedProject();
    const wf = await seedWorkflow(project, CUSTOM_VOCABULARY_DEFINITION);
    await seedTask(project, { status: "shipped", workflowId: wf, ...workedBy(worker) });
    const open = await seedTask(project);
    const body = await (await pickup(worker)).json();
    expect(body.kind).toBe("work");
    expect(body.task.id).toBe(open);
  });
});

describe("webhook status filters follow the task's workflow", () => {
  const PR = 42;
  const PR_URL = "https://github.com/acme/filters/pull/42";
  const BRANCH = "feat/filters";

  /** Seeds one task per status for a binding and returns which ones the lookup may bind. */
  async function bindable(
    project: string,
    binding: Record<string, unknown>,
    statuses: string[],
    workflowId: string | null,
    hint: Parameters<typeof findTasksByPr>[1],
  ) {
    const byStatus = new Map<string, string>();
    for (const status of statuses) byStatus.set(status, await seedTask(project, { status, workflowId, ...binding }));
    const found = await findTasksByPr(project, hint);
    return { byStatus, foundIds: found.map((t) => t.id) };
  }

  const bindings: Array<[string, Record<string, unknown>, Parameters<typeof findTasksByPr>[1]]> = [
    ["prNumber", { prNumber: PR }, { prNumber: PR }],
    ["prUrl", { prUrl: PR_URL }, { prNumber: 999, prUrl: PR_URL }],
    ["branchName", { branchName: BRANCH }, { prNumber: 999, headBranch: BRANCH }],
    ["title pattern", { title: `[PR #${PR}] work` }, { prNumber: PR }],
  ];

  for (const [name, binding, hint] of bindings) {
    it(`binds by ${name} to tasks in a custom workflow's open states, not to its terminal state or backlog`, async () => {
      const project = await seedProject();
      const wf = await seedWorkflow(project, CUSTOM_VOCABULARY_DEFINITION);
      const { byStatus, foundIds } = await bindable(project, binding, ["build", "qa", "shipped", "backlog"], wf, hint);
      expect(foundIds.sort()).toEqual([byStatus.get("build")!, byStatus.get("qa")!].sort());
    });

    it(`binds by ${name} per workflow: \`done\` is bound where it is not terminal and skipped where it is`, async () => {
      const builtinProject = await seedProject();
      const builtin = await bindable(builtinProject, binding, ["done", "review"], null, hint);
      expect(builtin.foundIds).toEqual([builtin.byStatus.get("review")]);

      const doneOpenProject = await seedProject();
      const wf = await seedWorkflow(doneOpenProject, DONE_IS_OPEN_DEFINITION);
      const doneOpen = await bindable(doneOpenProject, binding, ["done", "shipped"], wf, hint);
      expect(doneOpen.foundIds).toEqual([doneOpen.byStatus.get("done")]);
    });
  }

  it("resolves an unpinned task through the project default workflow and mixes pinned and unpinned tasks of one project", async () => {
    const project = await seedProject();
    await seedWorkflow(project, CUSTOM_VOCABULARY_DEFINITION, true);
    const pinnedWf = await seedWorkflow(project, DONE_IS_OPEN_DEFINITION);
    const binding = { prNumber: PR };
    const unpinnedShipped = await seedTask(project, { status: "shipped", ...binding });
    const unpinnedDone = await seedTask(project, { status: "done", ...binding });
    const pinnedDone = await seedTask(project, { status: "done", workflowId: pinnedWf, ...binding });
    const pinnedShipped = await seedTask(project, { status: "shipped", workflowId: pinnedWf, ...binding });

    const ids = (await findTasksByPr(project, { prNumber: PR })).map((t) => t.id);
    expect(ids).toContain(unpinnedDone);
    expect(ids).toContain(pinnedDone);
    expect(ids).not.toContain(unpinnedShipped);
    expect(ids).not.toContain(pinnedShipped);
    expect(ids).toHaveLength(2);
  });

  it("judges pinned tasks of different workflows by their own terminal states only", async () => {
    const project = await seedProject();
    const customWf = await seedWorkflow(project, CUSTOM_VOCABULARY_DEFINITION);
    const closingWf = await seedWorkflow(project, {
      initialState: "open",
      states: [
        { name: "open", label: "Open", terminal: false },
        { name: "build", label: "Build", terminal: false },
        { name: "closed", label: "Closed", terminal: true },
        { name: "shipped", label: "Shipped", terminal: false },
      ],
      transitions: [
        { from: "open", to: "build" },
        { from: "build", to: "closed" },
        { from: "closed", to: "shipped" },
      ],
    });
    const binding = { prNumber: PR };
    const customShipped = await seedTask(project, { status: "shipped", workflowId: customWf, ...binding });
    const customClosed = await seedTask(project, { status: "closed", workflowId: customWf, ...binding });
    const closingShipped = await seedTask(project, { status: "shipped", workflowId: closingWf, ...binding });
    const closingClosed = await seedTask(project, { status: "closed", workflowId: closingWf, ...binding });

    const ids = (await findTasksByPr(project, { prNumber: PR })).map((t) => t.id);
    expect(ids.sort()).toEqual([customClosed, closingShipped].sort());
    expect(ids).not.toContain(customShipped);
    expect(ids).not.toContain(closingClosed);
  });

  it("closes issue-bound tasks by the workflow's own terminal state and leaves terminal and backlog tasks alone", async () => {
    const repo = `acme/${randomUUID()}`;
    const customProject = await seedProject(repo);
    const wf = await seedWorkflow(customProject, CUSTOM_VOCABULARY_DEFINITION);
    const title = "[GH #7] bug";
    const open = await seedTask(customProject, { title, status: "build", workflowId: wf });
    const review = await seedTask(customProject, { title, status: "qa", workflowId: wf });
    const shipped = await seedTask(customProject, { title, status: "shipped", workflowId: wf });
    const backlog = await seedTask(customProject, { title, status: "backlog", workflowId: wf });

    const builtinProject = await seedProject(repo);
    const builtinDone = await seedTask(builtinProject, { title, status: "done" });
    const builtinOpen = await seedTask(builtinProject, { title, status: "in_progress" });

    const doneOpenProject = await seedProject(repo);
    const doneOpenWf = await seedWorkflow(doneOpenProject, DONE_IS_OPEN_DEFINITION);
    const doneNotTerminal = await seedTask(doneOpenProject, { title, status: "done", workflowId: doneOpenWf });

    await handleIssuesEvent({
      action: "closed",
      issue: { number: 7, title: "bug", body: null },
      repository: { full_name: repo },
    } as never);

    const status = async (id: string) => (await db.task.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(open)).toBe("shipped");
    expect(await status(review)).toBe("shipped");
    expect(await status(shipped)).toBe("shipped");
    expect(await status(backlog)).toBe("backlog");
    expect(await status(builtinDone)).toBe("done");
    expect(await status(builtinOpen)).toBe("done");
    expect(await status(doneNotTerminal)).toBe("shipped");
  });
});
