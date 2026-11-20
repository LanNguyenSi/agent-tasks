/**
 * POST /api/github/pull-requests fails closed when the task has no usable
 * effective deliverable repo.
 *
 * The route creates the PR with a team member's delegated GitHub token on a
 * body-supplied owner/repo. The effective repo is the task's `deliverableRepo`
 * when set, else the project's `githubRepo`. With neither set (null, empty or
 * blank), or with a value that is not `owner/repo`, there is nothing to compare
 * the target against, so the route answers
 * 400 { error: "no_effective_repo", message } before the delegation lookup,
 * before any GitHub call, with no task write and no idempotency record.
 *
 * Where Grounding is configured its refusal for the target keeps precedence
 * over that 400. A task whose effective repo is usable behaves as before:
 * a match passes, a mismatch answers 400 cross_repo_pr_rejected.
 *
 * Route-wiring tests only: GitHub fetch is spied, delegation / access / audit
 * are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";
import type { GroundingRemoteTargetGuard } from "../../src/services/grounding-scope.js";

const prismaMocks = vi.hoisted(() => ({
  taskFindUnique: vi.fn(),
  taskUpdate: vi.fn().mockResolvedValue(undefined),
  toolFindUnique: vi.fn().mockResolvedValue(null),
  toolCreate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: { findUnique: prismaMocks.taskFindUnique, update: prismaMocks.taskUpdate },
    toolInvocation: { findUnique: prismaMocks.toolFindUnique, create: prismaMocks.toolCreate },
  },
}));

const hasProjectAccessMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock("../../src/services/team-access.js", () => ({
  hasProjectAccess: hasProjectAccessMock,
}));

const findDelegationUserMock = vi.hoisted(() => vi.fn());
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

function makeApp(guard: GroundingRemoteTargetGuard | null = null) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", AGENT);
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
  scopes: ["tasks:update", "github:pr_create"],
};

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const TASK_ID = "00000000-0000-0000-0000-000000000001";
const HOME_REPO = "lannguyensi/repo";
const DELIVERABLE_REPO = "acme/deliverable";

function wireTask(input: { githubRepo: string | null; deliverableRepo: string | null }) {
  prismaMocks.taskFindUnique.mockResolvedValue({
    id: TASK_ID,
    projectId: PROJECT_ID,
    deliverableRepo: input.deliverableRepo,
    project: { id: PROJECT_ID, teamId: "team-1", githubRepo: input.githubRepo },
  });
}

async function postCreate(
  owner: string,
  repo: string,
  opts: { guard?: GroundingRemoteTargetGuard | null; idempotencyKey?: string } = {},
) {
  return makeApp(opts.guard ?? null).request("/pull-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      taskId: TASK_ID,
      owner,
      repo,
      head: "feat/x",
      title: "Add thing",
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    }),
  });
}

function createdResponse(url: string) {
  return new Response(JSON.stringify({ number: 9, html_url: url, title: "Add thing" }), { status: 201 });
}

beforeEach(() => {
  vi.clearAllMocks();
  hasProjectAccessMock.mockResolvedValue(true);
  prismaMocks.toolFindUnique.mockResolvedValue(null);
  findDelegationUserMock.mockResolvedValue({
    userId: "u1",
    login: "delegate",
    githubAccessToken: "ghp_delegate",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /pull-requests without an effective repo", () => {
  it("unbound project and no deliverableRepo: 400 no_effective_repo with a hint, nothing delegated, sent or written", async () => {
    wireTask({ githubRepo: null, deliverableRepo: null });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const res = await postCreate("someone", "anything");

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("no_effective_repo");
    expect(body.message).toContain("githubRepo");
    expect(body.message).toContain("deliverableRepo");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(findDelegationUserMock).not.toHaveBeenCalled();
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
    expect(logAuditEventMock).not.toHaveBeenCalled();
  });

  it("with an idempotencyKey the refusal leaves no idempotency record", async () => {
    wireTask({ githubRepo: null, deliverableRepo: null });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const res = await postCreate("someone", "anything", { idempotencyKey: "key-no-repo" });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "no_effective_repo" });
    expect(prismaMocks.toolFindUnique).not.toHaveBeenCalled();
    expect(prismaMocks.toolCreate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty githubRepo", { githubRepo: "", deliverableRepo: null }],
    ["a blank githubRepo", { githubRepo: "   ", deliverableRepo: null }],
    ["an empty deliverableRepo (it wins over the project repo, so nothing usable is left)", { githubRepo: HOME_REPO, deliverableRepo: "" }],
  ])("%s fails closed with 400 no_effective_repo", async (_label, input) => {
    wireTask(input);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const res = await postCreate("lannguyensi", "repo");

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "no_effective_repo" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(findDelegationUserMock).not.toHaveBeenCalled();
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["a githubRepo without a slash", { githubRepo: "not-a-repo", deliverableRepo: null }],
    ["a githubRepo with an empty repo part", { githubRepo: "owner/", deliverableRepo: null }],
    ["a malformed deliverableRepo", { githubRepo: HOME_REPO, deliverableRepo: "no-slash" }],
  ])("%s (not owner/repo) fails closed with 400 no_effective_repo", async (_label, input) => {
    wireTask(input);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const res = await postCreate("lannguyensi", "repo");

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("no_effective_repo");
    expect(body.message).toContain("owner/repo");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(findDelegationUserMock).not.toHaveBeenCalled();
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
  });

  it("still answers 403 from hasProjectAccess before the repo requirement", async () => {
    wireTask({ githubRepo: null, deliverableRepo: null });
    hasProjectAccessMock.mockResolvedValue(false);

    const res = await postCreate("someone", "anything");

    expect(res.status).toBe(403);
  });
});

describe("POST /pull-requests with a usable effective repo", () => {
  it("unbound project with a deliverableRepo: the target is compared against it (pass)", async () => {
    wireTask({ githubRepo: null, deliverableRepo: DELIVERABLE_REPO });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(createdResponse(`https://github.com/${DELIVERABLE_REPO}/pull/9`));

    const res = await postCreate("acme", "deliverable");

    expect(res.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/deliverable/pulls",
      expect.objectContaining({ method: "POST" }),
    );
    expect(prismaMocks.taskUpdate).toHaveBeenCalledTimes(1);
  });

  it("unbound project with a deliverableRepo: a different target is refused with cross_repo_pr_rejected", async () => {
    wireTask({ githubRepo: null, deliverableRepo: DELIVERABLE_REPO });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const res = await postCreate("someone", "anything");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "cross_repo_pr_rejected",
      message: `PR belongs to someone/anything but this task's effective deliverable repo is ${DELIVERABLE_REPO}`,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(findDelegationUserMock).not.toHaveBeenCalled();
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
  });

  it("bound project, no deliverableRepo: a match passes, a mismatch answers cross_repo_pr_rejected (unchanged)", async () => {
    wireTask({ githubRepo: HOME_REPO, deliverableRepo: null });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(createdResponse(`https://github.com/${HOME_REPO}/pull/9`));

    const allowed = await postCreate("LanNguyenSi", "Repo");
    expect(allowed.status).toBe(201);

    const refused = await postCreate("other-org", "repo");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "cross_repo_pr_rejected" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("POST /pull-requests without an effective repo, Grounding effect boundary configured", () => {
  const refusal = { error: "grounding_enrollment_required", status: 409, message: "refused by the boundary" } as const;

  it("a target the boundary refuses is answered by the boundary, not by no_effective_repo", async () => {
    wireTask({ githubRepo: null, deliverableRepo: null });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const guard = vi.fn().mockResolvedValue(refusal);

    const res = await postCreate("other-org", "other-repo", { guard });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "grounding_enrollment_required", message: "refused by the boundary" });
    expect(guard).toHaveBeenCalledTimes(1);
    expect(guard).toHaveBeenCalledWith({ repo: "other-org/other-repo", kind: "create", taskId: TASK_ID });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(findDelegationUserMock).not.toHaveBeenCalled();
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
  });

  it("a target the boundary does not refuse is still refused with 400 no_effective_repo", async () => {
    wireTask({ githubRepo: null, deliverableRepo: null });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const guard = vi.fn().mockResolvedValue(null);

    const res = await postCreate("other-org", "other-repo", { guard });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "no_effective_repo" });
    expect(guard).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(findDelegationUserMock).not.toHaveBeenCalled();
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
  });
});
