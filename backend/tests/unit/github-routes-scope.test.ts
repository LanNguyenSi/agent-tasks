/**
 * Scope-gating tests for the GitHub-keyed PR routes.
 *
 * These routes already carry pre-existing happy-path + failure tests in
 * other files; this suite covers ONLY the new `github:pr_create` /
 * `github:pr_merge` scope enforcement that landed with the PR-lifecycle
 * feature. Keeping the tests isolated makes the scope contract easy to
 * find and hard to accidentally revert.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const prismaMocks = vi.hoisted(() => ({
  taskFindUnique: vi.fn(),
  taskUpdate: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: { findUnique: prismaMocks.taskFindUnique, update: prismaMocks.taskUpdate },
  },
}));

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/github-delegation.js", () => ({
  findDelegationUser: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/services/github-merge.js", () => ({
  performPrMerge: vi.fn().mockResolvedValue({ ok: true, sha: "abc", alreadyMerged: false }),
}));

// auth middleware loads config at import time — mock it so the test runner
// doesn't try to read DATABASE_URL / SESSION_SECRET from the real env.
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

function makeApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", githubRouter);
  return app;
}

const AGENT_NO_SCOPES: Actor = {
  type: "agent",
  tokenId: "agent-1",
  teamId: "team-1",
  scopes: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.taskFindUnique.mockResolvedValue({
    id: "task-1",
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
});

describe("github.ts scope gating", () => {
  it("POST /pull-requests rejects tokens missing github:pr_create", async () => {
    const actor: Actor = { ...AGENT_NO_SCOPES, scopes: ["tasks:update"] };
    const res = await makeApp(actor).request("/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: "00000000-0000-0000-0000-000000000001",
        owner: "acme",
        repo: "thing",
        head: "feat/x",
        title: "Test",
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toContain("github:pr_create");
  });

  it("POST /pull-requests/:n/merge rejects tokens missing github:pr_merge", async () => {
    const actor: Actor = { ...AGENT_NO_SCOPES, scopes: ["tasks:transition"] };
    const res = await makeApp(actor).request("/pull-requests/42/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: "00000000-0000-0000-0000-000000000001",
        owner: "acme",
        repo: "thing",
        merge_method: "squash",
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toContain("github:pr_merge");
  });

  it("POST /pull-requests/:n/merge still rejects tokens missing the older tasks:transition", async () => {
    // Holding only the new scope is not enough — task-side gating is still required.
    const actor: Actor = { ...AGENT_NO_SCOPES, scopes: ["github:pr_merge"] };
    const res = await makeApp(actor).request("/pull-requests/42/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: "00000000-0000-0000-0000-000000000001",
        owner: "acme",
        repo: "thing",
        merge_method: "squash",
      }),
    });
    expect(res.status).toBe(403);
  });
});
