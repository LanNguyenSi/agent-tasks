import { describe, expect, it, vi } from "vitest";
vi.mock("../../src/lib/prisma.js", () => ({ prisma: new Proxy({}, { get() { throw new Error("authorization escaped its transaction"); } }) }));
import { hasProjectAccess, hasProjectRole, requireProjectWrite } from "../../src/services/team-access.js";
import { findDelegationUser } from "../../src/services/github-delegation.js";
import type { ProjectAccessDatabase } from "../../src/repositories/team-repository.js";
import type { Actor } from "../../src/types/auth.js";

const human: Actor = { type: "human", userId: "user" };
const agent: Actor = { type: "agent", userId: "user", tokenId: "token", teamId: "foreign", scopes: ["tasks:transition"] };
function database(teamRole: string | null, projectRole: string | null) {
  const db = {
    project: { findUnique: vi.fn(async () => ({ teamId: "team" })) },
    teamMember: { findUnique: vi.fn(async () => teamRole ? { role: teamRole } : null), findMany: vi.fn() },
    projectMember: { findUnique: vi.fn(async () => projectRole ? { role: projectRole } : null) },
  };
  return { mock: db, db: db as unknown as ProjectAccessDatabase };
}
describe("transaction-aware authority preserves existing roles without singleton reads", () => {
  it.each(["ADMIN", "HUMAN_MEMBER", "REVIEWER"])("team %s can write, and concrete roles retain exact matching", async role => {
    const { db } = database(role, null);
    await expect(hasProjectAccess(human, "project", db)).resolves.toBe(true);
    await expect(requireProjectWrite(human, "project", db)).resolves.toBe(true);
    await expect(hasProjectRole(human, "project", "REVIEWER", db)).resolves.toBe(role === "REVIEWER");
  });
  it.each([null, "PROJECT_VIEWER", "PROJECT_CONTRIBUTOR", "PROJECT_ADMIN"])("project grant %s preserves read/write/role distinctions", async role => {
    const { db } = database(null, role);
    await expect(hasProjectAccess(human, "project", db)).resolves.toBe(role !== null);
    await expect(requireProjectWrite(human, "project", db)).resolves.toBe(role === "PROJECT_CONTRIBUTOR" || role === "PROJECT_ADMIN");
    await expect(hasProjectRole(human, "project", "REVIEWER", db)).resolves.toBe(role === "PROJECT_CONTRIBUTOR" || role === "PROJECT_ADMIN");
    await expect(hasProjectRole(human, "project", "ADMIN", db)).resolves.toBe(role === "PROJECT_ADMIN");
  });
  it("agents keep team/project access and cannot acquire human roles", async () => {
    const { db } = database(null, "PROJECT_CONTRIBUTOR");
    await expect(requireProjectWrite(agent, "project", db)).resolves.toBe(true);
    await expect(hasProjectRole(agent, "project", "REVIEWER", db)).resolves.toBe(false);
    await expect(hasProjectAccess({ ...agent, teamId: "team" }, "project", db)).resolves.toBe(true);
    const absent = database(null, null).db;
    await expect(requireProjectWrite(agent, "project", absent)).resolves.toBe(false);
  });
  it("both preferred delegation and pool fallback read only the supplied transaction", async () => {
    const { db, mock } = database(null, null);
    const user = { id: "user", login: "login", githubAccessToken: "test-only", githubConnectedAt: new Date(), allowAgentPrCreate: true };
    mock.teamMember.findUnique.mockResolvedValue({ user } as never);
    await expect(findDelegationUser("team", "allowAgentPrCreate", { preferUserId: "user", db })).resolves.toMatchObject({ userId: "user" });
    mock.teamMember.findUnique.mockResolvedValue(null);
    mock.teamMember.findMany.mockResolvedValue([{ user }]);
    await expect(findDelegationUser("team", "allowAgentPrCreate", { preferUserId: "other", db })).resolves.toMatchObject({ userId: "user" });
    expect(mock.teamMember.findMany).toHaveBeenCalledOnce();
  });
});
