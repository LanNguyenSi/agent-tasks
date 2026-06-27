/**
 * M4 — login must not be a user-enumeration timing oracle.
 *
 * The login handler returns 401 for both "no such user" and "wrong password".
 * The no-user branch must still pay the scrypt cost (via fakeVerifyPassword)
 * so an attacker cannot distinguish a registered email by response time. These
 * tests assert the wiring: which KDF call fires on which branch.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
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
  verifySessionToken: vi.fn(),
  extractSessionCookie: vi.fn(),
  buildSessionCookie: vi.fn().mockReturnValue("session=token"),
  buildClearSessionCookie: vi.fn().mockReturnValue("session=; Max-Age=0"),
}));

vi.mock("../../src/services/github-health.js", () => ({
  getTokenHealth: vi.fn(),
}));

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

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { authRouter } from "../../src/routes/auth.js";
import { getUserByEmail } from "../../src/services/user.js";
import { fakeVerifyPassword, verifyPassword } from "../../src/services/password.js";

const mockedGetUser = vi.mocked(getUserByEmail);
const mockedFake = vi.mocked(fakeVerifyPassword);
const mockedVerify = vi.mocked(verifyPassword);

function login(body: unknown) {
  return authRouter.request("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /auth/login — timing equalization (M4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("unknown email: 401, pays the KDF cost via fakeVerifyPassword, never calls verifyPassword", async () => {
    mockedGetUser.mockResolvedValue(null);

    const res = await login({ email: "nobody@example.com", password: "secret123" });

    expect(res.status).toBe(401);
    expect(mockedFake).toHaveBeenCalledWith("secret123");
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it("known email + wrong password: verifyPassword runs, fakeVerifyPassword does not", async () => {
    mockedGetUser.mockResolvedValue({
      id: "user-1",
      email: "real@example.com",
      passwordHash: "salt:digest",
      name: "Real User",
    } as Awaited<ReturnType<typeof getUserByEmail>>);
    mockedVerify.mockResolvedValue(false);

    const res = await login({ email: "real@example.com", password: "wrong-pass" });

    expect(res.status).toBe(401);
    expect(mockedVerify).toHaveBeenCalled();
    expect(mockedFake).not.toHaveBeenCalled();
  });
});
