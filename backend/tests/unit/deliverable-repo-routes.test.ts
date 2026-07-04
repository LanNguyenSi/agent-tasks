/**
 * Route-level tests for the cross-repo `deliverableRepo` override
 * (agent-tasks task cab4d048 / ADR-0010 §5c).
 *
 * Covers all five prUrl write paths (task_finish, submit_pr, PATCH
 * agent+human lanes, pull_requests_create), the create-time authoring
 * surface + validation, the human-project-admin-only PATCH authorization,
 * merge-automation refusal wiring across every performPrMerge caller, and
 * the ciGreen/prMerged v1 skip semantics.
 *
 * `performPrMerge` itself is MOCKED here — this file is about route wiring
 * (does the caller map a refusal to the right HTTP status, does the guard
 * fire before the write). The refusal logic itself is pinned directly in
 * github-merge-foreign-deliverable.test.ts.
 *
 * Per the project feedback memory: prefer `mockResolvedValue` /
 * `mockImplementation` over stacked `mockResolvedValueOnce` queues (not
 * drained by `vi.clearAllMocks`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const prismaMocks = vi.hoisted(() => ({
  taskFindUnique: vi.fn(),
  taskFindMany: vi.fn().mockResolvedValue([]),
  taskCreate: vi.fn(),
  taskUpdate: vi.fn(),
  projectFindUnique: vi.fn().mockResolvedValue({ confidenceThreshold: 0, taskTemplate: null }),
  workflowFindFirst: vi.fn().mockResolvedValue(null),
  agentTokenFindUnique: vi.fn().mockResolvedValue({ name: "Agent" }),
  userFindUnique: vi.fn().mockResolvedValue({ name: "Human" }),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: {
      findUnique: prismaMocks.taskFindUnique,
      findMany: prismaMocks.taskFindMany,
      findFirst: vi.fn(),
      create: prismaMocks.taskCreate,
      update: prismaMocks.taskUpdate,
    },
    project: { findUnique: prismaMocks.projectFindUnique },
    signal: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    workflow: { findFirst: prismaMocks.workflowFindFirst },
    agentToken: { findUnique: prismaMocks.agentTokenFindUnique },
    user: { findUnique: prismaMocks.userFindUnique },
  },
}));

const accessMocks = vi.hoisted(() => ({
  hasProjectAccess: vi.fn().mockResolvedValue(true),
  hasProjectRole: vi.fn().mockResolvedValue(true),
  isProjectAdmin: vi.fn().mockResolvedValue(true),
  requireProjectWrite: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../src/services/team-access.js", () => accessMocks);

const logAuditEventMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: logAuditEventMock,
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

const performPrMergeMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/github-merge.js", () => ({
  performPrMerge: performPrMergeMock,
}));

const findDelegationUserMock = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock("../../src/services/github-delegation.js", () => ({
  findDelegationUser: findDelegationUserMock,
}));

vi.mock("../../src/config/index.js", () => ({
  config: {
    NODE_ENV: "test",
    SESSION_SECRET: "test-session-secret-must-be-32chars!!",
    GITHUB_CLIENT_ID: "test-id",
    GITHUB_CLIENT_SECRET: "test-secret",
    FRONTEND_URL: "http://localhost:3000",
    CORS_ORIGINS: "http://localhost:3000",
    PORT: 3001,
    DATABASE_URL: "postgresql://test:test@localhost/test",
  },
}));

import { taskRouter } from "../../src/routes/tasks.js";
import { githubRouter } from "../../src/routes/github.js";

function makeApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", taskRouter);
  app.route("/", githubRouter);
  return app;
}

const AGENT: Actor = {
  type: "agent",
  tokenId: "agent-1",
  teamId: "team-1",
  userId: "agent-owner",
  scopes: ["tasks:read", "tasks:claim", "tasks:transition", "tasks:create", "tasks:update", "github:pr_merge", "github:pr_create"],
};

const HUMAN: Actor = { type: "human", userId: "user-1", teamId: "team-1" };

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
// Must be a real UUID: the github.ts routes' zod body schemas validate
// `taskId` with `.uuid()` (task_id in taskRouter's own routes is a bare URL
// param with no format check, but this constant is shared across both).
const TASK_ID = "00000000-0000-0000-0000-000000000001";

const HOME_REPO = "acme/thing";
const FOREIGN_REPO = "foreign-org/foreign-repo";
const FOREIGN_PR_URL = `https://github.com/${FOREIGN_REPO}/pull/9`;

const baseProject = {
  id: PROJECT_ID,
  name: "Agent Tasks",
  slug: "agent-tasks",
  teamId: "team-1",
  githubRepo: HOME_REPO,
  confidenceThreshold: 0,
  taskTemplate: null,
  requireDistinctReviewer: false,
  soloMode: false,
  governanceMode: null,
  requireGroundingForDebug: false,
};

const baseTask = {
  id: TASK_ID,
  projectId: PROJECT_ID,
  title: "Cross-repo benchmark task",
  description: null,
  status: "open",
  priority: "MEDIUM",
  workflowId: null,
  workflow: null,
  templateData: null,
  metadata: null,
  createdByAgentId: "agent-author",
  createdByUserId: null,
  claimedByAgentId: null,
  claimedByUserId: null,
  claimedAt: null,
  reviewClaimedByAgentId: null,
  reviewClaimedByUserId: null,
  reviewClaimedAt: null,
  branchName: "feat/test-branch",
  prUrl: null,
  prNumber: null,
  result: null,
  autoMergeSha: null,
  deliverableRepo: null as string | null,
  project: baseProject,
  attachments: [],
  comments: [],
  claimedByUser: null,
  claimedByAgent: null,
  blockedBy: [],
  blocks: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  accessMocks.hasProjectAccess.mockResolvedValue(true);
  accessMocks.hasProjectRole.mockResolvedValue(true);
  accessMocks.isProjectAdmin.mockResolvedValue(true);
  accessMocks.requireProjectWrite.mockResolvedValue(true);
  prismaMocks.taskUpdate.mockImplementation(
    ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
      Promise.resolve({ ...baseTask, id: where.id, ...data }),
  );
  prismaMocks.taskCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "task-new", ...data, attachments: [], artifacts: [], comments: [] }),
  );
  findDelegationUserMock.mockResolvedValue(null);
});

// ── task_create: deliverableRepo validation + authoring ─────────────────────

describe("POST /projects/:projectId/tasks — deliverableRepo", () => {
  async function postCreate(body: Record<string, unknown>) {
    return makeApp(AGENT).request(`/projects/${PROJECT_ID}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it.each(["not-a-repo", "a/b/c", ""])(
    "rejects malformed deliverableRepo %j with 400",
    async (bad) => {
      const res = await postCreate({ title: "T", deliverableRepo: bad });
      expect(res.status).toBe(400);
      expect(prismaMocks.taskCreate).not.toHaveBeenCalled();
    },
  );

  it("accepts a well-formed deliverableRepo and persists it + audits task.deliverable_repo_set", async () => {
    const res = await postCreate({ title: "T", deliverableRepo: FOREIGN_REPO });
    expect(res.status).toBe(201);
    expect(prismaMocks.taskCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deliverableRepo: FOREIGN_REPO }) }),
    );
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.deliverable_repo_set",
        payload: expect.objectContaining({ deliverableRepo: FOREIGN_REPO }),
      }),
    );
  });

  it("accepts deliverableRepo from a human caller too", async () => {
    const res = await makeApp(HUMAN).request(`/projects/${PROJECT_ID}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "T", deliverableRepo: FOREIGN_REPO }),
    });
    expect(res.status).toBe(201);
  });

  it("does not audit task.deliverable_repo_set when deliverableRepo is omitted", async () => {
    const res = await postCreate({ title: "T" });
    expect(res.status).toBe(201);
    expect(logAuditEventMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.deliverable_repo_set" }),
    );
  });
});

// ── PATCH /tasks/:id — authoring authorization + the confirmed hole ─────────

describe("PATCH /tasks/:id — deliverableRepo authoring", () => {
  it("rejects an agent PATCH naming deliverableRepo with 403, even unchanged", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...baseTask, project: baseProject });
    const res = await makeApp(AGENT).request(`/tasks/${TASK_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deliverableRepo: FOREIGN_REPO }),
    });
    expect(res.status).toBe(403);
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
  });

  it("rejects a non-admin human PATCH of deliverableRepo with 403", async () => {
    accessMocks.isProjectAdmin.mockResolvedValue(false);
    prismaMocks.taskFindUnique.mockResolvedValue({ ...baseTask, project: baseProject });
    const res = await makeApp(HUMAN).request(`/tasks/${TASK_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deliverableRepo: FOREIGN_REPO }),
    });
    expect(res.status).toBe(403);
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
  });

  it("lets a project admin set deliverableRepo and audits task.deliverable_repo_changed", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...baseTask, deliverableRepo: null, project: baseProject });
    const res = await makeApp(HUMAN).request(`/tasks/${TASK_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deliverableRepo: FOREIGN_REPO }),
    });
    expect(res.status).toBe(200);
    expect(prismaMocks.taskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deliverableRepo: FOREIGN_REPO }) }),
    );
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.deliverable_repo_changed",
        payload: expect.objectContaining({ from: null, to: FOREIGN_REPO }),
      }),
    );
  });

  it("audits task.foreign_pr_linked when one human PATCH sets the override AND links the foreign prUrl", async () => {
    // Regression for the re-review finding: the audit condition must use the
    // PENDING override (set in this same call), not the stale task row.
    prismaMocks.taskFindUnique.mockResolvedValue({ ...baseTask, deliverableRepo: null, project: baseProject });
    const res = await makeApp(HUMAN).request(`/tasks/${TASK_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deliverableRepo: FOREIGN_REPO, prUrl: FOREIGN_PR_URL }),
    });
    expect(res.status).toBe(200);
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.foreign_pr_linked",
        payload: expect.objectContaining({ prUrl: FOREIGN_PR_URL, deliverableRepo: FOREIGN_REPO, via: "patch" }),
      }),
    );
  });

  it("lets a project admin clear deliverableRepo and audits the change", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...baseTask, deliverableRepo: FOREIGN_REPO, project: baseProject });
    const res = await makeApp(HUMAN).request(`/tasks/${TASK_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deliverableRepo: null }),
    });
    expect(res.status).toBe(200);
    expect(prismaMocks.taskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deliverableRepo: null }) }),
    );
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.deliverable_repo_changed",
        payload: expect.objectContaining({ from: FOREIGN_REPO, to: null }),
      }),
    );
  });

  it("rejects a malformed deliverableRepo from an admin with 400", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...baseTask, project: baseProject });
    const res = await makeApp(HUMAN).request(`/tasks/${TASK_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deliverableRepo: "not-a-repo" }),
    });
    expect(res.status).toBe(400);
  });

  // CONFIRMED HOLE regression (agent lane): before this change, PATCH wrote
  // prUrl with no cross-repo guard at all.
  it("[regression] rejects a foreign prUrl on the agent PATCH lane without an override", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...baseTask, deliverableRepo: null, project: baseProject });
    const res = await makeApp(AGENT).request(`/tasks/${TASK_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prUrl: FOREIGN_PR_URL, prNumber: 9 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("cross_repo_pr_rejected");
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
  });

  // CONFIRMED HOLE regression (human lane): same hole, human actor.
  it("[regression] rejects a foreign prUrl on the human PATCH lane without an override", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...baseTask, deliverableRepo: null, project: baseProject });
    const res = await makeApp(HUMAN).request(`/tasks/${TASK_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prUrl: FOREIGN_PR_URL, prNumber: 9 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("cross_repo_pr_rejected");
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
  });

  it("accepts a foreign prUrl on the agent PATCH lane when deliverableRepo already overrides it", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ ...baseTask, deliverableRepo: FOREIGN_REPO, project: baseProject });
    const res = await makeApp(AGENT).request(`/tasks/${TASK_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prUrl: FOREIGN_PR_URL, prNumber: 9 }),
    });
    expect(res.status).toBe(200);
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.foreign_pr_linked" }),
    );
  });
});

// ── POST /api/github/pull-requests — the confirmed hole ─────────────────────

describe("POST /pull-requests — deliverableRepo guard", () => {
  const createBody = {
    taskId: TASK_ID,
    owner: "foreign-org",
    repo: "foreign-repo",
    head: "feat/x",
    title: "Benchmark run",
  };

  it("[regression] rejects PR creation targeting a foreign repo without an override, BEFORE calling GitHub", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({
      id: TASK_ID,
      projectId: PROJECT_ID,
      deliverableRepo: null,
      project: { id: PROJECT_ID, teamId: "team-1", githubRepo: HOME_REPO },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const res = await makeApp(AGENT).request("/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createBody),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("cross_repo_pr_rejected");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("creates the PR and audits task.foreign_pr_linked when the override matches the requested owner/repo", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({
      id: TASK_ID,
      projectId: PROJECT_ID,
      deliverableRepo: FOREIGN_REPO,
      project: { id: PROJECT_ID, teamId: "team-1", githubRepo: HOME_REPO },
    });
    findDelegationUserMock.mockResolvedValue({
      userId: "u1",
      login: "delegate",
      githubAccessToken: "ghp_delegate",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ number: 9, html_url: FOREIGN_PR_URL, title: "Benchmark run" }),
        { status: 201 },
      ),
    );
    const res = await makeApp(AGENT).request("/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createBody),
    });
    expect(res.status).toBe(201);
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.foreign_pr_linked",
        payload: expect.objectContaining({ deliverableRepo: FOREIGN_REPO }),
      }),
    );
    fetchMock.mockRestore();
  });
});

// ── Happy path: link a foreign prUrl and reach expectedFinishState ──────────

describe("Happy path — deliverableRepo override lets a foreign PR reach done/review", () => {
  it("task_finish { prUrl } links a foreign PR and transitions to review", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({
      ...baseTask,
      status: "in_progress",
      claimedByAgentId: AGENT.tokenId,
      branchName: "feat/x",
      deliverableRepo: FOREIGN_REPO,
      project: baseProject,
    });
    const res = await makeApp(AGENT).request(`/tasks/${TASK_ID}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prUrl: FOREIGN_PR_URL }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { targetStatus: string };
    expect(body.targetStatus).toBe("review");
  });

  it("task_submit_pr links a foreign PR on a deliverableRepo-overridden task", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({
      ...baseTask,
      status: "in_progress",
      claimedByAgentId: AGENT.tokenId,
      deliverableRepo: FOREIGN_REPO,
      project: baseProject,
    });
    const res = await makeApp(AGENT).request(`/tasks/${TASK_ID}/submit-pr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branchName: "feat/x", prUrl: FOREIGN_PR_URL, prNumber: 9 }),
    });
    expect(res.status).toBe(200);
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.foreign_pr_linked" }),
    );
  });
});

// ── Merge-automation hard refusal, wired across every caller ────────────────

const REFUSAL = {
  ok: false,
  error: "foreign_deliverable_merge_refused",
  message: "foreign repo owns its own merge lifecycle",
  status: 409,
} as const;

describe("Merge automation refuses a foreign deliverable — 409, every caller", () => {
  beforeEach(() => {
    performPrMergeMock.mockResolvedValue(REFUSAL);
  });

  it("task_merge", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({
      ...baseTask,
      status: "review",
      claimedByAgentId: "agent-claimant",
      reviewClaimedByAgentId: "agent-reviewer",
      deliverableRepo: FOREIGN_REPO,
      project: { ...baseProject, soloMode: true, requireDistinctReviewer: false },
    });
    const res = await makeApp(AGENT).request(`/tasks/${TASK_ID}/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("foreign_deliverable_merge_refused");
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
  });

  it("task_finish autoMerge Mode A (solo work-claim)", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({
      ...baseTask,
      status: "in_progress",
      claimedByAgentId: AGENT.tokenId,
      branchName: "feat/x",
      prUrl: FOREIGN_PR_URL,
      prNumber: 9,
      deliverableRepo: FOREIGN_REPO,
      project: { ...baseProject, soloMode: true },
    });
    const res = await makeApp(AGENT).request(`/tasks/${TASK_ID}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoMerge: true }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("foreign_deliverable_merge_refused");
  });

  it("task_finish autoMerge Mode B (reviewer approve)", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({
      ...baseTask,
      status: "review",
      claimedByAgentId: "agent-author",
      reviewClaimedByAgentId: AGENT.tokenId,
      reviewClaimedAt: new Date(),
      branchName: "feat/x",
      prUrl: FOREIGN_PR_URL,
      prNumber: 9,
      deliverableRepo: FOREIGN_REPO,
      project: baseProject,
    });
    const res = await makeApp(AGENT).request(`/tasks/${TASK_ID}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "approve", autoMerge: true }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("foreign_deliverable_merge_refused");
  });

  it("task_finish autoMerge on the self-approve branch (work-claim holder approves own review task)", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({
      ...baseTask,
      status: "review",
      claimedByAgentId: AGENT.tokenId,
      reviewClaimedByAgentId: null,
      branchName: "feat/x",
      prUrl: FOREIGN_PR_URL,
      prNumber: 9,
      deliverableRepo: FOREIGN_REPO,
      project: { ...baseProject, soloMode: true },
    });
    const res = await makeApp(AGENT).request(`/tasks/${TASK_ID}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "approve", autoMerge: true }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("foreign_deliverable_merge_refused");
  });

  it("the direct GitHub merge route", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({
      id: TASK_ID,
      projectId: PROJECT_ID,
      status: "review",
      claimedByUserId: null,
      claimedByAgentId: "agent-claimant",
      reviewClaimedByUserId: null,
      reviewClaimedByAgentId: "agent-reviewer",
      prNumber: 9,
      deliverableRepo: FOREIGN_REPO,
      project: {
        id: PROJECT_ID,
        teamId: "team-1",
        githubRepo: HOME_REPO,
        governanceMode: null,
        requireDistinctReviewer: false,
        soloMode: true,
      },
    });
    const res = await makeApp(AGENT).request("/pull-requests/9/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: TASK_ID, owner: "acme", repo: "thing", merge_method: "squash" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("foreign_deliverable_merge_refused");
  });
});

// ── ciGreen/prMerged v1 skip semantics on a foreign deliverable ─────────────

describe("ciGreen/prMerged skip on a foreign-deliverable task", () => {
  const workflowRequiringCiGreen = {
    id: "wf-cigreen",
    projectId: PROJECT_ID,
    isDefault: false,
    definition: {
      states: [
        { name: "open", label: "Open", terminal: false },
        { name: "in_progress", label: "In progress", terminal: false },
        { name: "review", label: "Review", terminal: false },
        { name: "done", label: "Done", terminal: true },
      ],
      transitions: [
        { from: "open", to: "in_progress", requiredRole: "any" },
        {
          from: "in_progress",
          to: "review",
          requiredRole: "any",
          requires: ["branchPresent", "prPresent", "ciGreen"],
        },
        { from: "review", to: "done", requiredRole: "any" },
      ],
      initialState: "open",
    },
  };

  it("finishes without calling GitHub delegation and reports the skip reason", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({
      ...baseTask,
      status: "in_progress",
      claimedByAgentId: AGENT.tokenId,
      branchName: "feat/x",
      workflowId: "wf-cigreen",
      workflow: workflowRequiringCiGreen,
      deliverableRepo: FOREIGN_REPO,
      project: baseProject,
    });
    const res = await makeApp(AGENT).request(`/tasks/${TASK_ID}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prUrl: FOREIGN_PR_URL }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      targetStatus: string;
      skippedGates?: Array<{ rule: string; reason: string }>;
    };
    expect(body.targetStatus).toBe("review");
    expect(body.skippedGates).toBeDefined();
    expect(body.skippedGates?.some((s) => s.rule === "ciGreen")).toBe(true);
    // The GitHub-backed delegation lookup — the prerequisite for actually
    // calling the GitHub Check Runs API — is never reached.
    expect(findDelegationUserMock).not.toHaveBeenCalled();
  });

  it("evaluates ciGreen normally on an override that differs from the home repo only by case (same repo, no fail-open skip)", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({
      ...baseTask,
      status: "in_progress",
      claimedByAgentId: AGENT.tokenId,
      branchName: "feat/x",
      workflowId: "wf-cigreen",
      workflow: workflowRequiringCiGreen,
      // Same repo as HOME_REPO ("acme/thing"), recased. GitHub treats
      // owner/repo case-insensitively, so this must NOT count as foreign —
      // a raw string compare here would skip ciGreen on a home-repo task.
      deliverableRepo: "Acme/Thing",
      project: baseProject,
    });
    const res = await makeApp(AGENT).request(`/tasks/${TASK_ID}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prUrl: `https://github.com/${HOME_REPO}/pull/9` }),
    });
    // ciGreen WAS evaluated (fails closed with no delegation token) — the
    // 422 is the proof that the case-variant override did not fail open.
    expect(res.status).toBe(422);
    const body = (await res.json()) as { failed?: Array<{ rule: string }> };
    expect(body.failed?.some((f) => f.rule === "ciGreen")).toBe(true);
  });

  it("evaluates ciGreen normally (fails closed) on the same workflow without a deliverableRepo override", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({
      ...baseTask,
      status: "in_progress",
      claimedByAgentId: AGENT.tokenId,
      branchName: "feat/x",
      workflowId: "wf-cigreen",
      workflow: workflowRequiringCiGreen,
      deliverableRepo: null,
      project: baseProject,
    });
    const res = await makeApp(AGENT).request(`/tasks/${TASK_ID}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prUrl: `https://github.com/${HOME_REPO}/pull/9` }),
    });
    // No GitHub delegation user available (findDelegationUserMock defaults
    // to null) → ciGreen fails closed → 422, proving the rule WAS evaluated
    // (not silently skipped) on a same-repo task.
    expect(res.status).toBe(422);
  });
});

// ── v1 /transition parity: foreign-deliverable skip (MCP tasks_transition) ──

describe("POST /tasks/:id/transition — foreign-deliverable ciGreen skip (v1 parity)", () => {
  const workflowRequiringCiGreen = {
    id: "wf-cigreen-v1",
    projectId: PROJECT_ID,
    isDefault: false,
    definition: {
      states: [
        { name: "open", label: "Open", terminal: false },
        { name: "in_progress", label: "In progress", terminal: false },
        { name: "review", label: "Review", terminal: false },
        { name: "done", label: "Done", terminal: true },
      ],
      transitions: [
        { from: "open", to: "in_progress", requiredRole: "any" },
        {
          from: "in_progress",
          to: "review",
          requiredRole: "any",
          requires: ["branchPresent", "prPresent", "ciGreen"],
        },
        { from: "review", to: "done", requiredRole: "any" },
      ],
      initialState: "open",
    },
  };

  it("transitions without evaluating ciGreen and reports skippedGates", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({
      ...baseTask,
      status: "in_progress",
      claimedByAgentId: AGENT.tokenId,
      branchName: "feat/x",
      prUrl: FOREIGN_PR_URL,
      prNumber: 9,
      workflowId: "wf-cigreen-v1",
      workflow: workflowRequiringCiGreen,
      deliverableRepo: FOREIGN_REPO,
      project: baseProject,
    });
    const res = await makeApp(AGENT).request(`/tasks/${TASK_ID}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "review" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skippedGates?: Array<{ rule: string; reason: string }>;
    };
    // Without the parity skip, MCP tasks_transition (which lands on this v1
    // endpoint, not on /finish) would re-create the cross-repo deadlock.
    expect(body.skippedGates?.some((s) => s.rule === "ciGreen")).toBe(true);
    expect(findDelegationUserMock).not.toHaveBeenCalled();
  });

  it("still evaluates ciGreen on the same transition without an override (negative control)", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({
      ...baseTask,
      status: "in_progress",
      claimedByAgentId: AGENT.tokenId,
      branchName: "feat/x",
      prUrl: `https://github.com/${HOME_REPO}/pull/9`,
      prNumber: 9,
      workflowId: "wf-cigreen-v1",
      workflow: workflowRequiringCiGreen,
      deliverableRepo: null,
      project: baseProject,
    });
    const res = await makeApp(AGENT).request(`/tasks/${TASK_ID}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "review" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("precondition_failed");
  });
});
