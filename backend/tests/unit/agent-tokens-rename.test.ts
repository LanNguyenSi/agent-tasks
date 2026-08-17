/**
 * Tests for PATCH /api/agent-tokens/:id (rename), added alongside
 * create/list/revoke. Prisma is mocked so the suite pins the route+service
 * contract rather than the storage layer, matching the pattern in
 * invites.test.ts.
 *
 * Covers: admin rename success (response carries new name; the update call
 * only ever touches `name`, so tokenHash/scopes/revokedAt cannot have been
 * mutated), 403 for an agent-token actor, 403 for a non-admin human, 403 for
 * an ADMIN of a *different* team (authz is team-scoped, not a global admin
 * bit), 400 on schema violations (empty / whitespace-only / >100 chars),
 * trimming behavior, and 404 for an unknown id.
 *
 * `getUserRoleInTeam` is mocked team-and-user-sensitive (see beforeEach)
 * rather than as a blanket constant, so the cross-team case actually
 * exercises the authz check instead of trivially passing.
 *
 * Also covers the `token.renamed` audit event (`prisma.auditLog.create` is
 * mocked alongside `agentToken`) carrying the old and new name.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const prismaMocks = vi.hoisted(() => ({
  agentTokenFindUnique: vi.fn(),
  agentTokenUpdate: vi.fn(),
  auditLogCreate: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    agentToken: {
      findUnique: prismaMocks.agentTokenFindUnique,
      update: prismaMocks.agentTokenUpdate,
    },
    auditLog: {
      create: prismaMocks.auditLogCreate,
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
const OTHER_TEAM_ID = "team-2";
const TOKEN_ID = "00000000-0000-0000-0000-0000000000aa";

const ADMIN: Actor = { type: "human", userId: "admin-1" };
const NON_ADMIN: Actor = { type: "human", userId: "member-1" };
const AGENT: Actor = { type: "agent", tokenId: "tok-x", teamId: TEAM_ID, scopes: [], userId: "creator-1" };
// ADMIN of team-2, not team-1 (TEAM_ID) — the team the token under test
// belongs to. Used to pin that admin-ness is per-team, not global.
const OTHER_TEAM_ADMIN: Actor = { type: "human", userId: "other-admin-1" };

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
    name: "old-name",
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
  prismaMocks.auditLogCreate.mockResolvedValue({});
  // Team-and-user-sensitive default: ADMIN is only an admin of TEAM_ID,
  // NON_ADMIN is a HUMAN_MEMBER of TEAM_ID, OTHER_TEAM_ADMIN is an admin
  // but only of OTHER_TEAM_ID. Anything else (e.g. OTHER_TEAM_ADMIN queried
  // against TEAM_ID) has no membership row and resolves null. A blanket
  // `.mockResolvedValue("ADMIN")` would make the cross-team 403 case pass
  // vacuously, so this stays argument-sensitive.
  teamAccessMocks.getUserRoleInTeam.mockImplementation((teamId: string, userId: string) => {
    if (teamId === TEAM_ID && userId === ADMIN.userId) return Promise.resolve("ADMIN");
    if (teamId === TEAM_ID && userId === NON_ADMIN.userId) return Promise.resolve("HUMAN_MEMBER");
    if (teamId === OTHER_TEAM_ID && userId === OTHER_TEAM_ADMIN.userId) return Promise.resolve("ADMIN");
    return Promise.resolve(null);
  });
});

describe("PATCH /agent-tokens/:id (rename)", () => {
  it("renames as team admin; response carries the new name; authz checked with (teamId, actorId)", async () => {
    const res = await patchRename(ADMIN, TOKEN_ID, { name: "renamed-token" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: { name: string } };
    expect(body.token.name).toBe("renamed-token");
    // Pins the exact argument order/values `canManageTeamTokens` passes
    // through to the repository — a swapped or wrong-team arg here would
    // silently authorize the wrong caller.
    expect(teamAccessMocks.getUserRoleInTeam).toHaveBeenCalledWith(TEAM_ID, ADMIN.userId);
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

  it("403s an ADMIN of a different team — admin-ness is per-team, not a global bit", async () => {
    const res = await patchRename(OTHER_TEAM_ADMIN, TOKEN_ID, { name: "nope" });
    expect(res.status).toBe(403);
    expect(prismaMocks.agentTokenUpdate).not.toHaveBeenCalled();
    // The role check must be scoped to the TOKEN's team (TEAM_ID), not the
    // caller's own team (OTHER_TEAM_ID) — this is what makes the 403 real
    // rather than an artifact of a blanket mock.
    expect(teamAccessMocks.getUserRoleInTeam).toHaveBeenCalledWith(TEAM_ID, OTHER_TEAM_ADMIN.userId);
  });

  it("400s on an empty name", async () => {
    const res = await patchRename(ADMIN, TOKEN_ID, { name: "" });
    expect(res.status).toBe(400);
    expect(prismaMocks.agentTokenUpdate).not.toHaveBeenCalled();
  });

  it("400s on a whitespace-only name (trims to empty)", async () => {
    const res = await patchRename(ADMIN, TOKEN_ID, { name: "   " });
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

  it("trims leading/trailing whitespace before storing", async () => {
    const res = await patchRename(ADMIN, TOKEN_ID, { name: "  renamed-token  " });
    expect(res.status).toBe(200);
    expect(prismaMocks.agentTokenUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: "renamed-token" } }),
    );
  });

  it("writes a token.renamed audit event carrying the old and new name", async () => {
    // beforeEach's findUnique default carries name: "old-name".
    await patchRename(ADMIN, TOKEN_ID, { name: "renamed-token" });
    expect(prismaMocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "token.renamed",
          actorId: ADMIN.userId,
          payload: { tokenId: TOKEN_ID, from: "old-name", to: "renamed-token" },
        }),
      }),
    );
  });

  it("does NOT write a token.renamed audit event when the rename is rejected (403)", async () => {
    await patchRename(AGENT, TOKEN_ID, { name: "nope" });
    expect(prismaMocks.auditLogCreate).not.toHaveBeenCalled();
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
