import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";

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
import { buildAuthorizationUrl, generateState } from "../../src/services/github-oauth.js";

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

function isCleared(res: Response, name: string): boolean {
  return res
    .headers.getSetCookie()
    .some((v) => v.startsWith(`${name}=;`) && v.includes("Max-Age=0"));
}

// The deep-link target (an /invite/ or /projects/ path) travels across the
// GitHub round-trip in the `oauth_redirect` cookie: set on the start request
// only for the login intent and only when valid, honoured on the callback
// only for the login intent, cleared on every exit.
describe("GitHub login carries the redirect target", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateState).mockReturnValue("STATE123");
    vi.mocked(buildAuthorizationUrl).mockReturnValue("https://github.com/login/oauth/authorize?x=1");
    mocks.exchangeCodeForToken.mockResolvedValue({ access_token: "gh-token" });
    mocks.fetchGitHubUser.mockResolvedValue({ id: 1, login: "octocat" });
    mocks.upsertUserFromGitHub.mockResolvedValue({ id: "user-1" });
    mocks.createSessionToken.mockResolvedValue("session-token");
    mocks.extractSessionCookie.mockReturnValue("session-token");
    mocks.verifySessionToken.mockResolvedValue({ userId: "user-1" });
    mocks.connectGitHubToExistingUser.mockResolvedValue(undefined);
  });

  function redirectCookie(res: Response): string | undefined {
    return res.headers.getSetCookie().find((v) => v.startsWith("oauth_redirect=") && !v.includes("Max-Age=0"));
  }

  describe("start: GET /github", () => {
    it("a valid target is stored in a short-lived HttpOnly cookie", async () => {
      const res = await authRouter.request(
        `/github?redirect=${encodeURIComponent("/projects/p1/board?view=list")}`,
      );
      expect(res.status).toBe(302);
      const cookie = redirectCookie(res);
      expect(cookie).toBe(
        `oauth_redirect=${encodeURIComponent("/projects/p1/board?view=list")}; HttpOnly; SameSite=Lax; Max-Age=600; Path=/`,
      );
    });

    it("no target: no cookie is set and a stale one is cleared", async () => {
      const res = await authRouter.request("/github");
      expect(redirectCookie(res)).toBeUndefined();
      expect(isCleared(res, "oauth_redirect")).toBe(true);
    });

    it.each([["//evil.com"], ["/etc/passwd"], ["https://evil.com"], ["/projects/p1/../x"]])(
      "an invalid target (%s) sets no cookie",
      async (value) => {
        const res = await authRouter.request(`/github?redirect=${encodeURIComponent(value)}`);
        expect(res.status).toBe(302);
        expect(redirectCookie(res)).toBeUndefined();
        expect(isCleared(res, "oauth_redirect")).toBe(true);
      },
    );

    it("the connect start never stores a target (it ignores ?redirect=)", async () => {
      const app = new Hono<{ Variables: AppVariables }>();
      app.use("*", async (c, next) => {
        c.set("actor", { type: "human", userId: "user-1" } as never);
        await next();
      });
      app.route("/", authRouter);
      const res = await app.request("/github/connect?redirect=%2Finvite%2Fabc");
      expect(res.status).toBe(302);
      expect(redirectCookie(res)).toBeUndefined();
      expect(isCleared(res, "oauth_redirect")).toBe(true);
      expect(res.headers.getSetCookie().some((v) => v.startsWith("oauth_intent=connect"))).toBe(true);
    });
  });

  describe("callback: GET /github/callback", () => {
    const callback = (cookies: string) =>
      authRouter.request("/github/callback?code=C&state=STATE123", { headers: { Cookie: cookies } });

    it("login with a valid cookie: 302 to the target, cookie cleared", async () => {
      const res = await callback(`${LOGIN_COOKIES}; oauth_redirect=${encodeURIComponent("/projects/p1/board?view=list")}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("http://localhost:3000/projects/p1/board?view=list");
      expect(isCleared(res, "oauth_redirect")).toBe(true);
      expect(res.headers.getSetCookie().some((v) => v.startsWith("session="))).toBe(true);
    });

    it("login with an /invite/ cookie: 302 to the invite", async () => {
      const res = await callback(`${LOGIN_COOKIES}; oauth_redirect=${encodeURIComponent("/invite/abc")}`);
      expect(res.headers.get("Location")).toBe("http://localhost:3000/invite/abc");
    });

    it("login without the cookie: /home", async () => {
      const res = await callback(LOGIN_COOKIES);
      expect(res.headers.get("Location")).toBe("http://localhost:3000/home");
      expect(isCleared(res, "oauth_redirect")).toBe(true);
    });

    it.each([
      ["protocol-relative", "//evil"],
      ["outside the allowlist", "/etc"],
      ["absolute URL", "https://x"],
      ["dot segment", "/projects/p1/../x"],
    ])("login with an invalid cookie value (%s): /home, cookie cleared", async (_label, value) => {
      const res = await callback(`${LOGIN_COOKIES}; oauth_redirect=${encodeURIComponent(value)}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("http://localhost:3000/home");
      expect(isCleared(res, "oauth_redirect")).toBe(true);
    });

    it("connect intent ignores the cookie and keeps /settings?github_connected=1", async () => {
      const res = await callback(`${CONNECT_COOKIES}; oauth_redirect=${encodeURIComponent("/invite/abc")}`);
      expect(res.headers.get("Location")).toBe("http://localhost:3000/settings?github_connected=1");
      expect(isCleared(res, "oauth_redirect")).toBe(true);
    });

    it("a failed login (token exchange throws) clears the cookie and lands on the error page", async () => {
      mocks.exchangeCodeForToken.mockRejectedValue(new Error("boom"));
      const res = await callback(`${LOGIN_COOKIES}; oauth_redirect=${encodeURIComponent("/invite/abc")}`);
      expect(res.headers.get("Location")).toBe("http://localhost:3000/auth/error?reason=callback_failed");
      expect(isCleared(res, "oauth_redirect")).toBe(true);
    });
  });
});

