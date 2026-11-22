/**
 * POST /projects/:id/sync: the connection check uses the same rule as
 * `/auth/me`. A stored GitHub token that cannot be read counts as not
 * connected and gets the "Connect your GitHub account" refusal; a readable
 * one (encrypted or legacy plaintext) passes. Each stored shape is its own case.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const SESSION_SECRET = "test-session-secret-must-be-32chars!!";
const PROJECT_ID = "11111111-1111-1111-1111-111111111111";

const prismaMocks = vi.hoisted(() => ({
  projectFindUnique: vi.fn(),
  projectUpdate: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: prismaMocks.projectFindUnique, update: prismaMocks.projectUpdate },
    user: { findUnique: prismaMocks.userFindUnique },
  },
}));

vi.mock("../../src/config/index.js", async (orig) => {
  const actual = await orig<typeof import("../../src/config/index.js")>();
  return { ...actual, config: { ...actual.config, SESSION_SECRET: "test-session-secret-must-be-32chars!!", GITHUB_TOKEN_ENCRYPTION_KEY: undefined } };
});

vi.mock("../../src/services/team-access.js", () => ({
  isProjectAdmin: vi.fn().mockResolvedValue(true),
  hasProjectAccess: vi.fn().mockResolvedValue(true),
  hasProjectRole: vi.fn().mockResolvedValue(true),
  getProjectMembership: vi.fn(),
  resolveTeamId: vi.fn(),
  resolveTeamIdErrorBody: vi.fn(),
}));
vi.mock("../../src/services/audit.js", () => ({ logAuditEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/board-default.js", () => ({
  ensureDefaultBoardForProject: vi.fn().mockResolvedValue(undefined),
}));

import { projectRouter } from "../../src/routes/projects.js";
import { encryptGithubToken } from "../../src/services/github-token-crypto.js";

const HUMAN: Actor = { type: "human", userId: "user-1" };
const TOKEN = "gho_realisticLookingToken0123456789";
const UNREADABLE = "v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AAAA";
const WRONG_KEY = encryptGithubToken(TOKEN, { GITHUB_TOKEN_ENCRYPTION_KEY: "some-other-key-0123456789abcdef" });
const REFUSAL = { error: "forbidden", message: "Connect your GitHub account in settings before syncing" };

function sync() {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", HUMAN);
    await next();
  });
  app.route("/", projectRouter);
  return app.request(`/projects/${PROJECT_ID}/sync`, { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.projectFindUnique.mockResolvedValue({ id: PROJECT_ID, teamId: "team-1", githubRepo: "owner/repo" });
  prismaMocks.projectUpdate.mockResolvedValue({ id: PROJECT_ID, githubSyncAt: new Date("2026-01-02T03:04:05.000Z") });
});

describe("POST /projects/:id/sync token check", () => {
  it("answers 200 for a readable encrypted token", async () => {
    prismaMocks.userFindUnique.mockResolvedValue({ githubAccessToken: encryptGithubToken(TOKEN, { SESSION_SECRET }) });
    const res = await sync();
    expect(res.status).toBe(200);
    expect(prismaMocks.projectUpdate).toHaveBeenCalledTimes(1);
  });

  it("answers 200 for a legacy plaintext token", async () => {
    prismaMocks.userFindUnique.mockResolvedValue({ githubAccessToken: TOKEN });
    expect((await sync()).status).toBe(200);
  });

  it("answers 403 for an unreadable encrypted value and does not touch the project", async () => {
    prismaMocks.userFindUnique.mockResolvedValue({ githubAccessToken: UNREADABLE });
    const res = await sync();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(REFUSAL);
    expect(prismaMocks.projectUpdate).not.toHaveBeenCalled();
  });

  it("answers 403 for a value encrypted under another key", async () => {
    prismaMocks.userFindUnique.mockResolvedValue({ githubAccessToken: WRONG_KEY });
    const res = await sync();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(REFUSAL);
  });

  it("answers 403 for a null token column", async () => {
    prismaMocks.userFindUnique.mockResolvedValue({ githubAccessToken: null });
    const res = await sync();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(REFUSAL);
  });

  it("answers 403 for a missing user row", async () => {
    prismaMocks.userFindUnique.mockResolvedValue(null);
    const res = await sync();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(REFUSAL);
  });
});
