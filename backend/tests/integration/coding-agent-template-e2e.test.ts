/**
 * End-to-end test of the registered `coding-agent` workflow template against a
 * real database: the template is listed, applied through the workflow API, and
 * a task then runs through its seven stages (open, spec, plan, implement, test,
 * review, done) with the real task, review, merge and webhook handlers.
 *
 * Pins how the engine behaves for the template's own state names: start moves
 * a task into `spec`, the gated edges answer 422 until the branch / PR exist,
 * a work-claim finish leaves `test` for `review` (and is refused from the
 * stages without an edge into `review`), review approve ends in `done`, request
 * changes returns to `implement`, the merge gate and the webhook hand-over use
 * `review` / `done`, and the retired `backlog` stage cannot be reached.
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
import { workflowRouter } from "../../src/routes/workflows.js";
import { handlePullRequestEvent } from "../../src/services/github-webhook.js";
import { checkTaskStatusForMerge } from "../../src/services/gates/task-status-for-merge.js";
import { findWorkflowTemplate } from "../../src/services/workflow-templates.js";

const SLUG = "coding-agent";
const STAGES = ["open", "spec", "plan", "implement", "test", "review", "done"];
const JSON_HEADERS = { "content-type": "application/json" };
const PR_FIELDS = { branchName: "feat/x", prUrl: "https://github.com/acme/thing/pull/1", prNumber: 1 };
const NO_CLAIMS = {
  claimedByUserId: null,
  claimedByAgentId: null,
  claimedAt: null,
  reviewClaimedByUserId: null,
  reviewClaimedByAgentId: null,
  reviewClaimedAt: null,
};

/* eslint-disable @typescript-eslint/no-explicit-any */
let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
let teamId: string;
let projectId: string;
let authorId: string;
let reviewerId: string;
let adminId: string;
let author: Actor;
let reviewer: Actor;
let admin: Actor;

function makeApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("groundingRemoteTargetGuard", null);
    await next();
  });
  app.route("/", taskRouter);
  app.route("/", githubRouter);
  app.route("/", workflowRouter);
  return app;
}
async function call(actor: Actor, method: string, path: string, body?: Record<string, unknown>) {
  const res = await makeApp(actor).request(path, {
    method,
    headers: JSON_HEADERS,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as any };
}
const post = (actor: Actor, path: string, body: Record<string, unknown> = {}) => call(actor, "POST", path, body);

async function seedUser() {
  const id = randomUUID();
  await db.user.create({ data: { id, login: `u-${id}` } });
  return id;
}

async function seedAgent() {
  const scopes = ["tasks:read", "tasks:claim", "tasks:transition", "tasks:update", "github:pr_merge"];
  const tokenId = randomUUID();
  await db.agentToken.create({
    data: { id: tokenId, teamId, createdById: adminId, name: `agent-${tokenId.slice(0, 8)}`, tokenHash: tokenId, scopes },
  });
  return { type: "agent", tokenId, teamId, userId: adminId, scopes } as Actor & { type: "agent" };
}

const row = (id: string) => db.task.findUniqueOrThrow({ where: { id } });
const auditCalls = (action: string) =>
  audit.logAuditEvent.mock.calls.map(([event]) => event as { action: string; payload: Record<string, unknown> }).filter((e) => e.action === action);

/** Creates a task through the API as the author and returns its id. */
async function createTask(): Promise<string> {
  const created = await post(author, `/projects/${projectId}/tasks`, { title: "Template task", description: "Runs through the pipeline." });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.id ?? created.body.task?.id;
}

/** Walks a started task along the given states with the transition verb, recording the PR first when asked. */
async function walk(taskId: string, ...states: string[]) {
  for (const status of states) {
    const moved = await post(author, `/tasks/${taskId}/transition`, { status });
    expect(moved.status, `-> ${status}: ${JSON.stringify(moved.body)}`).toBe(200);
  }
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
  await db.team.create({ data: { id: teamId, name: "Coding agent template", slug: randomUUID() } });
  for (const [userId, role] of [[authorId, "HUMAN_MEMBER"], [reviewerId, "HUMAN_MEMBER"], [adminId, "ADMIN"]] as const) {
    await db.teamMember.create({ data: { teamId, userId, role } });
  }
  accessMocks.resolveTeamId.mockResolvedValue({ ok: true, teamId });
  projectId = randomUUID();
  await db.project.create({
    data: {
      id: projectId, teamId, name: "P", slug: randomUUID(), githubRepo: "acme/thing",
      governanceMode: "REQUIRES_DISTINCT_REVIEWER", requireDistinctReviewer: true, soloMode: false,
    },
  });
  author = { type: "human", userId: authorId, teamId };
  reviewer = { type: "human", userId: reviewerId, teamId };
  admin = { type: "human", userId: adminId, teamId };
});

