import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    teamMember: { findUnique: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock("../../src/repositories/team-repository.js", () => ({
  getProjectTeamId: vi.fn(),
  getUserRoleInTeam: vi.fn(),
}));

import { prisma } from "../../src/lib/prisma.js";
import { resolveTeamId } from "../../src/services/team-access.js";

const findMany = prisma.teamMember.findMany as unknown as ReturnType<typeof vi.fn>;
const findUnique = prisma.teamMember.findUnique as unknown as ReturnType<typeof vi.fn>;

const humanActor = { type: "human" as const, userId: "user-1" };
const agentActor = {
  type: "agent" as const,
  tokenId: "tok",
  teamId: "team-agent",
  scopes: [],
};

describe("resolveTeamId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("agent: returns the token's team when no explicit teamId given", async () => {
    const result = await resolveTeamId(agentActor, undefined);
    expect(result).toEqual({ ok: true, teamId: "team-agent" });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("agent: 403 when explicit teamId mismatches the token", async () => {
    const result = await resolveTeamId(agentActor, "team-other");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.code).toBe("forbidden");
    }
  });

  it("agent: allows explicit teamId if it matches the token", async () => {
    const result = await resolveTeamId(agentActor, "team-agent");
    expect(result).toEqual({ ok: true, teamId: "team-agent" });
  });

  it("human with sole membership + no explicit teamId: returns that team", async () => {
    findMany.mockResolvedValue([{ teamId: "team-only" }]);

    const result = await resolveTeamId(humanActor, undefined);
    expect(result).toEqual({ ok: true, teamId: "team-only" });
    // No per-team membership check needed — findMany is both the auth
    // check and the default derivation.
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("human with multiple memberships + no teamId: 400 with team list", async () => {
    findMany.mockResolvedValue([
      { teamId: "team-a" },
      { teamId: "team-b" },
      { teamId: "team-c" },
    ]);

    const result = await resolveTeamId(humanActor, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok && result.status === 400 && result.code === "multiple_teams") {
      expect(result.teamIds).toEqual(["team-a", "team-b", "team-c"]);
      expect(result.message).toMatch(/specify teamId/i);
    } else {
      throw new Error(`expected multiple_teams, got ${JSON.stringify(result)}`);
    }
  });

  it("human with no memberships + no teamId: 400 no_teams", async () => {
    findMany.mockResolvedValue([]);

    const result = await resolveTeamId(humanActor, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok && result.status === 400) {
      expect(result.code).toBe("no_teams");
    }
  });

  it("human with explicit teamId + membership: returns team without enumerating all", async () => {
    findUnique.mockResolvedValue({ teamId: "team-x" });

    const result = await resolveTeamId(humanActor, "team-x");
    expect(result).toEqual({ ok: true, teamId: "team-x" });
    // Must NOT fetch all memberships when an explicit teamId was given —
    // that would be wasted work and could mask the 403 for non-members.
    expect(findMany).not.toHaveBeenCalled();
  });

  it("human with explicit teamId but no membership in it: 403", async () => {
    findUnique.mockResolvedValue(null);

    const result = await resolveTeamId(humanActor, "team-forbidden");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.code).toBe("forbidden");
    }
  });
});
