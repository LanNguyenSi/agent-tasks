/**
 * PATCH /teams/:id (rename a team after creation).
 *
 * Prisma is mocked, matching teams.test.ts and agent-tokens-rename.test.ts:
 * the suite pins the route contract, not the storage layer.
 *
 * Covers the access ladder in the order the handler applies it (agent 403,
 * unknown team 404, non-member 403, member without ADMIN 403, ADMIN 200),
 * per-team admin-ness (an ADMIN of another team is not an admin here),
 * validation (empty, whitespace-only, 101 chars, exactly 100, trimmed value
 * stored), that only the display name is written (slug untouched), and the
 * audit event with the old and new name.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const prismaMocks = vi.hoisted(() => ({
  teamFindUnique: vi.fn(),
  teamUpdate: vi.fn(),
  teamMemberFindUnique: vi.fn(),
}));
const auditMocks = vi.hoisted(() => ({ logAuditEvent: vi.fn() }));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    team: { findUnique: prismaMocks.teamFindUnique, update: prismaMocks.teamUpdate },
    teamMember: { findUnique: prismaMocks.teamMemberFindUnique },
  },
}));

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: auditMocks.logAuditEvent,
}));

import { teamRouter } from "../../src/routes/teams.js";

const TEAM_ID = "team-1";
const OTHER_TEAM_ID = "team-2";

const ADMIN: Actor = { type: "human", userId: "admin-1" };
const MEMBER: Actor = { type: "human", userId: "member-1" };
const REVIEWER: Actor = { type: "human", userId: "reviewer-1" };
const OUTSIDER: Actor = { type: "human", userId: "outsider-1" };
// ADMIN of team-2 only: admin-ness is per team, not a global bit.
const OTHER_TEAM_ADMIN: Actor = { type: "human", userId: "other-admin-1" };
const AGENT: Actor = { type: "agent", tokenId: "tok-x", teamId: TEAM_ID, scopes: [], userId: "creator-1" };

function makeApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", teamRouter);
  return app;
}

function patchTeam(actor: Actor, id: string, body: unknown) {
  return makeApp(actor).request(`/teams/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.teamFindUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(
      where.id === TEAM_ID || where.id === OTHER_TEAM_ID
        ? { id: where.id, name: "Old Name", slug: "old-slug", createdAt: new Date("2026-01-01T00:00:00Z") }
        : null,
    ),
  );
  // Team-and-user-sensitive: a blanket "ADMIN" would make the cross-team
  // case pass vacuously.
  prismaMocks.teamMemberFindUnique.mockImplementation(
    ({ where }: { where: { teamId_userId: { teamId: string; userId: string } } }) => {
      const { teamId, userId } = where.teamId_userId;
      const roles: Record<string, Record<string, string>> = {
        [TEAM_ID]: { [ADMIN.userId]: "ADMIN", [MEMBER.userId]: "HUMAN_MEMBER", [REVIEWER.userId]: "REVIEWER" },
        [OTHER_TEAM_ID]: { [OTHER_TEAM_ADMIN.userId]: "ADMIN" },
      };
      const role = roles[teamId]?.[userId];
      return Promise.resolve(role ? { teamId, userId, role } : null);
    },
  );
  prismaMocks.teamUpdate.mockImplementation(({ where, data }: { where: { id: string }; data: { name: string } }) =>
    Promise.resolve({
      id: where.id,
      name: data.name,
      slug: "old-slug",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    }),
  );
  auditMocks.logAuditEvent.mockResolvedValue(undefined);
});

describe("PATCH /teams/:id: access", () => {
  it("renames as team ADMIN and returns { team } with the new name", async () => {
    const res = await patchTeam(ADMIN, TEAM_ID, { name: "New Name" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { team: { id: string; name: string; slug: string } };
    expect(body.team).toMatchObject({ id: TEAM_ID, name: "New Name", slug: "old-slug" });
    expect(prismaMocks.teamUpdate).toHaveBeenCalledTimes(1);
    // The membership lookup is scoped to this team and this caller.
    expect(prismaMocks.teamMemberFindUnique).toHaveBeenCalledWith({
      where: { teamId_userId: { teamId: TEAM_ID, userId: ADMIN.userId } },
    });
  });

  it("403s an agent-token actor without touching the database", async () => {
    const res = await patchTeam(AGENT, TEAM_ID, { name: "Nope" });
    expect(res.status).toBe(403);
    expect(prismaMocks.teamFindUnique).not.toHaveBeenCalled();
    expect(prismaMocks.teamUpdate).not.toHaveBeenCalled();
    expect(auditMocks.logAuditEvent).not.toHaveBeenCalled();
  });

  it("404s an unknown team (even for a caller who is not a member of anything)", async () => {
    const res = await patchTeam(OUTSIDER, "no-such-team", { name: "Nope" });
    expect(res.status).toBe(404);
    expect(prismaMocks.teamUpdate).not.toHaveBeenCalled();
  });

  it("403s a human who is not a member of the team", async () => {
    const res = await patchTeam(OUTSIDER, TEAM_ID, { name: "Nope" });
    expect(res.status).toBe(403);
    expect(prismaMocks.teamUpdate).not.toHaveBeenCalled();
    expect(auditMocks.logAuditEvent).not.toHaveBeenCalled();
  });

  it("403s a HUMAN_MEMBER with the admin-only message", async () => {
    const res = await patchTeam(MEMBER, TEAM_ID, { name: "Nope" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toMatch(/Only team admins/);
    expect(prismaMocks.teamUpdate).not.toHaveBeenCalled();
    expect(auditMocks.logAuditEvent).not.toHaveBeenCalled();
  });

  it("403s a REVIEWER (only ADMIN may rename)", async () => {
    const res = await patchTeam(REVIEWER, TEAM_ID, { name: "Nope" });
    expect(res.status).toBe(403);
    expect(prismaMocks.teamUpdate).not.toHaveBeenCalled();
  });

  it("403s an ADMIN of a different team", async () => {
    const res = await patchTeam(OTHER_TEAM_ADMIN, TEAM_ID, { name: "Nope" });
    expect(res.status).toBe(403);
    expect(prismaMocks.teamUpdate).not.toHaveBeenCalled();
    expect(prismaMocks.teamMemberFindUnique).toHaveBeenCalledWith({
      where: { teamId_userId: { teamId: TEAM_ID, userId: OTHER_TEAM_ADMIN.userId } },
    });
  });
});

describe("PATCH /teams/:id: validation", () => {
  it("400s on an empty name", async () => {
    const res = await patchTeam(ADMIN, TEAM_ID, { name: "" });
    expect(res.status).toBe(400);
    expect(prismaMocks.teamUpdate).not.toHaveBeenCalled();
  });

  it("400s on a whitespace-only name (trims to empty)", async () => {
    const res = await patchTeam(ADMIN, TEAM_ID, { name: "   \t " });
    expect(res.status).toBe(400);
    expect(prismaMocks.teamUpdate).not.toHaveBeenCalled();
  });

  it("400s on a missing name and on a non-string name", async () => {
    expect((await patchTeam(ADMIN, TEAM_ID, {})).status).toBe(400);
    expect((await patchTeam(ADMIN, TEAM_ID, { name: 42 })).status).toBe(400);
    expect(prismaMocks.teamUpdate).not.toHaveBeenCalled();
  });

  it("400s on a 101-character name", async () => {
    const res = await patchTeam(ADMIN, TEAM_ID, { name: "x".repeat(101) });
    expect(res.status).toBe(400);
    expect(prismaMocks.teamUpdate).not.toHaveBeenCalled();
  });

  it("accepts a name of exactly 100 characters", async () => {
    const res = await patchTeam(ADMIN, TEAM_ID, { name: "x".repeat(100) });
    expect(res.status).toBe(200);
  });

  it("trims the name before it is stored and returned", async () => {
    const res = await patchTeam(ADMIN, TEAM_ID, { name: "  New Name \n" });
    expect(res.status).toBe(200);
    expect(prismaMocks.teamUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: "New Name" } }),
    );
    const body = (await res.json()) as { team: { name: string } };
    expect(body.team.name).toBe("New Name");
  });

  it("measures the 100-character limit after trimming", async () => {
    const res = await patchTeam(ADMIN, TEAM_ID, { name: ` ${"x".repeat(100)} ` });
    expect(res.status).toBe(200);
    expect(prismaMocks.teamUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: "x".repeat(100) } }),
    );
  });
});

describe("PATCH /teams/:id: what is written", () => {
  it("writes only the name: the slug (and everything else) is left alone", async () => {
    // A body that tries to carry a slug must not reach the update either.
    const res = await patchTeam(ADMIN, TEAM_ID, { name: "New Name", slug: "hijacked" });
    expect(res.status).toBe(200);
    const call = prismaMocks.teamUpdate.mock.calls[0]?.[0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ id: TEAM_ID });
    expect(Object.keys(call.data)).toEqual(["name"]);
    const body = (await res.json()) as { team: { slug: string } };
    expect(body.team.slug).toBe("old-slug");
  });

  it("logs an audit event with the team id and the old and new name", async () => {
    await patchTeam(ADMIN, TEAM_ID, { name: " New Name " });
    expect(auditMocks.logAuditEvent).toHaveBeenCalledTimes(1);
    expect(auditMocks.logAuditEvent).toHaveBeenCalledWith({
      action: "project.updated",
      actorId: ADMIN.userId,
      payload: { teamId: TEAM_ID, from: "Old Name", to: "New Name" },
    });
  });

  it("logs nothing when validation rejects the body", async () => {
    await patchTeam(ADMIN, TEAM_ID, { name: "   " });
    expect(auditMocks.logAuditEvent).not.toHaveBeenCalled();
  });
});
