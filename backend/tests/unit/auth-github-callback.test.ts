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

// Failure paths: every one redirects the browser to the frontend error page
// with a `reason` (never JSON) and clears the three transient OAuth cookies,
// as the success paths do.
describe("GET /github/callback failure redirects", () => {
  const ERROR_PAGE = "http://localhost:3000/auth/error";
  const OAUTH_COOKIE_NAMES = ["oauth_state", "oauth_intent", "oauth_connect_user"];

  function expectOAuthCookiesCleared(res: Response): void {
    const setCookies = res.headers.getSetCookie();
    for (const name of OAUTH_COOKIE_NAMES) {
      expect(setCookies.some((v) => v.startsWith(`${name}=;`) && v.includes("Max-Age=0"))).toBe(
        true,
      );
    }
    // A failed callback never sets a session.
    expect(setCookies.some((v) => v.startsWith("session="))).toBe(false);
  }

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

  it("user declines (error=access_denied, no code) → reason=access_denied, cookies cleared", async () => {
    const res = await authRouter.request(
      "/github/callback?error=access_denied&error_description=The+user+has+denied&state=STATE123",
      { headers: { Cookie: LOGIN_COOKIES } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${ERROR_PAGE}?reason=access_denied`);
    expectOAuthCookiesCleared(res);
    expect(mocks.exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("access_denied without any OAuth cookie still redirects with the reason and clears cookies", async () => {
    const res = await authRouter.request("/github/callback?error=access_denied");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${ERROR_PAGE}?reason=access_denied`);
    expectOAuthCookiesCleared(res);
  });

  it("provider error wins over a code and a valid state (no token exchange)", async () => {
    const res = await authRouter.request(
      "/github/callback?error=access_denied&code=C&state=STATE123",
      { headers: { Cookie: LOGIN_COOKIES } },
    );
    expect(res.headers.get("Location")).toBe(`${ERROR_PAGE}?reason=access_denied`);
    expect(mocks.exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("provider error is reduced to [A-Za-z0-9_-] before it reaches the Location header", async () => {
    const res = await authRouter.request(
      `/github/callback?error=${encodeURIComponent("ev!l<x>&reason=pwn")}`,
    );
    expect(res.headers.get("Location")).toBe(`${ERROR_PAGE}?reason=evlxreasonpwn`);
  });

  it("provider error is cut at 40 characters", async () => {
    const res = await authRouter.request(`/github/callback?error=${"a".repeat(80)}`);
    expect(res.headers.get("Location")).toBe(`${ERROR_PAGE}?reason=${"a".repeat(40)}`);
  });

  it("provider error with nothing left after filtering → reason=callback_failed", async () => {
    const res = await authRouter.request(`/github/callback?error=${encodeURIComponent("!<>")}`);
    expect(res.headers.get("Location")).toBe(`${ERROR_PAGE}?reason=callback_failed`);
    expectOAuthCookiesCleared(res);
  });

  it("missing code (no error) → reason=bad_request, cookies cleared, no JSON 400", async () => {
    const res = await authRouter.request("/github/callback?state=STATE123", {
      headers: { Cookie: LOGIN_COOKIES },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${ERROR_PAGE}?reason=bad_request`);
    expectOAuthCookiesCleared(res);
  });

  it("state cookie missing → reason=state_mismatch, cookies cleared, no token exchange", async () => {
    const res = await authRouter.request("/github/callback?code=C&state=STATE123");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${ERROR_PAGE}?reason=state_mismatch`);
    expectOAuthCookiesCleared(res);
    expect(mocks.exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("state in the query differs from the cookie → reason=state_mismatch, cookies cleared", async () => {
    const res = await authRouter.request("/github/callback?code=C&state=OTHER", {
      headers: { Cookie: LOGIN_COOKIES },
    });
    expect(res.headers.get("Location")).toBe(`${ERROR_PAGE}?reason=state_mismatch`);
    expectOAuthCookiesCleared(res);
    expect(mocks.exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("missing code is checked before state: no code and a bad state → bad_request", async () => {
    const res = await authRouter.request("/github/callback?state=OTHER", {
      headers: { Cookie: LOGIN_COOKIES },
    });
    expect(res.headers.get("Location")).toBe(`${ERROR_PAGE}?reason=bad_request`);
  });

  it("connect intent with a session of another user → reason=session_mismatch, nothing connected", async () => {
    mocks.verifySessionToken.mockResolvedValue({ userId: "someone-else" });
    const res = await authRouter.request("/github/callback?code=C&state=STATE123", {
      headers: { Cookie: CONNECT_COOKIES },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${ERROR_PAGE}?reason=session_mismatch`);
    expectOAuthCookiesCleared(res);
    expect(mocks.connectGitHubToExistingUser).not.toHaveBeenCalled();
  });

  it("connect intent without a session cookie → reason=session_mismatch", async () => {
    mocks.extractSessionCookie.mockReturnValue(null);
    const res = await authRouter.request("/github/callback?code=C&state=STATE123", {
      headers: { Cookie: CONNECT_COOKIES },
    });
    expect(res.headers.get("Location")).toBe(`${ERROR_PAGE}?reason=session_mismatch`);
    expectOAuthCookiesCleared(res);
  });

  it("connect intent without the connect-user cookie → reason=session_mismatch", async () => {
    const res = await authRouter.request("/github/callback?code=C&state=STATE123", {
      headers: { Cookie: "oauth_state=STATE123; oauth_intent=connect" },
    });
    expect(res.headers.get("Location")).toBe(`${ERROR_PAGE}?reason=session_mismatch`);
    expect(mocks.connectGitHubToExistingUser).not.toHaveBeenCalled();
  });

  it("token exchange throws → reason=callback_failed, cookies cleared", async () => {
    mocks.exchangeCodeForToken.mockRejectedValue(new Error("bad_verification_code"));
    const res = await authRouter.request("/github/callback?code=C&state=STATE123", {
      headers: { Cookie: LOGIN_COOKIES },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${ERROR_PAGE}?reason=callback_failed`);
    expectOAuthCookiesCleared(res);
  });

  it("user upsert throws → reason=callback_failed (no raw error text in the Location)", async () => {
    mocks.upsertUserFromGitHub.mockRejectedValue(new Error("secret db detail"));
    const res = await authRouter.request("/github/callback?code=C&state=STATE123", {
      headers: { Cookie: LOGIN_COOKIES },
    });
    expect(res.headers.get("Location")).toBe(`${ERROR_PAGE}?reason=callback_failed`);
    expectOAuthCookiesCleared(res);
  });
});
