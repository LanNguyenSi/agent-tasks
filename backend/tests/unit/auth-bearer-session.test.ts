import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    agentToken: { findUnique: vi.fn(), update: vi.fn() },
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
  },
}));

import { prisma } from "../../src/lib/prisma.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { createSessionToken } from "../../src/services/session.js";

const findUnique = prisma.agentToken.findUnique as unknown as ReturnType<typeof vi.fn>;

function buildApp() {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", authMiddleware);
  app.get("/probe", (c) => {
    const actor = c.get("actor");
    return c.json(actor);
  });
  return app;
}

describe("authMiddleware Bearer auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a valid session JWT via Bearer (human actor)", async () => {
    findUnique.mockResolvedValue(null);
    const session = await createSessionToken(
      "user-xyz",
      "test-session-secret-must-be-32chars!!",
    );

    const res = await buildApp().request("/probe", {
      headers: { Authorization: `Bearer ${session}` },
    });

    expect(res.status).toBe(200);
    const actor = (await res.json()) as { type: string; userId?: string };
    expect(actor.type).toBe("human");
    expect(actor.userId).toBe("user-xyz");
  });

  it("rejects a revoked AgentToken instead of falling through to session", async () => {
    // A token that happens to hash to an entry in AgentToken but is revoked
    // must 401 — it must NOT be reinterpreted as a session JWT.
    findUnique.mockResolvedValue({
      id: "t1",
      tokenHash: "x",
      teamId: "team-1",
      scopes: [],
      revokedAt: new Date(),
      expiresAt: null,
    });

    const res = await buildApp().request("/probe", {
      headers: { Authorization: "Bearer anything" },
    });

    expect(res.status).toBe(401);
  });

  it("rejects a garbage Bearer that is neither AgentToken nor session", async () => {
    findUnique.mockResolvedValue(null);

    const res = await buildApp().request("/probe", {
      headers: { Authorization: "Bearer not-a-real-token" },
    });

    expect(res.status).toBe(401);
  });

  it("still accepts a valid AgentToken (existing behavior unchanged)", async () => {
    findUnique.mockResolvedValue({
      id: "t1",
      tokenHash: "x",
      teamId: "team-1",
      scopes: ["read"],
      revokedAt: null,
      expiresAt: null,
    });
    (prisma.agentToken.update as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const res = await buildApp().request("/probe", {
      headers: { Authorization: "Bearer at_real_looking_token" },
    });

    expect(res.status).toBe(200);
    const actor = (await res.json()) as { type: string; tokenId?: string };
    expect(actor.type).toBe("agent");
    expect(actor.tokenId).toBe("t1");
  });
});
