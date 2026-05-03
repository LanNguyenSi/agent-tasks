/**
 * Integration tests for the invite-endpoint surface introduced in Task 4
 * of the per-project sharing cluster.
 *
 * Covers the security-relevant edge cases: privilege escalation on
 * PROJECT_ADMIN minting, double-accept replay, expired/consumed token
 * paths, self-removal, and audit-log emission. Prisma is mocked so the
 * suite stays fast and the tests pin the route-handler contract rather
 * than the storage layer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const prismaMocks = vi.hoisted(() => ({
  projectFindUnique: vi.fn(),
  projectUpdate: vi.fn(),
  projectInviteCreate: vi.fn(),
  projectInviteFindUnique: vi.fn(),
  projectInviteFindMany: vi.fn(),
  projectInviteUpdate: vi.fn(),
  projectMemberFindUnique: vi.fn(),
  projectMemberCreate: vi.fn(),
  projectMemberDelete: vi.fn(),
  taskUpdateMany: vi.fn(),
  $transaction: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    project: {
      findUnique: prismaMocks.projectFindUnique,
      update: prismaMocks.projectUpdate,
    },
    projectInvite: {
      create: prismaMocks.projectInviteCreate,
      findUnique: prismaMocks.projectInviteFindUnique,
      findMany: prismaMocks.projectInviteFindMany,
      update: prismaMocks.projectInviteUpdate,
    },
    projectMember: {
      findUnique: prismaMocks.projectMemberFindUnique,
      create: prismaMocks.projectMemberCreate,
      delete: prismaMocks.projectMemberDelete,
    },
    task: { updateMany: prismaMocks.taskUpdateMany },
    $transaction: prismaMocks.$transaction,
  },
}));

const teamAccessMocks = vi.hoisted(() => ({
  isProjectAdmin: vi.fn(),
  hasProjectAccess: vi.fn(),
}));

vi.mock("../../src/services/team-access.js", () => ({
  isProjectAdmin: teamAccessMocks.isProjectAdmin,
  hasProjectAccess: teamAccessMocks.hasProjectAccess,
}));

const repoMocks = vi.hoisted(() => ({
  getUserRoleInTeam: vi.fn(),
}));

vi.mock("../../src/repositories/team-repository.js", () => ({
  getUserRoleInTeam: repoMocks.getUserRoleInTeam,
}));

const auditMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: auditMock,
}));

import {
  projectInviteAdminRouter,
  inviteAcceptRouter,
} from "../../src/routes/invites.js";

const PROJECT_ID = "00000000-0000-0000-0000-000000000001";
const ADMIN: Actor = { type: "human", userId: "admin-1" };
const OTHER_USER: Actor = { type: "human", userId: "user-2" };

function makeAdminApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", projectInviteAdminRouter);
  return app;
}

function makeAcceptApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", inviteAcceptRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.projectFindUnique.mockResolvedValue({
    id: PROJECT_ID,
    teamId: "team-A",
    name: "Test",
  });
  teamAccessMocks.isProjectAdmin.mockResolvedValue(true);
  teamAccessMocks.hasProjectAccess.mockResolvedValue(false);
  repoMocks.getUserRoleInTeam.mockResolvedValue("ADMIN");
});

describe("POST /projects/:id/invites", () => {
  it("creates an invite and returns the plainToken exactly once", async () => {
    prismaMocks.projectInviteCreate.mockResolvedValue({
      id: "inv-1",
      projectId: PROJECT_ID,
      role: "PROJECT_CONTRIBUTOR",
      createdById: ADMIN.userId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      consumedAt: null,
      consumedById: null,
      createdAt: new Date(),
    });

    const res = await makeAdminApp(ADMIN).request(`/projects/${PROJECT_ID}/invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "PROJECT_CONTRIBUTOR" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { invite: { id: string }; plainToken: string };
    expect(body.invite.id).toBe("inv-1");
    expect(body.plainToken).toMatch(/^inv_[0-9a-f]+$/);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "project.invite_created" }));
  });

  it("rejects PROJECT_ADMIN minting from a non-team-ADMIN (privilege escalation guard)", async () => {
    repoMocks.getUserRoleInTeam.mockResolvedValue("HUMAN_MEMBER");

    const res = await makeAdminApp(ADMIN).request(`/projects/${PROJECT_ID}/invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "PROJECT_ADMIN" }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/team admin/i);
    expect(prismaMocks.projectInviteCreate).not.toHaveBeenCalled();
  });

  it("403s when the caller is not project-admin", async () => {
    teamAccessMocks.isProjectAdmin.mockResolvedValue(false);
    const res = await makeAdminApp(ADMIN).request(`/projects/${PROJECT_ID}/invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "PROJECT_CONTRIBUTOR" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /projects/:id/invites", () => {
  it("lists invites with status markers", async () => {
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    prismaMocks.projectInviteFindMany.mockResolvedValue([
      { id: "i-pending", projectId: PROJECT_ID, role: "PROJECT_VIEWER", createdById: "u", expiresAt: future, consumedAt: null, consumedById: null, createdAt: new Date() },
      { id: "i-expired", projectId: PROJECT_ID, role: "PROJECT_VIEWER", createdById: "u", expiresAt: past, consumedAt: null, consumedById: null, createdAt: new Date() },
      { id: "i-consumed", projectId: PROJECT_ID, role: "PROJECT_VIEWER", createdById: "u", expiresAt: future, consumedAt: new Date(), consumedById: "u2", createdAt: new Date() },
    ]);

    const res = await makeAdminApp(ADMIN).request(`/projects/${PROJECT_ID}/invites`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invites: Array<{ id: string; status: string }> };
    expect(body.invites.find((i) => i.id === "i-pending")?.status).toBe("pending");
    expect(body.invites.find((i) => i.id === "i-expired")?.status).toBe("expired");
    expect(body.invites.find((i) => i.id === "i-consumed")?.status).toBe("consumed");
  });
});

describe("DELETE /projects/:id/invites/:inviteId", () => {
  it("revokes a pending invite by setting expiresAt to now", async () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    prismaMocks.projectInviteFindUnique.mockResolvedValue({
      id: "inv-1",
      projectId: PROJECT_ID,
      consumedAt: null,
      expiresAt: future,
    });

    const res = await makeAdminApp(ADMIN).request(
      `/projects/${PROJECT_ID}/invites/inv-1`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    expect(prismaMocks.projectInviteUpdate).toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "project.invite_revoked" }));
  });

  it("404s when the invite belongs to a different project", async () => {
    prismaMocks.projectInviteFindUnique.mockResolvedValue({
      id: "inv-x",
      projectId: "OTHER_PROJECT",
      consumedAt: null,
      expiresAt: new Date(Date.now() + 1000),
    });
    const res = await makeAdminApp(ADMIN).request(
      `/projects/${PROJECT_ID}/invites/inv-x`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /preview", () => {
  it("returns preview for a valid pending token", async () => {
    prismaMocks.projectInviteFindUnique.mockResolvedValue({
      id: "i-ok",
      role: "PROJECT_CONTRIBUTOR",
      consumedAt: null,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      project: { id: PROJECT_ID, name: "Test", slug: "test", teamId: "team-A" },
      createdBy: { login: "owner-login" },
    });

    const res = await makeAcceptApp(ADMIN).request("/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "inv_abcdef" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { preview: { ownerLogin: string; role: string } };
    expect(body.preview.ownerLogin).toBe("owner-login");
    expect(body.preview.role).toBe("PROJECT_CONTRIBUTOR");
  });

  it("400s on consumed token", async () => {
    prismaMocks.projectInviteFindUnique.mockResolvedValue({
      id: "i-c",
      role: "PROJECT_VIEWER",
      consumedAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
      project: { id: PROJECT_ID, name: "T", slug: "t", teamId: "team-A" },
      createdBy: { login: "x" },
    });
    const res = await makeAcceptApp(ADMIN).request("/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "inv_c" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("consumed");
  });

  it("400s on expired token", async () => {
    prismaMocks.projectInviteFindUnique.mockResolvedValue({
      id: "i-e",
      role: "PROJECT_VIEWER",
      consumedAt: null,
      expiresAt: new Date(Date.now() - 1000),
      project: { id: PROJECT_ID, name: "T", slug: "t", teamId: "team-A" },
      createdBy: { login: "x" },
    });
    const res = await makeAcceptApp(ADMIN).request("/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "inv_e" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("expired");
  });

  it("400s on unknown token", async () => {
    prismaMocks.projectInviteFindUnique.mockResolvedValue(null);
    const res = await makeAcceptApp(ADMIN).request("/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "inv_unknown" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /accept", () => {
  it("creates a ProjectMember and consumes the invite in a transaction", async () => {
    prismaMocks.projectInviteFindUnique.mockResolvedValue({
      id: "i-1",
      projectId: PROJECT_ID,
      role: "PROJECT_VIEWER",
      createdById: "owner",
      consumedAt: null,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    prismaMocks.$transaction.mockResolvedValue([{}, {}]);
    // Default for non-flip tests: project was already non-solo.
    prismaMocks.projectFindUnique.mockResolvedValue({
      soloMode: false,
      _count: { projectMembers: 5 },
    });

    const res = await makeAcceptApp(OTHER_USER).request("/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "inv_x" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { soloModeChanged: boolean };
    expect(body.soloModeChanged).toBe(false);
    expect(prismaMocks.$transaction).toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "project.invite_consumed" }));
    expect(prismaMocks.projectUpdate).not.toHaveBeenCalled();
  });

  it("flips soloMode off when the first ProjectMember accepts", async () => {
    prismaMocks.projectInviteFindUnique.mockResolvedValue({
      id: "i-flip",
      projectId: PROJECT_ID,
      role: "PROJECT_CONTRIBUTOR",
      createdById: "owner",
      consumedAt: null,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    prismaMocks.$transaction.mockResolvedValue([{}, {}]);
    // After the transaction the count is exactly 1 (the first member
    // just got created); soloMode was true.
    prismaMocks.projectFindUnique.mockResolvedValue({
      soloMode: true,
      _count: { projectMembers: 1 },
    });
    prismaMocks.projectUpdate.mockResolvedValue({});

    const res = await makeAcceptApp(OTHER_USER).request("/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "inv_flip" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { soloModeChanged: boolean };
    expect(body.soloModeChanged).toBe(true);
    expect(prismaMocks.projectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          soloMode: false,
          requireDistinctReviewer: true,
          governanceMode: "REQUIRES_DISTINCT_REVIEWER",
        }),
      }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "project.solo_mode_disabled_by_share" }),
    );
  });

  it("does NOT flip soloMode on subsequent invites (idempotent)", async () => {
    prismaMocks.projectInviteFindUnique.mockResolvedValue({
      id: "i-2nd",
      projectId: PROJECT_ID,
      role: "PROJECT_VIEWER",
      createdById: "owner",
      consumedAt: null,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    prismaMocks.$transaction.mockResolvedValue([{}, {}]);
    // Second member joins; soloMode was already turned off by the first.
    prismaMocks.projectFindUnique.mockResolvedValue({
      soloMode: false,
      _count: { projectMembers: 2 },
    });

    const res = await makeAcceptApp(OTHER_USER).request("/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "inv_2nd" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { soloModeChanged: boolean };
    expect(body.soloModeChanged).toBe(false);
    expect(prismaMocks.projectUpdate).not.toHaveBeenCalled();
  });

  it("409s when the user already has access", async () => {
    prismaMocks.projectInviteFindUnique.mockResolvedValue({
      id: "i-2",
      projectId: PROJECT_ID,
      role: "PROJECT_VIEWER",
      createdById: "owner",
      consumedAt: null,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    teamAccessMocks.hasProjectAccess.mockResolvedValue(true);

    const res = await makeAcceptApp(OTHER_USER).request("/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "inv_y" }),
    });

    expect(res.status).toBe(409);
    expect(prismaMocks.$transaction).not.toHaveBeenCalled();
  });

  it("409s on a P2002 race (user gained access between hasProjectAccess and $transaction)", async () => {
    prismaMocks.projectInviteFindUnique.mockResolvedValue({
      id: "i-3",
      projectId: PROJECT_ID,
      role: "PROJECT_VIEWER",
      createdById: "owner",
      consumedAt: null,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    const { Prisma } = await import("@prisma/client");
    prismaMocks.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "5.22.0",
      }),
    );

    const res = await makeAcceptApp(OTHER_USER).request("/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "inv_race" }),
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("already_member");
  });
});

describe("DELETE /projects/:id/members/:userId", () => {
  it("permits self-removal even without admin", async () => {
    teamAccessMocks.isProjectAdmin.mockResolvedValue(false);
    prismaMocks.projectMemberFindUnique.mockResolvedValue({
      id: "m-1",
      role: "PROJECT_VIEWER",
      userId: ADMIN.userId,
    });
    prismaMocks.taskUpdateMany.mockResolvedValue({ count: 0 });

    const res = await makeAdminApp(ADMIN).request(
      `/projects/${PROJECT_ID}/members/${ADMIN.userId}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    expect(prismaMocks.projectMemberDelete).toHaveBeenCalled();
  });

  it("auto-releases active claims on removal", async () => {
    prismaMocks.projectMemberFindUnique.mockResolvedValue({
      id: "m-2",
      role: "PROJECT_CONTRIBUTOR",
      userId: "u-removed",
    });
    prismaMocks.taskUpdateMany.mockResolvedValue({ count: 3 });

    const res = await makeAdminApp(ADMIN).request(
      `/projects/${PROJECT_ID}/members/u-removed`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { claimsReleased: number };
    expect(body.claimsReleased).toBe(3);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "project.member_removed",
        payload: expect.objectContaining({ claimsReleased: 3, selfRemoval: false }),
      }),
    );
  });

  it("403s a non-admin trying to remove someone else", async () => {
    teamAccessMocks.isProjectAdmin.mockResolvedValue(false);
    prismaMocks.projectMemberFindUnique.mockResolvedValue({
      id: "m-3",
      role: "PROJECT_VIEWER",
      userId: "u-other",
    });
    const res = await makeAdminApp(ADMIN).request(
      `/projects/${PROJECT_ID}/members/u-other`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(403);
    expect(prismaMocks.projectMemberDelete).not.toHaveBeenCalled();
  });
});
