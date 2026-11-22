/**
 * PUT /auth/delegation: enabling any flag needs a GitHub connection the server
 * can use (same predicate as `githubConnected` in GET /auth/me); a request with
 * all three flags false is always allowed so old flags can be cleared.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const SESSION_SECRET = "test-session-secret-must-be-32chars!!";

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: { user: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), create: vi.fn() } },
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
    ALLOWED_GITHUB_LOGINS: "",
  },
  hasGitHubOAuthConfigured: true,
  allowedGitHubLogins: [] as string[],
}));

vi.mock("../../src/services/github-oauth.js", () => ({
  buildAuthorizationUrl: vi.fn(),
  exchangeCodeForToken: vi.fn(),
  fetchGitHubUser: vi.fn(),
  generateState: vi.fn(),
}));

vi.mock("../../src/services/session.js", () => ({
  createSessionToken: vi.fn().mockResolvedValue("session-token"),
  verifySessionToken: vi.fn().mockResolvedValue({ userId: "user-1" }),
  extractSessionCookie: vi.fn().mockReturnValue("session-token"),
  buildSessionCookie: vi.fn().mockReturnValue("session=token"),
  buildClearSessionCookie: vi.fn().mockReturnValue("session=; Max-Age=0"),
}));

vi.mock("../../src/services/github-health.js", () => ({ getTokenHealth: vi.fn() }));

vi.mock("../../src/services/user.js", () => ({
  upsertUserFromGitHub: vi.fn(),
  getUserById: vi.fn(),
  getUserByEmail: vi.fn(),
  createLocalUser: vi.fn(),
  connectGitHubToExistingUser: vi.fn(),
  updateUserDelegation: vi.fn(),
}));

vi.mock("../../src/services/password.js", () => ({
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
  fakeVerifyPassword: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/audit.js", () => ({ logAuditEvent: vi.fn().mockResolvedValue(undefined) }));

vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { authRouter } from "../../src/routes/auth.js";
import { getUserById, updateUserDelegation } from "../../src/services/user.js";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import { encryptGithubToken } from "../../src/services/github-token-crypto.js";

const TOKEN = "gho_realisticLookingToken0123456789";
const CONNECTED_AT = new Date("2026-01-02T03:04:05.000Z");
const UNREADABLE = "v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AAAA";

function row(overrides: Record<string, unknown>) {
  return {
    id: "user-1",
    login: "someone",
    name: "Some One",
    avatarUrl: null,
    email: "someone@example.test",
    githubConnectedAt: CONNECTED_AT,
    githubAccessToken: encryptGithubToken(TOKEN, { SESSION_SECRET }),
    allowAgentPrCreate: false,
    allowAgentPrMerge: false,
    allowAgentPrComment: false,
    ...overrides,
  };
}

const ON = { allowAgentPrCreate: true, allowAgentPrMerge: false, allowAgentPrComment: false };
const OFF = { allowAgentPrCreate: false, allowAgentPrMerge: false, allowAgentPrComment: false };

function makeApp(actor: unknown) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor as never);
    await next();
  });
  app.route("/", authRouter);
  return app;
}

const HUMAN = { type: "human", userId: "user-1" };

async function put(body: unknown, actor: unknown = HUMAN) {
  return makeApp(actor).request("/delegation", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const FORBIDDEN = {
  error: "github_not_connected",
  message: "Connect your GitHub account in settings before enabling delegation",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(updateUserDelegation).mockImplementation(
    async (_id, flags) => row({ ...flags }) as never,
  );
});

describe("PUT /auth/delegation", () => {
  it("refuses enabling when githubConnectedAt is null (403, nothing written)", async () => {
    vi.mocked(getUserById).mockResolvedValue(row({ githubConnectedAt: null }) as never);
    const res = await put(ON);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(FORBIDDEN);
    expect(updateUserDelegation).not.toHaveBeenCalled();
  });

  it("refuses enabling when there is no token (403, nothing written)", async () => {
    vi.mocked(getUserById).mockResolvedValue(row({ githubAccessToken: null }) as never);
    const res = await put({ ...OFF, allowAgentPrComment: true });
    expect(res.status).toBe(403);
    expect(updateUserDelegation).not.toHaveBeenCalled();
  });

  it("refuses enabling when the stored token does not decrypt (403, nothing written)", async () => {
    vi.mocked(getUserById).mockResolvedValue(row({ githubAccessToken: UNREADABLE }) as never);
    const res = await put({ ...OFF, allowAgentPrMerge: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(FORBIDDEN);
    expect(updateUserDelegation).not.toHaveBeenCalled();
  });

  it("allows all-false for an unconnected user", async () => {
    vi.mocked(getUserById).mockResolvedValue(row({ githubConnectedAt: null, githubAccessToken: null }) as never);
    const res = await put(OFF);
    expect(res.status).toBe(200);
    expect(updateUserDelegation).toHaveBeenCalledWith("user-1", OFF);
  });

  it("allows all-false for a user with an unreadable token", async () => {
    vi.mocked(getUserById).mockResolvedValue(row({ githubAccessToken: UNREADABLE }) as never);
    const res = await put(OFF);
    expect(res.status).toBe(200);
    expect(updateUserDelegation).toHaveBeenCalledWith("user-1", OFF);
  });

  it("allows enabling for a connected user and returns the built user", async () => {
    vi.mocked(getUserById).mockResolvedValue(row({}) as never);
    const res = await put(ON);
    expect(res.status).toBe(200);
    expect(updateUserDelegation).toHaveBeenCalledWith("user-1", ON);
    const { user } = (await res.json()) as { user: Record<string, unknown> };
    expect(user.githubConnected).toBe(true);
    expect(user.allowAgentPrCreate).toBe(true);
    expect(JSON.stringify(user)).not.toContain(TOKEN);
  });

  it("answers 401 for an agent actor (unchanged)", async () => {
    const res = await put(ON, { type: "agent", tokenId: "t-1" });
    expect(res.status).toBe(401);
    expect(updateUserDelegation).not.toHaveBeenCalled();
  });
});
