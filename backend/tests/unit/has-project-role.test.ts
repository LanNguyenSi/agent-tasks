/**
 * Unit tests for `hasProjectRole`. Pins the parameterized role-check
 * contract that used to live inline in routes/tasks.ts:1022. `"any"`
 * delegates to hasProjectAccess (membership-only), concrete roles are
 * human-only. Also verifies that `isProjectAdmin` still satisfies its
 * own contract after being rewired to delegate here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/types/auth.js";

const getProjectTeamIdMock = vi.fn();
const getUserRoleInTeamMock = vi.fn();

vi.mock("../../src/repositories/team-repository.js", () => ({
  getProjectTeamId: (...args: unknown[]) => getProjectTeamIdMock(...args),
  getUserRoleInTeam: (...args: unknown[]) => getUserRoleInTeamMock(...args),
}));

const { hasProjectRole, isProjectAdmin } = await import(
  "../../src/services/team-access.js"
);

const humanAlice: Actor = { type: "human", userId: "alice" };
const humanBob: Actor = { type: "human", userId: "bob" };
const agentSameTeam: Actor = {
  type: "agent",
  tokenId: "tok-1",
  teamId: "team-1",
  scopes: [],
};
const agentOtherTeam: Actor = {
  type: "agent",
  tokenId: "tok-2",
  teamId: "team-2",
  scopes: [],
};

describe("hasProjectRole", () => {
  beforeEach(() => {
    getProjectTeamIdMock.mockReset();
    getUserRoleInTeamMock.mockReset();
  });

  describe("role === 'any'", () => {
    it("returns true when a human is any member of the owning team", async () => {
      getProjectTeamIdMock.mockResolvedValue("team-1");
      getUserRoleInTeamMock.mockResolvedValue("HUMAN_MEMBER");
      expect(await hasProjectRole(humanAlice, "proj-1", "any")).toBe(true);
    });

    it("returns true even for a REVIEWER (membership is what matters)", async () => {
      getProjectTeamIdMock.mockResolvedValue("team-1");
      getUserRoleInTeamMock.mockResolvedValue("REVIEWER");
      expect(await hasProjectRole(humanAlice, "proj-1", "any")).toBe(true);
    });

    it("returns false when the human has no role in the team", async () => {
      getProjectTeamIdMock.mockResolvedValue("team-1");
      getUserRoleInTeamMock.mockResolvedValue(null);
      expect(await hasProjectRole(humanBob, "proj-1", "any")).toBe(false);
    });

    it("returns true for an agent whose token is scoped to the owning team", async () => {
      // Matches the old short-circuit at tasks.ts:1018 where requiredRole==='any'
      // skipped the whole check. Agents past hasProjectAccess stay past the gate.
      getProjectTeamIdMock.mockResolvedValue("team-1");
      expect(await hasProjectRole(agentSameTeam, "proj-1", "any")).toBe(true);
    });

    it("returns false for an agent whose token is scoped to a different team", async () => {
      getProjectTeamIdMock.mockResolvedValue("team-1");
      expect(await hasProjectRole(agentOtherTeam, "proj-1", "any")).toBe(false);
    });

    it("returns false when the project does not exist", async () => {
      getProjectTeamIdMock.mockResolvedValue(null);
      expect(await hasProjectRole(humanAlice, "missing", "any")).toBe(false);
    });
  });

  describe("concrete roles", () => {
    it("returns true when the human holds the requested role", async () => {
      getProjectTeamIdMock.mockResolvedValue("team-1");
      getUserRoleInTeamMock.mockResolvedValue("REVIEWER");
      expect(await hasProjectRole(humanAlice, "proj-1", "REVIEWER")).toBe(true);
    });

    it("returns false when the human holds a different role", async () => {
      getProjectTeamIdMock.mockResolvedValue("team-1");
      getUserRoleInTeamMock.mockResolvedValue("HUMAN_MEMBER");
      expect(await hasProjectRole(humanAlice, "proj-1", "REVIEWER")).toBe(false);
    });

    it("returns false when the user is not a member", async () => {
      getProjectTeamIdMock.mockResolvedValue("team-1");
      getUserRoleInTeamMock.mockResolvedValue(null);
      expect(await hasProjectRole(humanBob, "proj-1", "ADMIN")).toBe(false);
    });

    it("returns false for agents regardless of team scope", async () => {
      // Roles are human-only in the membership model; no DB lookup should happen.
      expect(await hasProjectRole(agentSameTeam, "proj-1", "ADMIN")).toBe(false);
      expect(getProjectTeamIdMock).not.toHaveBeenCalled();
    });

    it("returns false when the project does not exist", async () => {
      getProjectTeamIdMock.mockResolvedValue(null);
      expect(await hasProjectRole(humanAlice, "missing", "ADMIN")).toBe(false);
      expect(getUserRoleInTeamMock).not.toHaveBeenCalled();
    });
  });
});

describe("isProjectAdmin (delegates to hasProjectRole)", () => {
  beforeEach(() => {
    getProjectTeamIdMock.mockReset();
    getUserRoleInTeamMock.mockReset();
  });

  it("returns true for a human admin", async () => {
    getProjectTeamIdMock.mockResolvedValue("team-1");
    getUserRoleInTeamMock.mockResolvedValue("ADMIN");
    expect(await isProjectAdmin(humanAlice, "proj-1")).toBe(true);
  });

  it("returns false for HUMAN_MEMBER / REVIEWER / non-member / agent / missing project", async () => {
    getProjectTeamIdMock.mockResolvedValue("team-1");

    getUserRoleInTeamMock.mockResolvedValueOnce("HUMAN_MEMBER");
    expect(await isProjectAdmin(humanAlice, "proj-1")).toBe(false);

    getUserRoleInTeamMock.mockResolvedValueOnce("REVIEWER");
    expect(await isProjectAdmin(humanAlice, "proj-1")).toBe(false);

    getUserRoleInTeamMock.mockResolvedValueOnce(null);
    expect(await isProjectAdmin(humanBob, "proj-1")).toBe(false);

    // Agent short-circuits before any team lookup.
    getProjectTeamIdMock.mockClear();
    expect(await isProjectAdmin(agentSameTeam, "proj-1")).toBe(false);
    expect(getProjectTeamIdMock).not.toHaveBeenCalled();

    getProjectTeamIdMock.mockResolvedValueOnce(null);
    expect(await isProjectAdmin(humanAlice, "missing")).toBe(false);
  });
});
