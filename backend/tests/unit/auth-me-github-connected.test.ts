/**
 * GET /auth/me: `githubConnected` is true only for a connection the server can
 * still use. The column being set is not enough: a stored token that cannot be
 * read (the encryption key changed, or the value was tampered with) is reported
 * as not connected, the same answer the GitHub health check, the project sync
 * and the delegation lookup give for that row. Each stored shape is its own
 * case; the response never carries the token.
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
import { prisma } from "../../src/lib/prisma.js";
import { getUserById } from "../../src/services/user.js";
import { encryptGithubToken } from "../../src/services/github-token-crypto.js";

const TOKEN = "gho_realisticLookingToken0123456789";
const CONNECTED_AT = new Date("2026-01-02T03:04:05.000Z");
/** Has the `v1:` prefix and the right shape, but does not decrypt. */
const UNREADABLE = "v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AAAA";
const WRONG_KEY = encryptGithubToken(TOKEN, { GITHUB_TOKEN_ENCRYPTION_KEY: "some-other-key-0123456789abcdef" });

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

async function me(user: Record<string, unknown>) {
  vi.mocked(getUserById).mockResolvedValue(user as never);
  const res = await authRouter.request("/me", { headers: { Cookie: "session=session-token" } });
  expect(res.status).toBe(200);
  return (await res.json()) as { user: Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /auth/me githubConnected", () => {
  it("is true for a readable encrypted token", async () => {
    const { user } = await me(row({}));
    expect(user.githubConnected).toBe(true);
  });

  it("is true for a legacy plaintext token", async () => {
    const { user } = await me(row({ githubAccessToken: TOKEN }));
    expect(user.githubConnected).toBe(true);
  });

  it("is false for an unreadable encrypted value (does not decrypt)", async () => {
    const { user } = await me(row({ githubAccessToken: UNREADABLE }));
    expect(user.githubConnected).toBe(false);
  });

  it("is false for a value encrypted under another key", async () => {
    const { user } = await me(row({ githubAccessToken: WRONG_KEY }));
    expect(user.githubConnected).toBe(false);
  });

  it("is false for a null token column", async () => {
    const { user } = await me(row({ githubAccessToken: null }));
    expect(user.githubConnected).toBe(false);
  });

  it("is false for a readable token without a connection time", async () => {
    const { user } = await me(row({ githubConnectedAt: null }));
    expect(user.githubConnected).toBe(false);
  });

  it("keeps the response shape: a boolean, no token, no new field", async () => {
    const { user } = await me(row({ githubAccessToken: UNREADABLE }));
    expect(Object.keys(user).sort()).toEqual(
      ["allowAgentPrComment", "allowAgentPrCreate", "allowAgentPrMerge", "avatarUrl", "email", "githubConnected", "id", "login", "name"],
    );
  });

  it("reading an unreadable row writes nothing", async () => {
    await me(row({ githubAccessToken: UNREADABLE }));
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("reading a legacy plaintext row writes nothing either (pure response builder)", async () => {
    await me(row({ githubAccessToken: TOKEN }));
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });
});
