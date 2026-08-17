/**
 * Tests for PATCH /api/agent-tokens/:id (rename), added alongside
 * create/list/revoke. Prisma is mocked so the suite pins the route+service
 * contract rather than the storage layer, matching the pattern in
 * invites.test.ts.
 *
 * Covers: admin rename success (response carries new name; the update call
 * only ever touches `name`, so tokenHash/scopes/revokedAt cannot have been
 * mutated), 403 for an agent-token actor, 403 for a non-admin human, 400 on
 * schema violations (empty / >100 chars), and 404 for an unknown id.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const prismaMocks = vi.hoisted(() => ({
  agentTokenFindUnique: vi.fn(),
  agentTokenUpdate: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    agentToken: {
      findUnique: prismaMocks.agentTokenFindUnique,
      update: prismaMocks.agentTokenUpdate,
    },
  },
}));

const teamAccessMocks = vi.hoisted(() => ({
  getUserRoleInTeam: vi.fn(),
}));

vi.mock("../../src/repositories/team-repository.js", () => ({
  getUserRoleInTeam: teamAccessMocks.getUserRoleInTeam,
}));

vi.mock("../../src/config/index.js", () => ({
  config: {
    NODE_ENV: "test",
    SESSION_SECRET: "test-session-secret-must-be-32chars!!",
    GITHUB_CLIENT_ID: "",
    GITHUB_CLIENT_SECRET: "",
    FRONTEND_URL: "http://localhost:3000",
    CORS_ORIGINS: "http://localhost:3000",
    PORT: 3001,
    DATABASE_URL: "postgresql://test:test@localhost/test",
  },
}));

import { agentTokenRouter } from "../../src/routes/agent-tokens.js";

const TEAM_ID = "team-1";
const TOKEN_ID = "00000000-0000-0000-0000-0000000000aa";

const ADMIN: Actor = { type: "human", userId: "admin-1" };
const NON_ADMIN: Actor = { type: "human", userId: "member-1" };
const AGENT: Actor = { type: "agent", tokenId: "tok-x", teamId: TEAM_ID, scopes: [], userId: "creator-1" };

function makeApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", agentTokenRouter);
  return app;
}

function patchRename(actor: Actor, id: string, body: unknown) {
  return makeApp(actor).request(`/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.agentTokenFindUnique.mockResolvedValue({
    id: TOKEN_ID,
    teamId: TEAM_ID,
    revokedAt: null,
  });
  prismaMocks.agentTokenUpdate.mockResolvedValue({
    id: TOKEN_ID,
    name: "renamed-token",
    scopes: ["tasks:read"],
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
  });
  teamAccessMocks.getUserRoleInTeam.mockResolvedValue("ADMIN");
});

describe("PATCH /agent-tokens/:id (rename)", () => {
  it("renames as team admin; response carries the new name", async () => {
    const res = await patchRename(ADMIN, TOKEN_ID, { name: "renamed-token" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: { name: string } };
    expect(body.token.name).toBe("renamed-token");
  });

  it("only mutates `name` in the update call — tokenHash/scopes/revokedAt untouched", async () => {
    await patchRename(ADMIN, TOKEN_ID, { name: "renamed-token" });
    expect(prismaMocks.agentTokenUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TOKEN_ID },
        data: { name: "renamed-token" },
      }),
    );
    const call = prismaMocks.agentTokenUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(Object.keys(call.data)).toEqual(["name"]);
  });

  it("allows renaming a revoked token (display metadata, not an access control)", async () => {
    prismaMocks.agentTokenFindUnique.mockResolvedValue({
      id: TOKEN_ID,
      teamId: TEAM_ID,
      revokedAt: new Date("2026-08-01T00:00:00Z"),
    });
    const res = await patchRename(ADMIN, TOKEN_ID, { name: "renamed-after-revoke" });
    expect(res.status).toBe(200);
    expect(prismaMocks.agentTokenUpdate).toHaveBeenCalled();
  });

  it("403s an agent-token actor", async () => {
    const res = await patchRename(AGENT, TOKEN_ID, { name: "nope" });
    expect(res.status).toBe(403);
    expect(prismaMocks.agentTokenUpdate).not.toHaveBeenCalled();
  });

  it("403s a non-admin human (HUMAN_MEMBER)", async () => {
    teamAccessMocks.getUserRoleInTeam.mockResolvedValue("HUMAN_MEMBER");
    const res = await patchRename(NON_ADMIN, TOKEN_ID, { name: "nope" });
    expect(res.status).toBe(403);
    expect(prismaMocks.agentTokenUpdate).not.toHaveBeenCalled();
  });

  it("403s a human with no role in the token's team", async () => {
    teamAccessMocks.getUserRoleInTeam.mockResolvedValue(null);
    const res = await patchRename(NON_ADMIN, TOKEN_ID, { name: "nope" });
    expect(res.status).toBe(403);
    expect(prismaMocks.agentTokenUpdate).not.toHaveBeenCalled();
  });

  it("400s on an empty name", async () => {
    const res = await patchRename(ADMIN, TOKEN_ID, { name: "" });
    expect(res.status).toBe(400);
    expect(prismaMocks.agentTokenUpdate).not.toHaveBeenCalled();
  });

  it("400s on a name over 100 chars", async () => {
    const res = await patchRename(ADMIN, TOKEN_ID, { name: "x".repeat(101) });
    expect(res.status).toBe(400);
    expect(prismaMocks.agentTokenUpdate).not.toHaveBeenCalled();
  });

  it("accepts a name at exactly the 100-char boundary", async () => {
    const res = await patchRename(ADMIN, TOKEN_ID, { name: "x".repeat(100) });
    expect(res.status).toBe(200);
  });

  it("404s on an unknown id", async () => {
    prismaMocks.agentTokenFindUnique.mockResolvedValue(null);
    const res = await patchRename(ADMIN, "unknown-id", { name: "whatever" });
    expect(res.status).toBe(404);
    expect(prismaMocks.agentTokenUpdate).not.toHaveBeenCalled();
  });

  it("404s before the 403 check would apply — unknown id wins even for a non-admin caller", async () => {
    prismaMocks.agentTokenFindUnique.mockResolvedValue(null);
    teamAccessMocks.getUserRoleInTeam.mockResolvedValue("HUMAN_MEMBER");
    const res = await patchRename(NON_ADMIN, "unknown-id", { name: "whatever" });
    expect(res.status).toBe(404);
  });
});
