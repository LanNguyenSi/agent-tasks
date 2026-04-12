/**
 * Unit tests for `isProjectAdmin`. This helper was extracted from two
 * inlined duplicates in routes/tasks.ts and routes/workflows.ts — pin
 * the contract here so the duplication can't come back via drift.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/types/auth.js";

const getProjectTeamIdMock = vi.fn();
const getUserRoleInTeamMock = vi.fn();

vi.mock("../../src/repositories/team-repository.js", () => ({
  getProjectTeamId: (...args: unknown[]) => getProjectTeamIdMock(...args),
  getUserRoleInTeam: (...args: unknown[]) => getUserRoleInTeamMock(...args),
}));

const { isProjectAdmin } = await import("../../src/services/team-access.js");

const humanAlice: Actor = { type: "human", userId: "alice" };
const humanBob: Actor = { type: "human", userId: "bob" };
const agent: Actor = {
  type: "agent",
  tokenId: "tok-1",
  teamId: "team-1",
  scopes: [],
};

describe("isProjectAdmin", () => {
  beforeEach(() => {
    getProjectTeamIdMock.mockReset();
    getUserRoleInTeamMock.mockReset();
  });

  it("returns true for a human admin of the owning team", async () => {
    getProjectTeamIdMock.mockResolvedValue("team-1");
    getUserRoleInTeamMock.mockResolvedValue("ADMIN");
    expect(await isProjectAdmin(humanAlice, "proj-1")).toBe(true);
  });

  it("returns false for a HUMAN_MEMBER role", async () => {
    getProjectTeamIdMock.mockResolvedValue("team-1");
    getUserRoleInTeamMock.mockResolvedValue("HUMAN_MEMBER");
    expect(await isProjectAdmin(humanAlice, "proj-1")).toBe(false);
  });

  it("returns false for a REVIEWER role", async () => {
    getProjectTeamIdMock.mockResolvedValue("team-1");
    getUserRoleInTeamMock.mockResolvedValue("REVIEWER");
    expect(await isProjectAdmin(humanAlice, "proj-1")).toBe(false);
  });

  it("returns false when the user has no role in the team", async () => {
    getProjectTeamIdMock.mockResolvedValue("team-1");
    getUserRoleInTeamMock.mockResolvedValue(null);
    expect(await isProjectAdmin(humanBob, "proj-1")).toBe(false);
  });

  it("returns false when the project does not exist", async () => {
    getProjectTeamIdMock.mockResolvedValue(null);
    expect(await isProjectAdmin(humanAlice, "missing")).toBe(false);
    // Short-circuits: role lookup not even attempted.
    expect(getUserRoleInTeamMock).not.toHaveBeenCalled();
  });

  it("returns false for agents, even if their token is scoped to the owning team", async () => {
    // Agents can't hold the ADMIN role; force path is human-only.
    getProjectTeamIdMock.mockResolvedValue("team-1");
    expect(await isProjectAdmin(agent, "proj-1")).toBe(false);
    // Short-circuits before any team lookup.
    expect(getProjectTeamIdMock).not.toHaveBeenCalled();
  });
});
