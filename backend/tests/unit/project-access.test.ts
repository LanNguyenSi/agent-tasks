/**
 * Unit tests for hasProjectAccess and getProjectMembership covering the
 * four-quadrant matrix introduced by per-project sharing:
 *
 *   ┌─────────────┬──────────────┬───────────────┐
 *   │             │ TeamMember   │ no TeamMember │
 *   ├─────────────┼──────────────┼───────────────┤
 *   │ ProjectMbr  │ both grants  │ project-only  │
 *   │ no ProjMbr  │ team-only    │ no access     │
 *   └─────────────┴──────────────┴───────────────┘
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/types/auth.js";

const getProjectTeamIdMock = vi.fn();
const getUserRoleInTeamMock = vi.fn();
const getUserRoleInProjectMock = vi.fn();

vi.mock("../../src/repositories/team-repository.js", () => ({
  getProjectTeamId: (...args: unknown[]) => getProjectTeamIdMock(...args),
  getUserRoleInTeam: (...args: unknown[]) => getUserRoleInTeamMock(...args),
  getUserRoleInProject: (...args: unknown[]) => getUserRoleInProjectMock(...args),
}));

const { hasProjectAccess, getProjectMembership } = await import(
  "../../src/services/team-access.js"
);

const human: Actor = { type: "human", userId: "u-1" };
const agentInTeam: Actor = {
  type: "agent",
  tokenId: "tok-in",
  teamId: "team-A",
  scopes: [],
  userId: "agent-owner",
};
const agentOutsideTeam: Actor = {
  type: "agent",
  tokenId: "tok-out",
  teamId: "team-B",
  scopes: [],
  userId: "agent-owner",
};

describe("hasProjectAccess (four-quadrant matrix)", () => {
  beforeEach(() => {
    getProjectTeamIdMock.mockReset();
    getUserRoleInTeamMock.mockReset();
    getUserRoleInProjectMock.mockReset();
  });

  describe("human actor", () => {
    it("team-only: TeamMember + no ProjectMember → true", async () => {
      getProjectTeamIdMock.mockResolvedValue("team-A");
      getUserRoleInTeamMock.mockResolvedValue("HUMAN_MEMBER");
      getUserRoleInProjectMock.mockResolvedValue(null);
      expect(await hasProjectAccess(human, "proj-1")).toBe(true);
    });

    it("project-only: no TeamMember + has ProjectMember → true", async () => {
      getProjectTeamIdMock.mockResolvedValue("team-A");
      getUserRoleInTeamMock.mockResolvedValue(null);
      getUserRoleInProjectMock.mockResolvedValue("PROJECT_VIEWER");
      expect(await hasProjectAccess(human, "proj-1")).toBe(true);
    });

    it("both: TeamMember + ProjectMember → true (team takes precedence in lookup order)", async () => {
      getProjectTeamIdMock.mockResolvedValue("team-A");
      getUserRoleInTeamMock.mockResolvedValue("ADMIN");
      getUserRoleInProjectMock.mockResolvedValue("PROJECT_CONTRIBUTOR");
      expect(await hasProjectAccess(human, "proj-1")).toBe(true);
      // Short-circuits — project lookup not needed once team is positive.
      expect(getUserRoleInProjectMock).not.toHaveBeenCalled();
    });

    it("neither: no TeamMember + no ProjectMember → false", async () => {
      getProjectTeamIdMock.mockResolvedValue("team-A");
      getUserRoleInTeamMock.mockResolvedValue(null);
      getUserRoleInProjectMock.mockResolvedValue(null);
      expect(await hasProjectAccess(human, "proj-1")).toBe(false);
    });

    it("missing project → false (no further lookups)", async () => {
      getProjectTeamIdMock.mockResolvedValue(null);
      expect(await hasProjectAccess(human, "missing")).toBe(false);
      expect(getUserRoleInTeamMock).not.toHaveBeenCalled();
      expect(getUserRoleInProjectMock).not.toHaveBeenCalled();
    });
  });

  describe("agent actor", () => {
    it("team match: agent.teamId === project.teamId → true", async () => {
      getProjectTeamIdMock.mockResolvedValue("team-A");
      expect(await hasProjectAccess(agentInTeam, "proj-1")).toBe(true);
      // Short-circuits — project lookup not needed.
      expect(getUserRoleInProjectMock).not.toHaveBeenCalled();
    });

    it("team mismatch + token-owner has ProjectMember → true", async () => {
      // Agent token belongs to user "agent-owner" (team-B token), but the
      // owner has a per-project grant on a team-A project. They get in.
      getProjectTeamIdMock.mockResolvedValue("team-A");
      getUserRoleInProjectMock.mockResolvedValue("PROJECT_CONTRIBUTOR");
      expect(await hasProjectAccess(agentOutsideTeam, "proj-1")).toBe(true);
    });

    it("team mismatch + token-owner has no ProjectMember → false", async () => {
      getProjectTeamIdMock.mockResolvedValue("team-A");
      getUserRoleInProjectMock.mockResolvedValue(null);
      expect(await hasProjectAccess(agentOutsideTeam, "proj-1")).toBe(false);
    });
  });
});

describe("getProjectMembership", () => {
  beforeEach(() => {
    getProjectTeamIdMock.mockReset();
    getUserRoleInTeamMock.mockReset();
    getUserRoleInProjectMock.mockReset();
  });

  it("human via team: returns { source: 'team', role: 'ADMIN' }", async () => {
    getProjectTeamIdMock.mockResolvedValue("team-A");
    getUserRoleInTeamMock.mockResolvedValue("ADMIN");
    expect(await getProjectMembership(human, "proj-1")).toEqual({
      source: "team",
      role: "ADMIN",
    });
  });

  it("human via project: returns { source: 'project', role: 'PROJECT_VIEWER' }", async () => {
    getProjectTeamIdMock.mockResolvedValue("team-A");
    getUserRoleInTeamMock.mockResolvedValue(null);
    getUserRoleInProjectMock.mockResolvedValue("PROJECT_VIEWER");
    expect(await getProjectMembership(human, "proj-1")).toEqual({
      source: "project",
      role: "PROJECT_VIEWER",
    });
  });

  it("human with no access: returns null", async () => {
    getProjectTeamIdMock.mockResolvedValue("team-A");
    getUserRoleInTeamMock.mockResolvedValue(null);
    getUserRoleInProjectMock.mockResolvedValue(null);
    expect(await getProjectMembership(human, "proj-1")).toBeNull();
  });

  it("agent in team: returns { source: 'team', role: null }", async () => {
    // Agents don't carry a per-user team role; the marker is just team-source.
    getProjectTeamIdMock.mockResolvedValue("team-A");
    expect(await getProjectMembership(agentInTeam, "proj-1")).toEqual({
      source: "team",
      role: null,
    });
  });

  it("agent token-owner has ProjectMember: returns { source: 'project', role }", async () => {
    getProjectTeamIdMock.mockResolvedValue("team-A");
    getUserRoleInProjectMock.mockResolvedValue("PROJECT_ADMIN");
    expect(await getProjectMembership(agentOutsideTeam, "proj-1")).toEqual({
      source: "project",
      role: "PROJECT_ADMIN",
    });
  });

  it("missing project: returns null", async () => {
    getProjectTeamIdMock.mockResolvedValue(null);
    expect(await getProjectMembership(human, "missing")).toBeNull();
  });
});
