/**
 * Integration tests for the idempotencyKey wiring on the GitHub PR routes.
 *
 * Covers the v1 acceptance criteria:
 *   - double `pull_requests_create` with the same key produces ONE PR on
 *     GitHub; the second call replays the stored 2xx response
 *   - double `pull_requests_merge` with the same key calls `performPrMerge`
 *     ONCE; the second call replays
 *   - omitting the key preserves pre-existing behavior (every call executes)
 *   - same key + different payload yields 409 (ConflictError)
 *
 * Uses an in-memory stub for `prisma.toolInvocation` so the helper's real
 * code path is exercised end-to-end — only the DB boundary is faked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

// In-memory tool_invocations table, indexed by the unique tuple.
interface ToolInvocationRow {
  projectId: string;
  verb: string;
  idempotencyKey: string;
  payloadHash: string;
  responseBody: unknown;
  statusCode: number;
}

const store = vi.hoisted(() => ({
  rows: [] as ToolInvocationRow[],
}));

const prismaMocks = vi.hoisted(() => ({
  taskFindUnique: vi.fn(),
  taskUpdate: vi.fn().mockResolvedValue(undefined),
  toolFindUnique: vi.fn(),
  toolCreate: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: {
      findUnique: prismaMocks.taskFindUnique,
      update: prismaMocks.taskUpdate,
    },
    toolInvocation: {
      findUnique: prismaMocks.toolFindUnique,
      create: prismaMocks.toolCreate,
    },
  },
}));

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/github-delegation.js", () => ({
  findDelegationUser: vi.fn().mockResolvedValue({
    userId: "u1",
    login: "delegate",
    githubAccessToken: "ghp_delegate",
  }),
}));

const hasProjectAccessMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock("../../src/services/team-access.js", () => ({
  hasProjectAccess: hasProjectAccessMock,
}));

const performPrMergeMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/github-merge.js", () => ({
  performPrMerge: performPrMergeMock,
}));

vi.mock("../../src/services/signal.js", () => ({
  acknowledgeSignalsForTask: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/self-merge-notice.js", () => ({
  emitSelfMergeNoticeIfApplicable: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/review-gate.js", () => ({
  checkDistinctReviewerGate: vi.fn().mockReturnValue({ allowed: true }),
  checkReviewApprovalGate: vi.fn().mockReturnValue({ allowed: true }),
  distinctReviewerRejectionMessage: vi.fn().mockReturnValue("self-review"),
  checkSelfMergeGate: vi.fn().mockReturnValue({ allowed: true }),
  selfMergeRejectionMessage: vi.fn().mockReturnValue("self-merge"),
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

function makeApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", githubRouter);
  // Map thrown ConflictError/AppError to status + envelope, same as the
  // production runtime registers in app.ts.
  app.onError(appErrorHandler);
  return app;
}

const CREATE_ACTOR: Actor = {
  type: "agent",
  tokenId: "agent-1",
  teamId: "team-1",
  scopes: ["tasks:update", "github:pr_create"],
  userId: "agent-owner",
};

const MERGE_ACTOR: Actor = {
  type: "agent",
  tokenId: "agent-1",
  teamId: "team-1",
  scopes: ["tasks:transition", "github:pr_merge"],
  userId: "agent-owner",
};

const TASK_ID = "00000000-0000-0000-0000-000000000001";

function wireToolInvocationStub(): void {
  store.rows = [];
  prismaMocks.toolFindUnique.mockImplementation(async (args: {
    where: {
      projectId_verb_idempotencyKey: {
        projectId: string;
        verb: string;
        idempotencyKey: string;
      };
    };
  }) => {
    const key = args.where.projectId_verb_idempotencyKey;
    return (
      store.rows.find(
        (r) =>
          r.projectId === key.projectId &&
          r.verb === key.verb &&
          r.idempotencyKey === key.idempotencyKey,
      ) ?? null
    );
  });
  prismaMocks.toolCreate.mockImplementation(async (args: {
    data: ToolInvocationRow;
  }) => {
    const exists = store.rows.some(
      (r) =>
        r.projectId === args.data.projectId &&
        r.verb === args.data.verb &&
        r.idempotencyKey === args.data.idempotencyKey,
    );
    if (exists) {
      const { Prisma } = await import("@prisma/client");
      throw new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "test",
      });
    }
    store.rows.push(args.data);
    return args.data;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  wireToolInvocationStub();
  prismaMocks.taskFindUnique.mockResolvedValue({
    id: TASK_ID,
    projectId: "proj-1",
    status: "review",
    prNumber: 42,
    claimedByUserId: null,
    claimedByAgentId: "agent-claimant",
    reviewClaimedByUserId: null,
    reviewClaimedByAgentId: "agent-reviewer",
    project: {
      id: "proj-1",
      teamId: "team-1",
      githubRepo: "acme/thing",
      requireDistinctReviewer: false,
      soloMode: true,
    },
  });
  performPrMergeMock.mockResolvedValue({
    ok: true,
    sha: "deadbeef",
    alreadyMerged: false,
  });
  hasProjectAccessMock.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("github-route project-access gate", () => {
  it("rejects pull_requests_create with 403 when hasProjectAccess returns false", async () => {
    hasProjectAccessMock.mockResolvedValueOnce(false);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const res = await makeApp(CREATE_ACTOR).request("/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: TASK_ID,
        owner: "acme",
        repo: "thing",
        head: "feat/x",
        title: "Test",
        idempotencyKey: "k",
      }),
    });

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("rejects pull_requests_merge with 403 when hasProjectAccess returns false", async () => {
    hasProjectAccessMock.mockResolvedValueOnce(false);

    const res = await makeApp(MERGE_ACTOR).request("/pull-requests/42/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: TASK_ID,
        owner: "acme",
        repo: "thing",
        merge_method: "squash",
        idempotencyKey: "m",
      }),
    });

    expect(res.status).toBe(403);
    expect(performPrMergeMock).not.toHaveBeenCalled();
  });
});

describe("pull_requests_create idempotency", () => {
  it("retries one transient 502 and stores the successful retry once", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "GitHub is temporarily unavailable" }), {
          status: 502,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            number: 43,
            html_url: "https://github.com/acme/thing/pull/43",
            title: "Retry succeeded",
          }),
          { status: 201 },
        ),
      );

    const body = {
      taskId: TASK_ID,
      owner: "acme",
      repo: "thing",
      head: "feat/retry",
      title: "Retry succeeded",
      idempotencyKey: "retry-502",
    };
    const app = makeApp(CREATE_ACTOR);

    const first = await app.request("/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(store.rows).toHaveLength(1);
    expect(prismaMocks.taskUpdate).toHaveBeenCalledOnce();

    const replay = await app.request("/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(store.rows).toHaveLength(1);

    fetchMock.mockRestore();
  });

  it("retries one transient GraphQL failure response", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            errors: [{ type: "INTERNAL", message: "GitHub temporarily failed" }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            number: 44,
            html_url: "https://github.com/acme/thing/pull/44",
            title: "GraphQL retry succeeded",
          }),
          { status: 201 },
        ),
      );

    const res = await makeApp(CREATE_ACTOR).request("/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: TASK_ID,
        owner: "acme",
        repo: "thing",
        head: "feat/graphql-retry",
        title: "GraphQL retry succeeded",
      }),
    });

    expect(res.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    fetchMock.mockRestore();
  });

  it("surfaces the final 502 GitHub body without storing an unsuccessful result", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "first outage" }), { status: 502 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "second outage" }), { status: 502 }),
      );

    const res = await makeApp(CREATE_ACTOR).request("/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: TASK_ID,
        owner: "acme",
        repo: "thing",
        head: "feat/still-out",
        title: "Still out",
        idempotencyKey: "two-502s",
      }),
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: "github_error",
      message: "GitHub API error: second outage",
      github: { message: "second outage" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(store.rows).toHaveLength(0);
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();

    fetchMock.mockRestore();
  });

  it("preserves a non-JSON final GitHub failure body", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("first outage", { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(new Response("second outage", { status: 502 }));

    const res = await makeApp(CREATE_ACTOR).request("/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: TASK_ID,
        owner: "acme",
        repo: "thing",
        head: "feat/plain-text-outage",
        title: "Plain text outage",
      }),
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: "github_error",
      message: "GitHub API error: second outage",
      github: "second outage",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockRestore();
  });

  it("does not retry when transient-failure reconciliation cannot confirm an absent PR", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "ambiguous outage" }), { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "lookup unavailable" }), { status: 503 }));

    const res = await makeApp(CREATE_ACTOR).request("/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: TASK_ID,
        owner: "acme",
        repo: "thing",
        head: "feat/unreconciled",
        title: "Unreconciled outage",
      }),
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      message: "GitHub API error: ambiguous outage",
      github: { message: "ambiguous outage" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockRestore();
  });

  it("does not retry an ambiguous 502 when head reconciliation finds a pull request", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "upstream timeout" }), { status: 502 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              number: 46,
              html_url: "https://github.com/acme/thing/pull/46",
              title: "Created before timeout",
            },
          ]),
          { status: 200 },
        ),
      );

    const res = await makeApp(CREATE_ACTOR).request("/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: TASK_ID,
        owner: "acme",
        repo: "thing",
        head: "feat/ambiguous",
        title: "Created before timeout",
      }),
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      message: expect.stringContaining("#46 https://github.com/acme/thing/pull/46"),
      existingPullRequest: {
        number: 46,
        url: "https://github.com/acme/thing/pull/46",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.rows).toHaveLength(0);
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();

    fetchMock.mockRestore();
  });

  it("does not retry a 422 and identifies an existing head pull request", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "A pull request already exists for acme:feat/existing." }), {
          status: 422,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              number: 45,
              html_url: "https://github.com/acme/thing/pull/45",
              title: "Existing pull request",
            },
          ]),
          { status: 200 },
        ),
      );

    const res = await makeApp(CREATE_ACTOR).request("/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: TASK_ID,
        owner: "acme",
        repo: "thing",
        head: "feat/existing",
        title: "Existing pull request",
      }),
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: "github_error",
      message: expect.stringContaining("#45 https://github.com/acme/thing/pull/45"),
      github: { message: "A pull request already exists for acme:feat/existing." },
      existingPullRequest: {
        number: 45,
        url: "https://github.com/acme/thing/pull/45",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/repos/acme/thing/pulls?state=open&head=acme%3Afeat%2Fexisting",
    );
    expect(store.rows).toHaveLength(0);

    fetchMock.mockRestore();
  });

  it("does not retry a 422 with malformed GraphQL errors and finds a qualified fork head", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            errors: [null, "not-an-error", { type: "INTERNAL" }, { message: "A pull request already exists for fork-user:existing." }],
          }),
          { status: 422 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              number: 48,
              html_url: "https://github.com/acme/thing/pull/48",
            },
          ]),
          { status: 200 },
        ),
      );

    const res = await makeApp(CREATE_ACTOR).request("/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: TASK_ID,
        owner: "acme",
        repo: "thing",
        head: "fork-user:existing",
        title: "Existing fork PR",
      }),
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      existingPullRequest: {
        number: 48,
        url: "https://github.com/acme/thing/pull/48",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/repos/acme/thing/pulls?state=open&head=fork-user%3Aexisting",
    );

    fetchMock.mockRestore();
  });

  it("replays stored response on retry with same key — GitHub called once", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            number: 42,
            html_url: "https://github.com/acme/thing/pull/42",
            title: "Test",
          }),
          { status: 201 },
        ),
      );

    const body = {
      taskId: TASK_ID,
      owner: "acme",
      repo: "thing",
      head: "feat/x",
      title: "Test",
      idempotencyKey: "create-key-1",
    };
    const app = makeApp(CREATE_ACTOR);

    const first = await app.request("/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);
    const firstJson = (await first.json()) as { pullRequest: { number: number } };
    expect(firstJson.pullRequest.number).toBe(42);
    expect(first.headers.get("X-Idempotent-Replay")).toBeNull();

    const second = await app.request("/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(second.status).toBe(201);
    const secondJson = (await second.json()) as {
      pullRequest: { number: number };
      _idempotent_replay?: boolean;
    };
    expect(secondJson.pullRequest).toEqual(firstJson.pullRequest);
    // Body-level replay marker for MCP clients that don't see headers.
    expect(secondJson._idempotent_replay).toBe(true);
    // And the header for REST clients.
    expect(second.headers.get("X-Idempotent-Replay")).toBe("true");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(prismaMocks.taskUpdate).toHaveBeenCalledOnce();

    fetchMock.mockRestore();
  });

  it("without idempotencyKey, each call executes — behavior unchanged", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            number: 42,
            html_url: "https://github.com/acme/thing/pull/42",
            title: "Test",
          }),
          { status: 201 },
        ),
      );

    const body = {
      taskId: TASK_ID,
      owner: "acme",
      repo: "thing",
      head: "feat/x",
      title: "Test",
    };
    const app = makeApp(CREATE_ACTOR);

    await app.request("/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await app.request("/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.rows).toHaveLength(0);

    fetchMock.mockRestore();
  });

  it("same key with a different payload yields 409", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            number: 42,
            html_url: "https://github.com/acme/thing/pull/42",
            title: "First",
          }),
          { status: 201 },
        ),
      );

    const app = makeApp(CREATE_ACTOR);

    const first = await app.request("/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: TASK_ID,
        owner: "acme",
        repo: "thing",
        head: "feat/x",
        title: "First",
        idempotencyKey: "reused",
      }),
    });
    expect(first.status).toBe(201);

    const second = await app.request("/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: TASK_ID,
        owner: "acme",
        repo: "thing",
        head: "feat/x",
        title: "DIFFERENT", // payload divergence
        idempotencyKey: "reused",
      }),
    });
    expect(second.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledOnce();

    fetchMock.mockRestore();
  });

  it("does NOT persist a failed 422 response — the retry runs fresh", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "validation failed" }), {
          status: 422,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            number: 99,
            html_url: "https://github.com/acme/thing/pull/99",
            title: "Fixed",
          }),
          { status: 201 },
        ),
      );

    const body = {
      taskId: TASK_ID,
      owner: "acme",
      repo: "thing",
      head: "feat/x",
      title: "Test",
      idempotencyKey: "was-transient",
    };
    const app = makeApp(CREATE_ACTOR);

    const first = await app.request("/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(422);

    const second = await app.request("/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(second.status).toBe(201);

    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockRestore();
  });
});

describe("pull_requests_merge idempotency", () => {
  it("replays stored response on retry with same key — performPrMerge called once", async () => {
    const body = {
      taskId: TASK_ID,
      owner: "acme",
      repo: "thing",
      merge_method: "squash" as const,
      idempotencyKey: "merge-key-1",
    };
    const app = makeApp(MERGE_ACTOR);

    const first = await app.request("/pull-requests/42/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { merged: boolean; sha: string };
    expect(firstJson.merged).toBe(true);
    expect(firstJson.sha).toBe("deadbeef");

    const second = await app.request("/pull-requests/42/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as {
      merged: boolean;
      sha: string;
      _idempotent_replay?: boolean;
    };
    expect(secondJson.merged).toBe(firstJson.merged);
    expect(secondJson.sha).toBe(firstJson.sha);
    expect(secondJson._idempotent_replay).toBe(true);
    expect(second.headers.get("X-Idempotent-Replay")).toBe("true");

    expect(performPrMergeMock).toHaveBeenCalledOnce();
  });

  it("reusing the merge key against a different URL prNumber does NOT replay", async () => {
    // Reviewer finding: prNumber is a URL param, not in the body. Before
    // the fix it was excluded from the idempotency payload hash, so a
    // caller that reused the same key for PR 42 and then PR 99 (on a
    // task whose task.prNumber is null and falls back to the URL param)
    // would replay the first merge. After the fix, prNumber is part of
    // the hash and the second call hits the collision guard → 409.
    prismaMocks.taskFindUnique.mockResolvedValue({
      id: TASK_ID,
      projectId: "proj-1",
      status: "review",
      prNumber: null, // forces performPrMerge to fall back to URL prNumber
      claimedByUserId: null,
      claimedByAgentId: "agent-claimant",
      reviewClaimedByUserId: null,
      reviewClaimedByAgentId: "agent-reviewer",
      project: {
        id: "proj-1",
        teamId: "team-1",
        githubRepo: "acme/thing",
        requireDistinctReviewer: false,
        soloMode: true,
      },
    });

    const app = makeApp(MERGE_ACTOR);
    const shared = {
      taskId: TASK_ID,
      owner: "acme",
      repo: "thing",
      merge_method: "squash" as const,
      idempotencyKey: "reused-across-prs",
    };

    const first = await app.request("/pull-requests/42/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(shared),
    });
    expect(first.status).toBe(200);

    const second = await app.request("/pull-requests/99/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(shared),
    });
    expect(second.status).toBe(409);
  });
});
