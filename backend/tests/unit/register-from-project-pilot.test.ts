import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("../../src/services/github-oauth.js", () => ({
  fetchGitHubUser: vi.fn(),
  buildAuthorizationUrl: vi.fn(),
  exchangeCodeForToken: vi.fn(),
  generateState: vi.fn(),
}));

vi.mock("../../src/services/github-health.js", () => ({
  getTokenHealth: vi.fn(),
}));

const { allowedLoginsMock } = vi.hoisted(() => ({
  allowedLoginsMock: [] as string[],
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
  allowedGitHubLogins: allowedLoginsMock,
}));

import { prisma } from "../../src/lib/prisma.js";
import { fetchGitHubUser } from "../../src/services/github-oauth.js";
import { authRouter } from "../../src/routes/auth.js";
import { verifySessionToken } from "../../src/services/session.js";

const mockedFetch = vi.mocked(fetchGitHubUser);
const mockedUser = vi.mocked(prisma.user);

function callEndpoint(body: unknown) {
  return authRouter.request("/register-from-project-pilot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /auth/register-from-project-pilot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when GitHub rejects the token (401 in error message)", async () => {
    mockedFetch.mockRejectedValue(new Error("GitHub user fetch failed: 401 Unauthorized"));

    const res = await callEndpoint({ githubAccessToken: "invalid" });

    expect(res.status).toBe(401);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe("unauthorized");
    expect(mockedUser.create).not.toHaveBeenCalled();
  });

  it("returns 503 when GitHub is unreachable (network error, no HTTP status)", async () => {
    mockedFetch.mockRejectedValue(new Error("fetch failed: ENOTFOUND"));

    const res = await callEndpoint({ githubAccessToken: "valid-but-offline" });

    expect(res.status).toBe(503);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe("upstream_unavailable");
    expect(mockedUser.create).not.toHaveBeenCalled();
  });

  it("returns 401 when claimed githubLogin does not match verified identity", async () => {
    mockedFetch.mockResolvedValue({
      id: 42,
      login: "actual-user",
      name: "Actual",
      avatar_url: "https://gh/u",
      email: null,
    });

    const res = await callEndpoint({
      githubAccessToken: "valid",
      githubLogin: "pretender",
    });

    expect(res.status).toBe(401);
    const payload = (await res.json()) as { message: string };
    expect(payload.message).toMatch(/does not match/i);
    expect(mockedUser.create).not.toHaveBeenCalled();
  });

  it("provisions a new user, returns a usable session token, and audits registration", async () => {
    mockedFetch.mockResolvedValue({
      id: 99,
      login: "newbie",
      name: "New",
      avatar_url: "https://gh/u",
      email: "new@example.com",
    });
    (mockedUser.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mockedUser.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "user-new",
      login: "newbie",
      email: "new@example.com",
      githubId: "99",
    });

    const res = await callEndpoint({
      githubAccessToken: "valid",
      githubLogin: "newbie",
    });

    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      apiToken: string;
      userId: string;
      githubLogin: string;
    };
    expect(payload.userId).toBe("user-new");
    expect(payload.githubLogin).toBe("newbie");
    expect(payload.apiToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);

    // The returned apiToken must round-trip through the real session verifier.
    const decoded = await verifySessionToken(
      payload.apiToken,
      "test-session-secret-must-be-32chars!!",
    );
    expect(decoded?.userId).toBe("user-new");

    // Audit trail must reflect provisioning (not a generic login).
    // Fire-and-forget — wait a microtask so the void promise can settle.
    await new Promise((r) => setImmediate(r));
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "user.registered",
          actorId: "user-new",
          payload: expect.objectContaining({
            source: "project-pilot",
            githubLogin: "newbie",
            isNewUser: true,
          }),
        }),
      }),
    );
  });

  it("is idempotent: second call for the same GitHub user returns a valid session for the same user", async () => {
    mockedFetch.mockResolvedValue({
      id: 7,
      login: "returning",
      name: "R",
      avatar_url: "",
      email: null,
    });
    (mockedUser.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "user-existing",
      login: "returning",
      githubId: "7",
    });
    (mockedUser.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "user-existing",
      login: "returning",
      githubId: "7",
    });

    const res1 = await callEndpoint({ githubAccessToken: "t1" });
    const res2 = await callEndpoint({ githubAccessToken: "t2" });

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    const p1 = (await res1.json()) as { userId: string };
    const p2 = (await res2.json()) as { userId: string };
    expect(p1.userId).toBe(p2.userId);
    // create() must NOT have been called — user already existed.
    expect(mockedUser.create).not.toHaveBeenCalled();
  });

  it("403 when ALLOWED_GITHUB_LOGINS is set and login is not in list", async () => {
    allowedLoginsMock.length = 0;
    allowedLoginsMock.push("authorized-user");

    mockedFetch.mockResolvedValue({
      id: 77,
      login: "stranger",
      name: null,
      avatar_url: "",
      email: null,
    });

    const res = await callEndpoint({ githubAccessToken: "valid" });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("forbidden_github_login");
    expect(mockedUser.create).not.toHaveBeenCalled();
    expect(mockedUser.update).not.toHaveBeenCalled();

    allowedLoginsMock.length = 0;
  });

  it("accepts when ALLOWED_GITHUB_LOGINS is set and login matches", async () => {
    allowedLoginsMock.length = 0;
    allowedLoginsMock.push("ok-user");

    mockedFetch.mockResolvedValue({
      id: 11,
      login: "ok-user",
      name: null,
      avatar_url: "",
      email: null,
    });
    (mockedUser.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mockedUser.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "user-ok",
      githubId: "11",
    });

    const res = await callEndpoint({ githubAccessToken: "valid" });

    expect(res.status).toBe(200);
    allowedLoginsMock.length = 0;
  });

  it("rejects empty access-token at validation layer", async () => {
    const res = await callEndpoint({ githubAccessToken: "" });
    expect(res.status).toBe(400);
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
