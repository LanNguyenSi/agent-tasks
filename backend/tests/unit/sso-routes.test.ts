/**
 * Route-layer tests for backend/src/routes/sso.ts
 *
 * Exercises ssoLoginRouter and ssoAdminRouter via Hono's .request() method —
 * no real server, no DB, no network. All service, prisma, config, and oidc
 * imports are vi.mock()'d. The sibling sso-crypto.test.ts and oidc.test.ts
 * cover the service layer; this file covers what happens at the route level.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock function references ──────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  // prisma
  agentTokenFindUnique: vi.fn(),
  agentTokenUpdate: vi.fn(),
  teamFindUnique: vi.fn(),
  // oidc service
  discover: vi.fn(),
  exchangeCode: vi.fn(),
  verifyIdToken: vi.fn(),
  buildAuthorizeUrl: vi.fn(),
  generatePkcePair: vi.fn(),
  invalidateDiscovery: vi.fn(),
  randomToken: vi.fn(),
  // sso service
  findSsoConnectionForEmail: vi.fn(),
  getSsoConnectionByTeamSlug: vi.fn(),
  getSsoConnectionByTeamId: vi.fn(),
  decryptClientSecret: vi.fn(),
  upsertUserFromOidc: vi.fn(),
  upsertSsoConnection: vi.fn(),
  deleteSsoConnection: vi.fn(),
  publicSsoConnection: vi.fn(),
  // session service
  createSessionToken: vi.fn(),
  buildSessionCookie: vi.fn(),
}));

// ── Module mocks ───────────────────────────────────────────────────────────────
// All mocks must be declared before any import of the code under test.

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    agentToken: {
      findUnique: mocks.agentTokenFindUnique,
      update: mocks.agentTokenUpdate,
    },
    team: {
      findUnique: mocks.teamFindUnique,
    },
  },
}));

vi.mock("../../src/config/index.js", () => ({
  config: {
    NODE_ENV: "test",
    BACKEND_URL: "http://localhost:3001",
    FRONTEND_URL: "http://localhost:3000",
    SESSION_SECRET: "test-session-secret-must-be-32chars!!",
    SSO_ENCRYPTION_KEY: "key",
  },
}));

vi.mock("../../src/services/oidc.js", () => ({
  discover: mocks.discover,
  exchangeCode: mocks.exchangeCode,
  verifyIdToken: mocks.verifyIdToken,
  buildAuthorizeUrl: mocks.buildAuthorizeUrl,
  generatePkcePair: mocks.generatePkcePair,
  invalidateDiscovery: mocks.invalidateDiscovery,
  randomToken: mocks.randomToken,
}));

vi.mock("../../src/services/sso.js", () => ({
  findSsoConnectionForEmail: mocks.findSsoConnectionForEmail,
  getSsoConnectionByTeamSlug: mocks.getSsoConnectionByTeamSlug,
  getSsoConnectionByTeamId: mocks.getSsoConnectionByTeamId,
  decryptClientSecret: mocks.decryptClientSecret,
  upsertUserFromOidc: mocks.upsertUserFromOidc,
  upsertSsoConnection: mocks.upsertSsoConnection,
  deleteSsoConnection: mocks.deleteSsoConnection,
  publicSsoConnection: mocks.publicSsoConnection,
}));

vi.mock("../../src/services/session.js", () => ({
  createSessionToken: mocks.createSessionToken,
  buildSessionCookie: mocks.buildSessionCookie,
}));

vi.mock("../../src/lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// ── Import routers AFTER mocks (vi.mock is hoisted, but make it explicit) ─────

import { config } from "../../src/config/index.js";
import { hashToken } from "../../src/middleware/auth.js";
import { ssoLoginRouter, ssoAdminRouter } from "../../src/routes/sso.js";

// ── Shared fixtures ────────────────────────────────────────────────────────────

const TEAM_ID = "team-1";
const TEAM_ID_OTHER = "team-other";
const RAW_TOKEN = "test-sso-admin-token";

/** A fully valid AgentToken record for team-1 with sso:admin scope. */
const VALID_TOKEN = {
  id: "tok-1",
  teamId: TEAM_ID,
  scopes: ["sso:admin"],
  revokedAt: null,
  expiresAt: null,
  createdById: "user-1",
};

