/**
 * Route-level tests for GET /api/auth/github/health against the REAL
 * `createApp()` (same wiring-proof pattern as auth-session-cookie-app.test.ts:
 * well-formed-but-fake DATABASE_URL/SESSION_SECRET before importing app.js,
 * restored afterwards).
 *
 * The handler reads `c.get("actor")` and 401s for a missing or non-human
 * actor, so it only works when `app.ts` mounts `authMiddleware` on its
 * exact path. Before the mount existed, every caller (including a logged-in
 * Settings page) got the middleware-less handler 401 and the "Reconnect
 * GitHub" prompt could never render.
 *
 * `getTokenHealth` (the GitHub/rate-limit side) is mocked; the 200 case
 * asserts its passthrough shape. No case runs a real query: the prisma mock
 * answers the only DB lookup reached (the Bearer agent-token branch).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";

const prismaMocks = vi.hoisted(() => ({
  agentTokenFindUnique: vi.fn(),
  agentTokenUpdate: vi.fn().mockResolvedValue(undefined),
  getTokenHealth: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    agentToken: {
      findUnique: prismaMocks.agentTokenFindUnique,
      update: prismaMocks.agentTokenUpdate,
    },
  },
}));

vi.mock("../../src/services/github-health.js", () => ({
  getTokenHealth: prismaMocks.getTokenHealth,
}));

const PREVIOUS_DATABASE_URL = process.env.DATABASE_URL;
const PREVIOUS_SESSION_SECRET = process.env.SESSION_SECRET;
// Same value beforeAll sets, so a token signed with it verifies against
// the config this process loaded at import time.
const SESSION_SECRET = "y".repeat(32);

let createApp: (corsOrigins: string) => Hono<{ Variables: AppVariables }>;
let createSessionToken: (userId: string, secret: string) => Promise<string>;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgresql://fake:fake@localhost:5432/fake";
  process.env.SESSION_SECRET = SESSION_SECRET;
  ({ createApp } = await import("../../src/app.js"));
  ({ createSessionToken } = await import("../../src/services/session.js"));
});

afterAll(() => {
  if (PREVIOUS_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = PREVIOUS_DATABASE_URL;
  if (PREVIOUS_SESSION_SECRET === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = PREVIOUS_SESSION_SECRET;
});

function app() {
  return createApp("http://localhost:3000");
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.agentTokenFindUnique.mockResolvedValue(null);
  prismaMocks.getTokenHealth.mockResolvedValue({
    state: "healthy",
    lastCheckedAt: new Date("2026-01-02T03:04:05.000Z"),
  });
});

describe("GET /api/auth/github/health against the real createApp()", () => {
  it("answers 200 with { state, lastCheckedAt } for a valid session cookie, probing that user", async () => {
    const token = await createSessionToken("user-health-1", SESSION_SECRET);

    const res = await app().request("/api/auth/github/health", {
      headers: { Cookie: `session=${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      state: "healthy",
      lastCheckedAt: "2026-01-02T03:04:05.000Z",
    });
    expect(prismaMocks.getTokenHealth).toHaveBeenCalledWith("user-health-1");
  });

  it("answers 200 with a null lastCheckedAt when the health was never checked", async () => {
    prismaMocks.getTokenHealth.mockResolvedValue({ state: "unchecked", lastCheckedAt: null });
    const token = await createSessionToken("user-health-2", SESSION_SECRET);

    const res = await app().request("/api/auth/github/health", {
      headers: { Cookie: `session=${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "unchecked", lastCheckedAt: null });
  });

  it("answers 401 with no cookie (authMiddleware, before the handler)", async () => {
    const res = await app().request("/api/auth/github/health");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "unauthorized",
      message: "Authentication required",
    });
    expect(prismaMocks.getTokenHealth).not.toHaveBeenCalled();
  });

  it("answers 401 for an AgentToken bearer (human only): middleware sets an agent actor, the handler refuses, no health probe", async () => {
    prismaMocks.agentTokenFindUnique.mockResolvedValue({
      id: "tok-1",
      teamId: "team-1",
      scopes: ["tasks:read"],
      createdById: "owner-1",
      revokedAt: null,
      expiresAt: null,
    });

    const res = await app().request("/api/auth/github/health", {
      headers: { Authorization: "Bearer agent-token-not-a-session-jwt" },
    });

    // The middleware's AgentToken branch ran (its DB lookup was reached),
    // so this 401 is the handler's non-human refusal, not "no credentials".
    expect(prismaMocks.agentTokenFindUnique).toHaveBeenCalled();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "unauthorized",
      message: "Authentication required",
    });
    expect(prismaMocks.getTokenHealth).not.toHaveBeenCalled();
  });
});
