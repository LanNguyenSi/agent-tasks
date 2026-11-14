/**
 * Cross-repo guard on POST /api/github/pull-requests/:prNumber/comments
 * (the delegation gap: the route took owner/repo from the body and posted
 * with a team member's delegated token after only hasProjectAccess).
 *
 * The guard is the same `checkOwnerRepoMatchesProject` the PR-create route
 * runs: the effective deliverable repo is the task's `deliverableRepo` when
 * set, else the project's `githubRepo`; both sides compare lowercased, so a
 * pure case difference is the SAME repo and is accepted. A mismatch answers
 * the PR-create envelope: 400 { error: "cross_repo_pr_rejected", message },
 * before the delegation lookup and before any GitHub call.
 *
 * Route-wiring tests only: GitHub fetch is spied, delegation / access /
 * audit are mocked. Without an `idempotencyKey` the route executes the
 * action directly (services/idempotency.ts), so no tool_invocation stub.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";
import type { GroundingRemoteTargetGuard } from "../../src/services/grounding-scope.js";

const prismaMocks = vi.hoisted(() => ({
  taskFindUnique: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: { findUnique: prismaMocks.taskFindUnique },
  },
}));

const hasProjectAccessMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock("../../src/services/team-access.js", () => ({
  hasProjectAccess: hasProjectAccessMock,
}));

const findDelegationUserMock = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock("../../src/services/github-delegation.js", () => ({
  findDelegationUser: findDelegationUserMock,
}));

const logAuditEventMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: logAuditEventMock,
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

function makeApp(actor: Actor, guard: GroundingRemoteTargetGuard | null = null) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    // Default: an unconfigured application, whose legacy handlers run no
    // Grounding guard.
    c.set("groundingRemoteTargetGuard", guard);
    await next();
  });
  app.route("/", githubRouter);
  return app;
}

const AGENT: Actor = {
  type: "agent",
  tokenId: "agent-1",
  teamId: "team-1",
  userId: "agent-owner",
  scopes: ["tasks:comment"],
};

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const TASK_ID = "00000000-0000-0000-0000-000000000001";

const HOME_REPO = "lannguyensi/repo";
const FOREIGN_REPO = "other-org/other-repo";
const DELIVERABLE_REPO = "acme/deliverable";

function wireTask(input: {
  githubRepo: string | null;
  deliverableRepo: string | null;
}) {
  prismaMocks.taskFindUnique.mockResolvedValue({
    id: TASK_ID,
    projectId: PROJECT_ID,
    deliverableRepo: input.deliverableRepo,
    project: { id: PROJECT_ID, teamId: "team-1", githubRepo: input.githubRepo },
  });
}

async function postComment(owner: string, repo: string, guard: GroundingRemoteTargetGuard | null = null) {
  return makeApp(AGENT, guard).request("/pull-requests/7/comments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId: TASK_ID, owner, repo, body: "LGTM" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  hasProjectAccessMock.mockResolvedValue(true);
  findDelegationUserMock.mockResolvedValue({
    userId: "u1",
    login: "delegate",
    githubAccessToken: "ghp_delegate",
  });
});

describe("POST /pull-requests/:prNumber/comments cross-repo guard", () => {
  it("posts the comment when owner/repo equal the project repo", async () => {
    wireTask({ githubRepo: HOME_REPO, deliverableRepo: null });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 10,
          html_url: `https://github.com/${HOME_REPO}/pull/7#discussion-10`,
          body: "LGTM",
        }),
        { status: 201 },
      ),
    );

    const res = await postComment("lannguyensi", "repo");

    expect(res.status).toBe(201);
    expect((await res.json()) as { comment: { id: number } }).toEqual({
      comment: { id: 10, url: `https://github.com/${HOME_REPO}/pull/7#discussion-10`, body: "LGTM" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.github.com/repos/lannguyensi/repo/issues/7/comments`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "github.pr_commented" }),
    );
    fetchMock.mockRestore();
  });

  it("[regression] rejects a different owner with the PR-create mismatch envelope, before delegation and GitHub", async () => {
    wireTask({ githubRepo: HOME_REPO, deliverableRepo: null });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const res = await postComment("other-org", "repo");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "cross_repo_pr_rejected",
      message: `PR belongs to other-org/repo but this task's effective deliverable repo is ${HOME_REPO}`,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    // The gate runs BEFORE the delegation lookup: the token is never fetched.
    expect(findDelegationUserMock).not.toHaveBeenCalled();
    // The mock returns githubRepo whatever is selected, so pin the select:
    // without it real Prisma leaves project.githubRepo undefined and the gate
    // goes inactive again.
    expect(prismaMocks.taskFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: { project: { select: expect.objectContaining({ githubRepo: true }) } },
      }),
    );
    fetchMock.mockRestore();
  });

  it("rejects a different repo with the same owner", async () => {
    wireTask({ githubRepo: HOME_REPO, deliverableRepo: null });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const res = await postComment("lannguyensi", "other-repo");

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "cross_repo_pr_rejected" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(findDelegationUserMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("accepts a pure case difference (GitHub owner/repo names are case-insensitive, same as PR create)", async () => {
    wireTask({ githubRepo: HOME_REPO, deliverableRepo: null });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: 11, html_url: "https://github.com/x", body: "LGTM" }), {
        status: 201,
      }),
    );

    const res = await postComment("LanNguyenSi", "Repo");

    expect(res.status).toBe(201);
    expect(fetchMock).toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("deliverableRepo wins over the project repo: the deliverable repo is accepted, the project repo is rejected", async () => {
    wireTask({ githubRepo: HOME_REPO, deliverableRepo: DELIVERABLE_REPO });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: 12, html_url: "https://github.com/x", body: "LGTM" }), {
        status: 201,
      }),
    );

    const allowed = await postComment("acme", "deliverable");
    expect(allowed.status).toBe(201);

    const refused = await postComment("lannguyensi", "repo");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: "cross_repo_pr_rejected",
      message: `PR belongs to lannguyensi/repo but this task's effective deliverable repo is ${DELIVERABLE_REPO}`,
    });

    // Only the accepted call reached GitHub.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.github.com/repos/acme/deliverable/issues/7/comments`,
      expect.objectContaining({ method: "POST" }),
    );
    fetchMock.mockRestore();
  });

  it("no binding (project.githubRepo null, no deliverableRepo): the gate is inactive, any repo is accepted", async () => {
    wireTask({ githubRepo: null, deliverableRepo: null });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: 13, html_url: "https://github.com/x", body: "LGTM" }), {
        status: 201,
      }),
    );

    const res = await postComment("someone", "anything");

    expect(res.status).toBe(201);
    expect(fetchMock).toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("still answers 403 from hasProjectAccess before the repo guard runs", async () => {
    wireTask({ githubRepo: HOME_REPO, deliverableRepo: null });
    hasProjectAccessMock.mockResolvedValue(false);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const res = await postComment("other-org", "repo");

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});

describe("POST /pull-requests/:prNumber/comments cross-repo guard with the Grounding effect boundary configured", () => {
  const refusal = { error: "grounding_enrollment_required", status: 409, message: "refused by the boundary" } as const;

  it("a foreign repository the boundary refuses is answered by the boundary, before delegation and GitHub", async () => {
    wireTask({ githubRepo: HOME_REPO, deliverableRepo: null });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const guard = vi.fn().mockResolvedValue(refusal);

    const res = await postComment("other-org", "other-repo", guard);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "grounding_enrollment_required", message: "refused by the boundary" });
    expect(guard).toHaveBeenCalledTimes(1);
    expect(guard).toHaveBeenCalledWith({ repo: FOREIGN_REPO, prNumber: 7, kind: "comment", taskId: TASK_ID });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(findDelegationUserMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("a foreign repository the boundary does not refuse is still refused by the cross-repo gate, before delegation and GitHub", async () => {
    wireTask({ githubRepo: HOME_REPO, deliverableRepo: null });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const guard = vi.fn().mockResolvedValue(null);

    const res = await postComment("other-org", "other-repo", guard);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "cross_repo_pr_rejected" });
    expect(guard).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(findDelegationUserMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("the task's own repository passes the gate and reaches the boundary once, inside the side-effect block", async () => {
    wireTask({ githubRepo: HOME_REPO, deliverableRepo: null });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: 14, html_url: "https://github.com/x", body: "LGTM" }), { status: 201 }),
    );
    const guard = vi.fn().mockResolvedValue(null);

    const res = await postComment("lannguyensi", "repo", guard);

    expect(res.status).toBe(201);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  });
});
