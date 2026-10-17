/**
 * `POST /github/pull-requests/:n/merge` judges the task's status on its
 * effective workflow definition instead of the literals review/done: a state
 * the workflow marks review-like passes the status gate AND is still held to
 * the distinct-reviewer gate, a terminal state is the idempotent retry, and
 * the merge writes the workflow's own terminal state.
 *
 * The review gate is the real one (not mocked) so "reaches the reviewer gate"
 * is observable as its rejection. `performPrMerge` is mocked: this file is
 * about route wiring.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const prismaMocks = vi.hoisted(() => ({
  taskFindUnique: vi.fn(),
  taskUpdate: vi.fn().mockResolvedValue(undefined),
  taskUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
  workflowFindFirst: vi.fn(),
  workflowFindUnique: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: {
      findUnique: prismaMocks.taskFindUnique,
      update: prismaMocks.taskUpdate,
      updateMany: prismaMocks.taskUpdateMany,
    },
    workflow: {
      findFirst: prismaMocks.workflowFindFirst,
      findUnique: prismaMocks.workflowFindUnique,
    },
  },
}));

const logAuditEventMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../src/services/audit.js", () => ({ logAuditEvent: logAuditEventMock }));

vi.mock("../../src/services/github-delegation.js", () => ({
  findDelegationUser: vi.fn().mockResolvedValue({ userId: "u1", login: "delegate", githubAccessToken: "ghp_x" }),
}));

vi.mock("../../src/services/team-access.js", () => ({
  hasProjectAccess: vi.fn().mockResolvedValue(true),
}));

const performPrMergeMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/github-merge.js", () => ({ performPrMerge: performPrMergeMock }));

vi.mock("../../src/services/signal.js", () => ({
  acknowledgeSignalsForTask: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/self-merge-notice.js", () => ({
  emitSelfMergeNoticeIfApplicable: vi.fn().mockResolvedValue(undefined),
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

import { githubRouter } from "../../src/routes/github.js";
import { appErrorHandler } from "../../src/lib/error-handler.js";
import { taskStatusForMergeRejectionMessage } from "../../src/services/gates/index.js";
import { distinctReviewerRejectionMessage } from "../../src/services/review-gate.js";
import { CUSTOM_VOCABULARY_DEFINITION } from "../helpers/custom-vocabulary-workflow.js";

const MERGE_ACTOR: Actor = {
  type: "agent",
  tokenId: "agent-merger",
  teamId: "team-1",
  scopes: ["tasks:transition", "github:pr_merge"],
  userId: "agent-owner",
};

const TASK_ID = "00000000-0000-0000-0000-000000000001";

function makeApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("groundingRemoteTargetGuard", null);
    await next();
  });
  app.route("/", githubRouter);
  app.onError(appErrorHandler);
  return app;
}

function mergeRequest() {
  return makeApp(MERGE_ACTOR).request("/pull-requests/42/merge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId: TASK_ID, owner: "acme", repo: "thing", merge_method: "squash" }),
  });
}

/** A project that requires a distinct reviewer: the reviewer gate is live. */
const DISTINCT_REVIEWER_PROJECT = {
  id: "proj-1",
  teamId: "team-1",
  githubRepo: "acme/thing",
  governanceMode: "REQUIRES_DISTINCT_REVIEWER",
  requireDistinctReviewer: true,
  soloMode: false,
};

function taskIn(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    projectId: "proj-1",
    workflowId: "wf-custom",
    status,
    statusVersion: 3,
    prNumber: 42,
    claimedByUserId: null,
    claimedByAgentId: "agent-claimant",
    reviewClaimedByUserId: null,
    reviewClaimedByAgentId: null,
    project: DISTINCT_REVIEWER_PROJECT,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.workflowFindUnique.mockResolvedValue({ definition: CUSTOM_VOCABULARY_DEFINITION });
  prismaMocks.workflowFindFirst.mockResolvedValue(null);
  performPrMergeMock.mockResolvedValue({ ok: true, sha: "deadbeef", alreadyMerged: false });
});

describe("merge route on a custom state vocabulary", () => {
  it.each(["open", "plan", "build"])("refuses a task in the non-review state %s without touching GitHub", async (status) => {
    prismaMocks.taskFindUnique.mockResolvedValue(taskIn(status));

    const res = await mergeRequest();

    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe(taskStatusForMergeRejectionMessage(status));
    expect(performPrMergeMock).not.toHaveBeenCalled();
  });

  it("a review-like custom state passes the status gate and reaches the distinct-reviewer gate", async () => {
    // No review lock: the real checkReviewApprovalGate must refuse. Reaching
    // this refusal (and not the status refusal) proves both gates ran.
    prismaMocks.taskFindUnique.mockResolvedValue(taskIn("qa"));

    const res = await mergeRequest();

    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe(distinctReviewerRejectionMessage());
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.review_rejected_self_reviewer",
        payload: expect.objectContaining({ reason: "no_review_lock", endpoint: "merge" }),
      }),
    );
    expect(performPrMergeMock).not.toHaveBeenCalled();
  });

  it("a review-like custom state with a valid reviewer merges and writes the workflow's terminal state", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue(taskIn("qa", { reviewClaimedByAgentId: "agent-reviewer" }));

    const res = await mergeRequest();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { merged: boolean; task: { status: string } };
    expect(body.merged).toBe(true);
    expect(body.task.status).toBe("shipped");
    expect(performPrMergeMock).toHaveBeenCalledTimes(1);
    expect(prismaMocks.taskUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "shipped" }) }),
    );
  });

  it("a terminal custom state is the idempotent retry and skips the distinct-reviewer gate", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue(taskIn("shipped"));

    const res = await mergeRequest();

    expect(res.status).toBe(200);
    expect(performPrMergeMock).toHaveBeenCalledTimes(1);
  });

  it("resolves the project default workflow for a task without its own workflow", async () => {
    prismaMocks.workflowFindFirst.mockResolvedValue({ definition: CUSTOM_VOCABULARY_DEFINITION });
    prismaMocks.taskFindUnique.mockResolvedValue(taskIn("qa", { workflowId: null }));

    const res = await mergeRequest();

    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toBe(distinctReviewerRejectionMessage());
  });
});

describe("merge route on the built-in four-state workflow", () => {
  beforeEach(() => {
    prismaMocks.workflowFindUnique.mockResolvedValue(null);
    prismaMocks.workflowFindFirst.mockResolvedValue(null);
  });

  it("still refuses in_progress and keeps the message byte-identical", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue(taskIn("in_progress", { workflowId: null }));

    const res = await mergeRequest();

    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toBe(taskStatusForMergeRejectionMessage("in_progress"));
  });

  it("a review task still reaches the distinct-reviewer gate and merges to done with a reviewer", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue(
      taskIn("review", { workflowId: null, reviewClaimedByAgentId: "agent-reviewer" }),
    );

    const res = await mergeRequest();

    expect(res.status).toBe(200);
    expect(((await res.json()) as { task: { status: string } }).task.status).toBe("done");
  });
});