// Failure paths: every one redirects the browser to the frontend error page
// with a `reason` (never JSON) and clears the transient OAuth cookies,
// as the success paths do.
describe("GET /github/callback failure redirects", () => {
  const ERROR_PAGE = "http://localhost:3000/auth/error";
  const OAUTH_COOKIE_NAMES = ["oauth_state", "oauth_intent", "oauth_connect_user", "oauth_redirect"];

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

  it("empty provider error (?error= with no code) is not a provider error → reason=bad_request", async () => {
    const res = await authRouter.request("/github/callback?error=&state=STATE123", {
      headers: { Cookie: LOGIN_COOKIES },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${ERROR_PAGE}?reason=bad_request`);
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

// A transient cookie is browser-held, so its value is input: a truncated
// percent-escape (`%E0` opens a 3-byte UTF-8 sequence with no continuation
// byte) makes `decodeURIComponent` throw. readCookie reads such a value as
// absent, so every callback path answers exactly as it does when that cookie
// is missing: a 302 to the same target, with the same cookies cleared, never a
// 500 without a Location. One test per cookie the callback reads.
describe("GET /github/callback with a malformed cookie escape", () => {
  const ERROR_PAGE = "http://localhost:3000/auth/error";
  const OAUTH_COOKIE_NAMES = ["oauth_state", "oauth_intent", "oauth_connect_user", "oauth_redirect"];
  // `%E0` alone is the shortest malformed escape; the second form keeps a
  // decodable tail (`%2Finvite%2Fabc` = "/invite/abc") after it, so a Location
  // of /home proves nothing was taken from the cookie.
  const BAD = "%E0";
  const BAD_WITH_TAIL = "%E0%2Finvite%2Fabc";

  function expectOAuthCookiesCleared(res: Response): void {
    const setCookies = res.headers.getSetCookie();
    for (const name of OAUTH_COOKIE_NAMES) {
      expect(setCookies.some((v) => v.startsWith(`${name}=;`) && v.includes("Max-Age=0"))).toBe(
        true,
      );
    }
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

  const callback = (cookies: string, query = "?code=C&state=STATE123") =>
    authRouter.request(`/github/callback${query}`, { headers: { Cookie: cookies } });

  it("malformed oauth_state, equal query state → state_mismatch, no token exchange", async () => {
    const res = await callback(`oauth_state=${BAD}; oauth_intent=login`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${ERROR_PAGE}?reason=state_mismatch`);
    expectOAuthCookiesCleared(res);
    expect(mocks.exchangeCodeForToken).not.toHaveBeenCalled();
  });

  // The null a malformed escape yields is rejected by the presence check
  // before any comparison, so it cannot match a provider state: neither an
  // absent nor an empty query `state`.
  it.each([
    ["absent query state", "?code=C"],
    ["empty query state", "?code=C&state="],
  ])("malformed oauth_state, %s → state_mismatch", async (_label, query) => {
    const res = await callback(`oauth_state=${BAD}; oauth_intent=login`, query);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${ERROR_PAGE}?reason=state_mismatch`);
    expectOAuthCookiesCleared(res);
    expect(mocks.exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("malformed oauth_state without a code is still bad_request (guard order unchanged)", async () => {
    const res = await callback(`oauth_state=${BAD}; oauth_intent=login`, "?state=STATE123");
    expect(res.headers.get("Location")).toBe(`${ERROR_PAGE}?reason=bad_request`);
  });

  // Absent intent is the login intent, so a malformed one lands on the login
  // path: /home with a session, not the connect redirect.
  it("malformed oauth_intent → the absent-intent login path (/home)", async () => {
    const res = await callback(
      `oauth_state=STATE123; oauth_intent=${BAD}; oauth_connect_user=user-1`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("http://localhost:3000/home");
    expect(mocks.connectGitHubToExistingUser).not.toHaveBeenCalled();
    expect(res.headers.getSetCookie().some((v) => v.startsWith("session="))).toBe(true);
  });

  it("malformed oauth_connect_user → session_mismatch, nothing connected", async () => {
    const res = await callback(
      `oauth_state=STATE123; oauth_intent=connect; oauth_connect_user=${BAD}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${ERROR_PAGE}?reason=session_mismatch`);
    expectOAuthCookiesCleared(res);
    expect(mocks.connectGitHubToExistingUser).not.toHaveBeenCalled();
  });

  // A malformed redirect cookie with an otherwise valid login is the missing
  // redirect cookie: the default landing (/home), never a target read out of
  // the malformed value (whose tail would be /invite/abc).
  it("malformed oauth_redirect with a valid state → /home, cookie cleared", async () => {
    const res = await callback(`oauth_state=STATE123; oauth_intent=login; oauth_redirect=${BAD_WITH_TAIL}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("http://localhost:3000/home");
    expect(res.headers.getSetCookie().some((v) => v.startsWith("oauth_redirect=;") && v.includes("Max-Age=0"))).toBe(
      true,
    );
  });

  it("a well-formed value still decodes (no behaviour change)", async () => {
    const res = await callback(
      `oauth_state=STATE123; oauth_intent=login; oauth_redirect=${encodeURIComponent("/invite/abc")}`,
    );
    expect(res.headers.get("Location")).toBe("http://localhost:3000/invite/abc");
  });
});