/** An enabled SSO connection for team-1. */
const ENABLED_CONNECTION = {
  id: "sso-1",
  teamId: TEAM_ID,
  issuer: "https://idp.example.com",
  clientId: "client-id",
  clientSecretEnc: "enc-secret",
  enabled: true,
  autoProvision: true,
  emailDomains: ["example.com"],
  displayName: "Acme SSO",
  team: { slug: "acme", name: "Acme Corp" },
};

/** Minimal discovery result returned by the mocked discover(). */
const MOCK_DISCOVERY = {
  discovery: {
    issuer: "https://idp.example.com",
    authorization_endpoint: "https://idp.example.com/auth",
    token_endpoint: "https://idp.example.com/token",
    jwks_uri: "https://idp.example.com/jwks",
  },
  jwks: [{ kid: "k1" }],
};

/**
 * Cookie header that satisfies all callback guards when the URL slug is "acme"
 * and the state query param is "STATE123".
 */
const GOOD_COOKIES = "sso_state=STATE123; sso_nonce=NONCE456; sso_team=acme; sso_pkce=PKCE789";

// ── beforeEach: reset all mocks and establish safe defaults ───────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Default: a valid token that passes every guard check.
  mocks.agentTokenFindUnique.mockResolvedValue(VALID_TOKEN);
  mocks.agentTokenUpdate.mockResolvedValue({});

  // Default: team exists.
  mocks.teamFindUnique.mockResolvedValue({ id: TEAM_ID, name: "Acme", slug: "acme" });

  // Default: no prior SSO connection.
  mocks.getSsoConnectionByTeamId.mockResolvedValue(null);
  mocks.publicSsoConnection.mockReturnValue({ id: "sso-1", displayName: "Acme SSO" });

  // Default session helpers.
  mocks.createSessionToken.mockResolvedValue("session-tok-abc");
  mocks.buildSessionCookie.mockReturnValue(
    "session=session-tok-abc; HttpOnly; SameSite=Lax; Max-Age=604800; Path=/",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// ssoAdminGuard — the authz core
// Drive via GET /teams/:teamId/sso (simplest admin endpoint).
// ─────────────────────────────────────────────────────────────────────────────

describe("ssoAdminGuard", () => {
  /** Send a GET to the admin team-SSO endpoint with an optional Authorization header. */
  function adminGet(teamId: string, authHeader?: string) {
    const headers: Record<string, string> = {};
    if (authHeader !== undefined) headers["Authorization"] = authHeader;
    return ssoAdminRouter.request(`/teams/${teamId}/sso`, { headers });
  }

  it("no Authorization header → 401", async () => {
    const res = await adminGet(TEAM_ID);
    expect(res.status).toBe(401);
  });

  it("header not starting with 'Bearer ' → 401", async () => {
    const res = await adminGet(TEAM_ID, "Basic dXNlcjpwYXNz");
    expect(res.status).toBe(401);
  });

  it("'Bearer ' prefix with only whitespace token → 401", async () => {
    const res = await adminGet(TEAM_ID, "Bearer   ");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("token not found (findUnique → null) → 401", async () => {
    mocks.agentTokenFindUnique.mockResolvedValue(null);
    const res = await adminGet(TEAM_ID, `Bearer ${RAW_TOKEN}`);
    expect(res.status).toBe(401);
  });

  it("token revoked (revokedAt set) → 401", async () => {
    mocks.agentTokenFindUnique.mockResolvedValue({
      ...VALID_TOKEN,
      revokedAt: new Date("2020-01-01T00:00:00Z"),
    });
    const res = await adminGet(TEAM_ID, `Bearer ${RAW_TOKEN}`);
    expect(res.status).toBe(401);
  });

  it("token expired (expiresAt in the past) → 401", async () => {
    mocks.agentTokenFindUnique.mockResolvedValue({
      ...VALID_TOKEN,
      expiresAt: new Date("2020-01-01T00:00:00Z"),
    });
    const res = await adminGet(TEAM_ID, `Bearer ${RAW_TOKEN}`);
    expect(res.status).toBe(401);
  });

  it("token present but without sso:admin scope → 403", async () => {
    mocks.agentTokenFindUnique.mockResolvedValue({
      ...VALID_TOKEN,
      scopes: ["tasks:read", "tasks:write"],
    });
    const res = await adminGet(TEAM_ID, `Bearer ${RAW_TOKEN}`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toContain("sso:admin");
  });

  it("cross-team: token.teamId=team-1 rejected on /teams/team-other/sso → 403", async () => {
    // VALID_TOKEN.teamId is TEAM_ID ("team-1"); URL targets TEAM_ID_OTHER.
    // Removing the `token.teamId !== urlTeamId` check would make this 200.
    mocks.agentTokenFindUnique.mockResolvedValue(VALID_TOKEN);
    const res = await adminGet(TEAM_ID_OTHER, `Bearer ${RAW_TOKEN}`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toContain("belong to this team");
  });

  it("valid token with sso:admin + matching teamId → 200 and lastUsedAt stamped", async () => {
    // Default mocks already set VALID_TOKEN and team. This should reach the handler.
    const res = await adminGet(TEAM_ID, `Bearer ${RAW_TOKEN}`);
    expect(res.status).toBe(200);
    // Lookup MUST be by the hashed token, never the raw bearer (hashed-at-rest):
    // querying by the raw token would defeat the at-rest design.
    expect(mocks.agentTokenFindUnique).toHaveBeenCalledWith({
      where: { tokenHash: hashToken(RAW_TOKEN) },
    });
    expect(mocks.agentTokenUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: VALID_TOKEN.id },
        data: expect.objectContaining({ lastUsedAt: expect.any(Date) }),
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /sso/discover
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /sso/discover", () => {
  it("no email query param → { connection: null } without calling findSsoConnectionForEmail", async () => {
    const res = await ssoLoginRouter.request("/sso/discover");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connection: unknown };
    expect(body.connection).toBeNull();
    expect(mocks.findSsoConnectionForEmail).not.toHaveBeenCalled();
  });

  it("email with no match (service returns null) → { connection: null }", async () => {
    mocks.findSsoConnectionForEmail.mockResolvedValue(null);
    const res = await ssoLoginRouter.request("/sso/discover?email=nobody%40nowhere.com");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connection: unknown };
    expect(body.connection).toBeNull();
    expect(mocks.findSsoConnectionForEmail).toHaveBeenCalledWith("nobody@nowhere.com");
  });

  it("email match → returns connection with teamSlug, loginUrl, teamName, displayName", async () => {
    mocks.findSsoConnectionForEmail.mockResolvedValue({
      displayName: "Acme SSO",
      team: { slug: "acme", name: "Acme Corp" },
    });
    const res = await ssoLoginRouter.request("/sso/discover?email=user%40acme.com");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connection: {
        teamSlug: string;
        teamName: string;
        displayName: string;
        loginUrl: string;
      };
    };
    expect(body.connection).not.toBeNull();
    expect(body.connection.teamSlug).toBe("acme");
    expect(body.connection.teamName).toBe("Acme Corp");
    expect(body.connection.displayName).toBe("Acme SSO");
    expect(body.connection.loginUrl).toBe("/api/auth/sso/acme");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /sso/:teamSlug — authorize
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /sso/:teamSlug (authorize)", () => {
  it("connection missing (getSsoConnectionByTeamSlug returns null) → 404", async () => {
    mocks.getSsoConnectionByTeamSlug.mockResolvedValue(null);
    const res = await ssoLoginRouter.request("/sso/acme");
    expect(res.status).toBe(404);
  });

  it("connection exists but enabled=false → 404", async () => {
    mocks.getSsoConnectionByTeamSlug.mockResolvedValue({
      connection: { ...ENABLED_CONNECTION, enabled: false },
    });
    const res = await ssoLoginRouter.request("/sso/acme");
    expect(res.status).toBe(404);
  });

  it("happy path: 302 redirect to IdP URL with all four transient cookies (HttpOnly + SameSite=Lax)", async () => {
    mocks.getSsoConnectionByTeamSlug.mockResolvedValue({ connection: ENABLED_CONNECTION });
    mocks.discover.mockResolvedValue(MOCK_DISCOVERY);
    mocks.randomToken
      .mockReturnValueOnce("state-abc-123")
      .mockReturnValueOnce("nonce-def-456");
    mocks.generatePkcePair.mockResolvedValue({
      verifier: "pkce-verifier-xyz",
      challenge: "pkce-challenge-xyz",
    });
    mocks.buildAuthorizeUrl.mockReturnValue(
      "https://idp.example.com/auth?response_type=code&client_id=client-id&state=state-abc-123",
    );

    const res = await ssoLoginRouter.request("/sso/acme");
    expect(res.status).toBe(302);

    const location = res.headers.get("Location");
    expect(location).toBe(
      "https://idp.example.com/auth?response_type=code&client_id=client-id&state=state-abc-123",
    );

    // Verify buildAuthorizeUrl was called with the right PKCE + state args.
    expect(mocks.buildAuthorizeUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "state-abc-123",
        nonce: "nonce-def-456",
        codeChallenge: "pkce-challenge-xyz",
        clientId: ENABLED_CONNECTION.clientId,
      }),
    );

    const cookies = res.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThanOrEqual(4);

    const byName = (name: string) => cookies.find((c) => c.startsWith(`${name}=`));

    const stateC = byName("sso_state");
    const nonceC = byName("sso_nonce");
    const teamC = byName("sso_team");
    const pkceC = byName("sso_pkce");

    expect(stateC).toBeDefined();
    expect(nonceC).toBeDefined();
    expect(teamC).toBeDefined();
    expect(pkceC).toBeDefined();

    for (const c of [stateC, nonceC, teamC, pkceC]) {
      expect(c).toContain("HttpOnly");
      expect(c).toContain("SameSite=Lax");
      // In test env (NODE_ENV=test, not production) Secure must NOT be appended.
      expect(c).not.toContain("Secure");
    }
  });

  it("production env: transient cookies carry the Secure flag", async () => {
    mocks.getSsoConnectionByTeamSlug.mockResolvedValue({ connection: ENABLED_CONNECTION });
    mocks.discover.mockResolvedValue(MOCK_DISCOVERY);
    mocks.randomToken.mockReturnValueOnce("state-abc-123").mockReturnValueOnce("nonce-def-456");
    mocks.generatePkcePair.mockResolvedValue({ verifier: "v", challenge: "ch" });
    mocks.buildAuthorizeUrl.mockReturnValue("https://idp.example.com/auth?response_type=code");

    const prevEnv = config.NODE_ENV;
    config.NODE_ENV = "production";
    try {
      const res = await ssoLoginRouter.request("/sso/acme");
      const cookies = res.headers.getSetCookie();
      const stateC = cookies.find((c) => c.startsWith("sso_state="));
      expect(stateC).toContain("Secure");
    } finally {
      config.NODE_ENV = prevEnv;
    }
  });

  it("discover throws → 302 redirect to FRONTEND_URL/auth/error?reason=sso_unavailable", async () => {
    mocks.getSsoConnectionByTeamSlug.mockResolvedValue({ connection: ENABLED_CONNECTION });
    mocks.discover.mockRejectedValue(new Error("OIDC endpoint unreachable"));

    const res = await ssoLoginRouter.request("/sso/acme");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "http://localhost:3000/auth/error?reason=sso_unavailable",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /sso/:teamSlug/callback
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /sso/:teamSlug/callback", () => {
  it("?error=access_denied from IdP → redirect to /auth/error?reason=access_denied", async () => {
    const res = await ssoLoginRouter.request(
      "/sso/acme/callback?error=access_denied&code=ignored&state=ignored",
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain("/auth/error?reason=access_denied");
  });

  it("IdP error sanitized: ev!l<x> stripped to safe charset only", async () => {
    // The route applies /[^a-zA-Z0-9_-]/g replace before forwarding.
    const res = await ssoLoginRouter.request(
      "/sso/acme/callback?error=ev!l%3Cx%3E&code=x&state=s",
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    const reason = new URL(loc).searchParams.get("reason") ?? "";
    expect(reason).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(reason).not.toContain("!");
    expect(reason).not.toContain("<");
    expect(reason).not.toContain(">");
  });

  it("missing code query param → redirect reason=bad_request", async () => {
    // Has state and valid cookies, but no code.
    const res = await ssoLoginRouter.request("/sso/acme/callback?state=STATE123", {
      headers: { Cookie: GOOD_COOKIES },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "http://localhost:3000/auth/error?reason=bad_request",
    );
  });

  it("missing Cookie header (no stored state) → redirect reason=bad_request", async () => {
    // code and state are present but no cookies at all.
    const res = await ssoLoginRouter.request(
      "/sso/acme/callback?code=C&state=STATE123",
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "http://localhost:3000/auth/error?reason=bad_request",
    );
  });

  it("state mismatch: query state != cookie sso_state → reason=state_mismatch (CSRF guard)", async () => {
    // Removing the `state !== storedState` check would make this pass through.
    const res = await ssoLoginRouter.request(
      "/sso/acme/callback?code=C&state=WRONG_STATE",
      { headers: { Cookie: GOOD_COOKIES } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "http://localhost:3000/auth/error?reason=state_mismatch",
    );
  });

  it("sso_team cookie != URL teamSlug → reason=state_mismatch", async () => {
    // GOOD_COOKIES has sso_team=acme; request goes to /sso/other-team/callback.
    const res = await ssoLoginRouter.request(
      "/sso/other-team/callback?code=C&state=STATE123",
      { headers: { Cookie: GOOD_COOKIES } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "http://localhost:3000/auth/error?reason=state_mismatch",
    );
  });

  it("connection disabled at callback time → reason=sso_not_configured", async () => {
    mocks.getSsoConnectionByTeamSlug.mockResolvedValue({
      connection: { ...ENABLED_CONNECTION, enabled: false },
    });
    const res = await ssoLoginRouter.request(
      "/sso/acme/callback?code=C&state=STATE123",
      { headers: { Cookie: GOOD_COOKIES } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "http://localhost:3000/auth/error?reason=sso_not_configured",
    );
  });

  it("happy path: session cookie set, transient cookies cleared, redirect to /teams", async () => {
    mocks.getSsoConnectionByTeamSlug.mockResolvedValue({ connection: ENABLED_CONNECTION });
    mocks.discover.mockResolvedValue(MOCK_DISCOVERY);
    mocks.decryptClientSecret.mockResolvedValue("client-secret-plain");
    mocks.exchangeCode.mockResolvedValue({
      id_token: "id-token-value",
      access_token: "access-token-value",
    });
    mocks.verifyIdToken.mockResolvedValue({
      sub: "oidc-user-123",
      email: "user@acme.com",
      iss: "https://idp.example.com",
    });
    mocks.upsertUserFromOidc.mockResolvedValue({ id: "db-user-id-1" });

    const res = await ssoLoginRouter.request(
      "/sso/acme/callback?code=AUTH_CODE&state=STATE123",
      { headers: { Cookie: GOOD_COOKIES } },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("http://localhost:3000/teams");

    // createSessionToken was called with the DB user id and the session secret.
    expect(mocks.createSessionToken).toHaveBeenCalledWith(
      "db-user-id-1",
      expect.any(String),
    );

    const cookies = res.headers.getSetCookie();

    // Session cookie must be present.
    const sessionCookie = cookies.find((c) => c.startsWith("session="));
    expect(sessionCookie).toBeDefined();

    // All four transient cookies must be CLEARED (Max-Age=0).
    const transientNames = ["sso_state", "sso_nonce", "sso_team", "sso_pkce"];
    for (const name of transientNames) {
      const cleared = cookies.find(
        (c) => c.startsWith(`${name}=`) && c.includes("Max-Age=0"),
      );
      expect(cleared, `${name} should be cleared with Max-Age=0`).toBeDefined();
    }
  });

  it("upsertUserFromOidc returns null → reason=not_provisioned", async () => {
    mocks.getSsoConnectionByTeamSlug.mockResolvedValue({ connection: ENABLED_CONNECTION });
    mocks.discover.mockResolvedValue(MOCK_DISCOVERY);
    mocks.decryptClientSecret.mockResolvedValue("secret");
    mocks.exchangeCode.mockResolvedValue({ id_token: "idtok" });
    mocks.verifyIdToken.mockResolvedValue({ sub: "u1", email: "u@e.com" });
    mocks.upsertUserFromOidc.mockResolvedValue(null);

    const res = await ssoLoginRouter.request(
      "/sso/acme/callback?code=C&state=STATE123",
      { headers: { Cookie: GOOD_COOKIES } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "http://localhost:3000/auth/error?reason=not_provisioned",
    );
  });

  it("exchangeCode throws → reason=sso_failed; raw error text not leaked in Location", async () => {
    mocks.getSsoConnectionByTeamSlug.mockResolvedValue({ connection: ENABLED_CONNECTION });
    mocks.discover.mockResolvedValue(MOCK_DISCOVERY);
    mocks.decryptClientSecret.mockResolvedValue("secret");
    mocks.exchangeCode.mockRejectedValue(new Error("SUPER_SENSITIVE_TOKEN_DATA_INTERNAL"));

    const res = await ssoLoginRouter.request(
      "/sso/acme/callback?code=C&state=STATE123",
      { headers: { Cookie: GOOD_COOKIES } },
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toBe("http://localhost:3000/auth/error?reason=sso_failed");
    expect(loc).not.toContain("SUPER_SENSITIVE");
    expect(loc).not.toContain("INTERNAL");
  });

  it("verifyIdToken throws → reason=sso_failed; raw error text not leaked in Location", async () => {
    mocks.getSsoConnectionByTeamSlug.mockResolvedValue({ connection: ENABLED_CONNECTION });
    mocks.discover.mockResolvedValue(MOCK_DISCOVERY);
    mocks.decryptClientSecret.mockResolvedValue("secret");
    mocks.exchangeCode.mockResolvedValue({ id_token: "idtok" });
    mocks.verifyIdToken.mockRejectedValue(new Error("nonce mismatch CONFIDENTIAL_NONCE_VALUE"));

    const res = await ssoLoginRouter.request(
      "/sso/acme/callback?code=C&state=STATE123",
      { headers: { Cookie: GOOD_COOKIES } },
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toBe("http://localhost:3000/auth/error?reason=sso_failed");
    expect(loc).not.toContain("CONFIDENTIAL_NONCE_VALUE");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /teams/:teamId/sso
// ─────────────────────────────────────────────────────────────────────────────

const VALID_UPSERT_BODY = {
  displayName: "Acme SSO",
  issuer: "https://idp.example.com",
  clientId: "client-abc",
  clientSecret: "super-secret",
  emailDomains: ["acme.com"],
  autoProvision: true,
  enabled: true,
};

/** Send an admin PUT to /teams/:teamId/sso with a valid Bearer token and body. */
function adminPut(teamId: string, body: object) {
  return ssoAdminRouter.request(`/teams/${teamId}/sso`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${RAW_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("PUT /teams/:teamId/sso", () => {
  it("team not found → 404", async () => {
    mocks.teamFindUnique.mockResolvedValue(null);
    const res = await adminPut(TEAM_ID, VALID_UPSERT_BODY);
    expect(res.status).toBe(404);
  });

  it("SSO_ENCRYPTION_KEY empty → 503 not_configured (live config mutation + restore)", async () => {
    // The route reads config.SSO_ENCRYPTION_KEY at call time, so we can mutate
    // the live mocked object. Restore afterwards to avoid bleed into other tests.
    const originalKey = (config as Record<string, unknown>).SSO_ENCRYPTION_KEY;
    (config as Record<string, unknown>).SSO_ENCRYPTION_KEY = "";
    try {
      const res = await adminPut(TEAM_ID, VALID_UPSERT_BODY);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("not_configured");
    } finally {
      (config as Record<string, unknown>).SSO_ENCRYPTION_KEY = originalKey;
    }
  });

  it("discover throws → 400 invalid_issuer", async () => {
    mocks.discover.mockRejectedValue(new Error("discovery failed: 404 Not Found"));
    const res = await adminPut(TEAM_ID, VALID_UPSERT_BODY);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_issuer");
  });

  it("happy path: 200, upsertSsoConnection called, invalidateDiscovery called for new issuer", async () => {
    const savedConn = { id: "sso-saved", teamId: TEAM_ID, ...VALID_UPSERT_BODY };
    mocks.discover.mockResolvedValue(MOCK_DISCOVERY);
    mocks.getSsoConnectionByTeamId.mockResolvedValue(null); // no prior connection
    mocks.upsertSsoConnection.mockResolvedValue(savedConn);
    mocks.publicSsoConnection.mockReturnValue({ id: "sso-saved", displayName: "Acme SSO" });

    const res = await adminPut(TEAM_ID, VALID_UPSERT_BODY);
    expect(res.status).toBe(200);

    expect(mocks.upsertSsoConnection).toHaveBeenCalledWith(
      TEAM_ID,
      expect.objectContaining({ displayName: "Acme SSO", issuer: "https://idp.example.com" }),
    );
    expect(mocks.invalidateDiscovery).toHaveBeenCalledWith("https://idp.example.com");

    const body = (await res.json()) as { connection: { id: string } };
    expect(body.connection).toBeDefined();
    expect(body.connection.id).toBe("sso-saved");
  });

  it("issuer change: invalidateDiscovery called for BOTH old and new issuer", async () => {
    const priorConn = {
      ...ENABLED_CONNECTION,
      issuer: "https://old-idp.example.com",
    };
    mocks.getSsoConnectionByTeamId.mockResolvedValue(priorConn);
    mocks.discover.mockResolvedValue(MOCK_DISCOVERY);
    mocks.upsertSsoConnection.mockResolvedValue({ id: "sso-1" });
    mocks.publicSsoConnection.mockReturnValue({ id: "sso-1" });

    // Body has a NEW issuer — the route should invalidate the OLD issuer first.
    await adminPut(TEAM_ID, VALID_UPSERT_BODY);

    expect(mocks.invalidateDiscovery).toHaveBeenCalledWith("https://old-idp.example.com");
    expect(mocks.invalidateDiscovery).toHaveBeenCalledWith("https://idp.example.com");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /teams/:teamId/sso
// ─────────────────────────────────────────────────────────────────────────────

/** Send an admin DELETE to /teams/:teamId/sso with a valid Bearer token. */
function adminDelete(teamId: string) {
  return ssoAdminRouter.request(`/teams/${teamId}/sso`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${RAW_TOKEN}` },
  });
}

describe("DELETE /teams/:teamId/sso", () => {
  it("team not found → 404", async () => {
    mocks.teamFindUnique.mockResolvedValue(null);
    const res = await adminDelete(TEAM_ID);
    expect(res.status).toBe(404);
  });

  it("happy path: deleteSsoConnection called and invalidateDiscovery called when prior connection existed", async () => {
    mocks.getSsoConnectionByTeamId.mockResolvedValue(ENABLED_CONNECTION);
    mocks.deleteSsoConnection.mockResolvedValue(undefined);

    const res = await adminDelete(TEAM_ID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    expect(mocks.deleteSsoConnection).toHaveBeenCalledWith(TEAM_ID);
    expect(mocks.invalidateDiscovery).toHaveBeenCalledWith(ENABLED_CONNECTION.issuer);
  });

  it("no prior connection: deleteSsoConnection still called but invalidateDiscovery is NOT called", async () => {
    mocks.getSsoConnectionByTeamId.mockResolvedValue(null);
    mocks.deleteSsoConnection.mockResolvedValue(undefined);

    const res = await adminDelete(TEAM_ID);
    expect(res.status).toBe(200);

    expect(mocks.deleteSsoConnection).toHaveBeenCalledWith(TEAM_ID);
    expect(mocks.invalidateDiscovery).not.toHaveBeenCalled();
  });
});
