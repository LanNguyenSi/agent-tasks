import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exchangeCodeForToken: vi.fn(),
  fetchGitHubUser: vi.fn(),
  upsertUserFromGitHub: vi.fn(),
  connectGitHubToExistingUser: vi.fn(),
  createSessionToken: vi.fn(),
  verifySessionToken: vi.fn(),
  extractSessionCookie: vi.fn(),
}));

vi.mock("../../src/config/index.js", () => ({
  config: {
    NODE_ENV: "test",
    SESSION_SECRET: "test-session-secret-must-be-32chars!!",
    GITHUB_CLIENT_ID: "test-id",
    GITHUB_CLIENT_SECRET: "test-secret",
    FRONTEND_URL: "http://localhost:3000",
  },
  hasGitHubOAuthConfigured: true,
  allowedGitHubLogins: [],
}));

vi.mock("../../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../src/services/audit.js", () => ({ logAuditEvent: vi.fn() }));
vi.mock("../../src/services/github-health.js", () => ({ getTokenHealth: vi.fn() }));
vi.mock("../../src/services/password.js", () => ({
  fakeVerifyPassword: vi.fn(),
  verifyPassword: vi.fn(),
}));

vi.mock("../../src/services/github-oauth.js", () => ({
  buildAuthorizationUrl: vi.fn(),
  generateState: vi.fn(),
  exchangeCodeForToken: mocks.exchangeCodeForToken,
  fetchGitHubUser: mocks.fetchGitHubUser,
}));

vi.mock("../../src/services/session.js", () => ({
  createSessionToken: mocks.createSessionToken,
  verifySessionToken: mocks.verifySessionToken,
  extractSessionCookie: mocks.extractSessionCookie,
  buildSessionCookie: () => "session=tok; HttpOnly",
  buildClearSessionCookie: () => "session=; Max-Age=0",
}));

vi.mock("../../src/services/user.js", () => ({
  upsertUserFromGitHub: mocks.upsertUserFromGitHub,
  connectGitHubToExistingUser: mocks.connectGitHubToExistingUser,
  getUserById: vi.fn(),
  getUserByEmail: vi.fn(),
  createLocalUser: vi.fn(),
  updateUserDelegation: vi.fn(),
}));

import { authRouter } from "../../src/routes/auth.js";

const LOGIN_COOKIES = "oauth_state=STATE123; oauth_intent=login";
const CONNECT_COOKIES = "oauth_state=STATE123; oauth_intent=connect; oauth_connect_user=user-1";

describe("GET /github/callback redirect targets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exchangeCodeForToken.mockResolvedValue({ access_token: "gh-token" });
    mocks.fetchGitHubUser.mockResolvedValue({ id: 1, login: "octocat" });
    mocks.upsertUserFromGitHub.mockResolvedValue({ id: "user-1" });
    mocks.createSessionToken.mockResolvedValue("session-token");
    mocks.extractSessionCookie.mockReturnValue("session-token");
    mocks.verifySessionToken.mockResolvedValue({ userId: "user-1" });
    mocks.connectGitHubToExistingUser.mockResolvedValue(undefined);
  });

  it("login success redirects to /home", async () => {
    const res = await authRouter.request("/github/callback?code=C&state=STATE123", {
      headers: { Cookie: LOGIN_COOKIES },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("http://localhost:3000/home");
  });

  it("connect success still redirects to /settings?github_connected=1", async () => {
    const res = await authRouter.request("/github/callback?code=C&state=STATE123", {
      headers: { Cookie: CONNECT_COOKIES },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "http://localhost:3000/settings?github_connected=1",
    );
  });
});