describe("the template endpoints", () => {
  it("lists the template with its seven stages and `open` as the initial state", async () => {
    const res = await call(admin, "GET", "/workflow-templates");
    expect(res.status).toBe(200);
    const listed = res.body.templates.find((t: { slug: string }) => t.slug === SLUG);
    expect(listed).toMatchObject({ slug: SLUG, name: "AI Coding Agent Pipeline", stateCount: 7, initialState: "open" });
  });

  it("applies cleanly: 201, the stored row is the template definition, and the project reads it back", async () => {
    const res = await post(admin, `/projects/${projectId}/workflow/apply-template/${SLUG}`);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.source).toBe("custom");
    const template = findWorkflowTemplate(SLUG)!;
    const stored = await db.workflow.findFirstOrThrow({ where: { projectId, isDefault: true } });
    expect(stored.definition).toEqual(JSON.parse(JSON.stringify(template.definition)));

    const effective = await call(admin, "GET", `/projects/${projectId}/effective-workflow`);
    expect(effective.status).toBe(200);
    expect(effective.body.source).toBe("custom");
    expect(effective.body.definition.states.map((s: { name: string }) => s.name)).toEqual(STAGES);
    expect(effective.body.definition.initialState).toBe("open");
  });

  it("an unknown slug still answers 404", async () => {
    const res = await post(admin, `/projects/${projectId}/workflow/apply-template/no-such-template`);
    expect(res.status).toBe(404);
  });
});

