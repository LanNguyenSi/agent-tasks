/**
 * Unit tests for `requireProjectWrite`, the write-tier gate that task-
 * mutating endpoints use instead of the mere-membership `hasProjectAccess`.
 *
 * The only read-only tier in the access model is the per-project
 * PROJECT_VIEWER role. This pins that contract: PROJECT_VIEWER is denied,
 * every other principal that cleared project access is admitted, and the
 * gate fails closed for non-members.
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

const { requireProjectWrite } = await import("../../src/services/team-access.js");

const human: Actor = { type: "human", userId: "alice" };
const agentSameTeam: Actor = {
  type: "agent",
  tokenId: "tok-1",
  teamId: "team-1",
  scopes: [],
  userId: "agent-owner-1",
};

describe("requireProjectWrite", () => {
  beforeEach(() => {
    getProjectTeamIdMock.mockReset();
    getUserRoleInTeamMock.mockReset();
    getUserRoleInProjectMock.mockReset();
    getProjectTeamIdMock.mockResolvedValue("team-1");
    getUserRoleInTeamMock.mockResolvedValue(null);
    getUserRoleInProjectMock.mockResolvedValue(null);
  });

  it("denies a human whose only grant is PROJECT_VIEWER", async () => {
    getUserRoleInTeamMock.mockResolvedValue(null);
    getUserRoleInProjectMock.mockResolvedValue("PROJECT_VIEWER");
    expect(await requireProjectWrite(human, "proj-1")).toBe(false);
  });

  it("admits a per-project PROJECT_CONTRIBUTOR", async () => {
    getUserRoleInTeamMock.mockResolvedValue(null);
    getUserRoleInProjectMock.mockResolvedValue("PROJECT_CONTRIBUTOR");
    expect(await requireProjectWrite(human, "proj-1")).toBe(true);
  });

  it("admits a per-project PROJECT_ADMIN", async () => {
    getUserRoleInTeamMock.mockResolvedValue(null);
    getUserRoleInProjectMock.mockResolvedValue("PROJECT_ADMIN");
    expect(await requireProjectWrite(human, "proj-1")).toBe(true);
  });

  it.each(["ADMIN", "HUMAN_MEMBER", "REVIEWER"] as const)(
    "admits a team %s (all team roles are write-capable)",
    async (teamRole) => {
      getUserRoleInTeamMock.mockResolvedValue(teamRole);
      expect(await requireProjectWrite(human, "proj-1")).toBe(true);
    },
  );

  it("admits an agent in the owning team (scope-gated elsewhere)", async () => {
    // hasProjectAccess short-circuits true for an agent whose token team
    // owns the project, so requireProjectWrite admits it.
    expect(await requireProjectWrite(agentSameTeam, "proj-1")).toBe(true);
  });

  it("denies a human with no membership at all (fail closed)", async () => {
    getUserRoleInTeamMock.mockResolvedValue(null);
    getUserRoleInProjectMock.mockResolvedValue(null);
    expect(await requireProjectWrite(human, "proj-1")).toBe(false);
  });

  it("denies when the project does not exist (no owning team)", async () => {
    getProjectTeamIdMock.mockResolvedValue(null);
    expect(await requireProjectWrite(human, "missing")).toBe(false);
  });
});