describe("a task through the applied template", () => {
  beforeEach(async () => {
    const applied = await post(admin, `/projects/${projectId}/workflow/apply-template/${SLUG}`);
    expect(applied.status).toBe(201);
  });

  it("create: a human-created task starts in the initial state `open`", async () => {
    const taskId = await createTask();
    expect((await row(taskId)).status).toBe("open");
  });

  it("start: moves an open task into `spec` and takes the work claim", async () => {
    const taskId = await createTask();
    const start = await post(author, `/tasks/${taskId}/start`);
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const after = await row(taskId);
    expect(after.status).toBe("spec");
    expect(after.claimedByUserId).toBe(authorId);
  });

  it("finish from `spec` is refused: only `test` has an edge into the review state", async () => {
    const taskId = await createTask();
    await post(author, `/tasks/${taskId}/start`);
    const refused = await post(author, `/tasks/${taskId}/finish`, { result: "done" });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/^Transition from 'spec' to 'review' is not allowed by workflow/);
    const after = await row(taskId);
    expect(after.status).toBe("spec");
    expect(after.claimedByUserId).toBe(authorId);
  });

  it("spec -> open releases the task back to the initial state; spec -> backlog does not exist", async () => {
    const taskId = await createTask();
    await post(author, `/tasks/${taskId}/start`);
    const toBacklog = await post(author, `/tasks/${taskId}/transition`, { status: "backlog" });
    expect(toBacklog.status).toBe(400);
    expect((await row(taskId)).status).toBe("spec");

    const released = await post(author, `/tasks/${taskId}/transition`, { status: "open" });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect((await row(taskId)).status).toBe("open");
  });

  it("plan -> implement answers 422 without a branch and passes once it is recorded", async () => {
    const taskId = await createTask();
    await post(author, `/tasks/${taskId}/start`);
    await walk(taskId, "plan");
    const blocked = await post(author, `/tasks/${taskId}/transition`, { status: "implement" });
    expect(blocked.status).toBe(422);
    expect(blocked.body.failed.map((f: { rule: string }) => f.rule)).toEqual(["branchPresent"]);
    expect((await row(taskId)).status).toBe("plan");

    await db.task.update({ where: { id: taskId }, data: { branchName: "feat/x" } });
    await walk(taskId, "implement");
    expect((await row(taskId)).status).toBe("implement");
  });

  it("finish from `test`: 422 until branch and PR exist, then moves the task to `review` and keeps the work claim", async () => {
    const taskId = await createTask();
    await post(author, `/tasks/${taskId}/start`);
    await db.task.update({ where: { id: taskId }, data: { branchName: "feat/x" } });
    await walk(taskId, "plan", "implement", "test");

    const blocked = await post(author, `/tasks/${taskId}/finish`, { result: "tests pass" });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error).toBe("precondition_failed");
    expect(blocked.body.failed.map((f: { rule: string }) => f.rule)).toEqual(["prPresent"]);
    expect((await row(taskId)).status).toBe("test");

    await db.task.update({ where: { id: taskId }, data: PR_FIELDS });
    const finished = await post(author, `/tasks/${taskId}/finish`, { result: "tests pass" });
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);
    expect(finished.body.targetStatus).toBe("review");
    const after = await row(taskId);
    expect(after.status).toBe("review");
    expect(after.claimedByUserId).toBe(authorId);
  });

  it("start previews the review state of the workflow; the transition verb also reaches it from `test` only with branch and PR", async () => {
    const taskId = await createTask();
    const start = await post(author, `/tasks/${taskId}/start`);
    expect(start.status).toBe(200);
    expect(start.body.expectedFinishState).toBe("review");

    await db.task.update({ where: { id: taskId }, data: { branchName: "feat/x" } });
    await walk(taskId, "plan", "implement", "test");
    const blocked = await post(author, `/tasks/${taskId}/transition`, { status: "review" });
    expect(blocked.status).toBe(422);
    expect(blocked.body.failed.map((f: { rule: string }) => f.rule)).toEqual(["prPresent"]);
  });

  async function seedReviewTask(overrides: Record<string, unknown> = {}) {
    const id = randomUUID();
    await db.task.create({
      data: {
        id, projectId, title: "In review", description: "Seeded.", status: "review", createdByUserId: adminId,
        claimedByUserId: authorId, claimedAt: new Date(), ...PR_FIELDS, ...overrides,
      },
    });
    return id;
  }

  describe("review", () => {
    it("the reviewer takes the review lock and approve ends the task in `done`, clearing both claims", async () => {
      const taskId = await seedReviewTask();
      const claimed = await post(reviewer, `/tasks/${taskId}/review/claim`);
      expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
      const approved = await post(reviewer, `/tasks/${taskId}/review`, { action: "approve" });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(await row(taskId)).toMatchObject({ status: "done", ...NO_CLAIMS });
      expect(auditCalls("task.reviewed").map((e) => e.payload)).toContainEqual(
        expect.objectContaining({ reviewAction: "approve", from: "review", to: "done" }),
      );
    });

    it("task_finish with outcome approve reaches `done` too", async () => {
      const taskId = await seedReviewTask({ reviewClaimedByUserId: reviewerId, reviewClaimedAt: new Date() });
      const res = await post(reviewer, `/tasks/${taskId}/finish`, { outcome: "approve" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await row(taskId)).toMatchObject({ status: "done", ...NO_CLAIMS });
      expect(auditCalls("task.reviewed").map((e) => e.payload)).toContainEqual(
        expect.objectContaining({ from: "review", to: "done", via: "task_finish" }),
      );
    });

    it("request changes sends the task back to `implement`", async () => {
      const taskId = await seedReviewTask({ reviewClaimedByUserId: reviewerId, reviewClaimedAt: new Date() });
      const res = await post(reviewer, `/tasks/${taskId}/review`, { action: "request_changes" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await row(taskId)).status).toBe("implement");
    });

    it("the distinct-reviewer gate holds: the author cannot approve their own review-state task", async () => {
      const taskId = await seedReviewTask({ reviewClaimedByUserId: authorId, reviewClaimedAt: new Date() });
      const res = await post(author, `/tasks/${taskId}/review`, { action: "approve" });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect((await row(taskId)).status).toBe("review");
    });
  });

  describe("merge gate", () => {
    it("POST /tasks/:id/merge merges a task in `review` and writes `done`", async () => {
      const taskId = await seedReviewTask({ reviewClaimedByUserId: reviewerId, reviewClaimedAt: new Date() });
      const res = await post(reviewer, `/tasks/${taskId}/merge`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await row(taskId)).toMatchObject({ status: "done", autoMergeSha: "deadbeef", ...NO_CLAIMS });
    });

    it.each(["open", "spec", "plan", "implement", "test"])("refuses a task still in `%s` and names `review`", async (status) => {
      const taskId = await seedReviewTask({ status });
      const res = await post(reviewer, `/tasks/${taskId}/merge`);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: "bad_state",
        message: `Cannot merge: task is in '${status}', expected 'review'. Transition the task to 'review' first.`,
      });
      expect(github.performPrMerge).not.toHaveBeenCalled();
      expect((await row(taskId)).status).toBe(status);
    });

    it("the status gate accepts exactly `review` and `done` among the template's states", () => {
      const definition = findWorkflowTemplate(SLUG)!.definition;
      const accepted = STAGES.filter((status) => checkTaskStatusForMerge({ status }, definition).ok);
      expect(accepted).toEqual(["review", "done"]);
    });

    it("POST /github/pull-requests/:n/merge merges a `review` task and writes `done`", async () => {
      const taskId = await seedReviewTask({ reviewClaimedByUserId: reviewerId, reviewClaimedAt: new Date() });
      const agent = await seedAgent();
      await db.task.update({ where: { id: taskId }, data: { reviewClaimedByUserId: null, reviewClaimedByAgentId: agent.tokenId } });
      const res = await call(agent, "POST", "/pull-requests/1/merge", { taskId, owner: "acme", repo: "thing" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await row(taskId)).toMatchObject({ status: "done", ...NO_CLAIMS });
    });
  });

  describe("webhook", () => {
    const mergedPayload = (number: number) => ({
      action: "closed" as const,
      pull_request: {
        number,
        title: "PR",
        body: null,
        html_url: `https://github.com/acme/thing/pull/${number}`,
        state: "closed" as const,
        merged: true,
        merged_by: { login: "octocat" },
      },
      repository: { full_name: "acme/thing" },
    });
    const withPr = (status: string, number: number) => {
      const id = randomUUID();
      return db.task
        .create({
          data: {
            id, projectId, title: "Webhook", description: "Seeded.", status, createdByUserId: adminId,
            claimedByUserId: authorId, claimedAt: new Date(), prNumber: number,
            prUrl: `https://github.com/acme/thing/pull/${number}`, branchName: "feat/x",
          },
        })
        .then(() => id);
    };

    it("PR merged (autonomous): a task in `implement` ends in `done` without claims", async () => {
      await db.project.update({ where: { id: projectId }, data: { governanceMode: "AUTONOMOUS", requireDistinctReviewer: false, soloMode: true } });
      const taskId = await withPr("implement", 21);
      await handlePullRequestEvent(mergedPayload(21));
      expect(await row(taskId)).toMatchObject({ status: "done", ...NO_CLAIMS });
    });

    it("PR merged (autonomous): a task already in `review` ends in `done` too", async () => {
      await db.project.update({ where: { id: projectId }, data: { governanceMode: "AUTONOMOUS", requireDistinctReviewer: false, soloMode: true } });
      const taskId = await withPr("review", 22);
      await handlePullRequestEvent(mergedPayload(22));
      expect(await row(taskId)).toMatchObject({ status: "done", ...NO_CLAIMS });
    });

    it("PR merged (confirmation required): a task in `test` is handed to `review` and keeps the work claim", async () => {
      await db.project.update({ where: { id: projectId }, data: { governanceMode: "AWAITS_CONFIRMATION", requireDistinctReviewer: false, soloMode: false } });
      const taskId = await withPr("test", 23);
      await handlePullRequestEvent(mergedPayload(23));
      expect(await row(taskId)).toMatchObject({ status: "review", claimedByUserId: authorId });
    });

    it("PR merged (confirmation required): a task already in `review` stays there", async () => {
      await db.project.update({ where: { id: projectId }, data: { governanceMode: "AWAITS_CONFIRMATION", requireDistinctReviewer: false, soloMode: false } });
      const taskId = await withPr("review", 24);
      await handlePullRequestEvent(mergedPayload(24));
      expect((await row(taskId)).status).toBe("review");
    });
  });
});
