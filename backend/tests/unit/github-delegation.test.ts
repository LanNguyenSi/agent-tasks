import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    teamMember: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from "../../src/lib/prisma.js";
import { findDelegationUser } from "../../src/services/github-delegation.js";

const findUnique = prisma.teamMember.findUnique as unknown as ReturnType<typeof vi.fn>;
const findMany = prisma.teamMember.findMany as unknown as ReturnType<typeof vi.fn>;

const TEAM_ID = "team-1";
const PREFER_ID = "user-prefer";
const ADMIN_ID = "user-admin";
const MEMBER_ID = "user-member";

function makeUser(overrides: Partial<{
  id: string;
  login: string;
  githubAccessToken: string | null;
  githubConnectedAt: Date | null;
  allowAgentPrCreate: boolean;
  allowAgentPrMerge: boolean;
  allowAgentPrComment: boolean;
}> = {}) {
  return {
    id: "user-x",
    login: "userx",
    githubAccessToken: "ghp_token" as string | null,
    githubConnectedAt: new Date("2026-01-01") as Date | null,
    allowAgentPrCreate: true,
    allowAgentPrMerge: true,
    allowAgentPrComment: true,
    ...overrides,
  };
}

describe("findDelegationUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the preferred user when they are in the team and consent", async () => {
    const preferUser = makeUser({ id: PREFER_ID, login: "prefer" });
    findUnique.mockResolvedValue({ user: preferUser });

    const result = await findDelegationUser(TEAM_ID, "allowAgentPrCreate", {
      preferUserId: PREFER_ID,
    });

    expect(result).toEqual({
      userId: PREFER_ID,
      login: "prefer",
      githubAccessToken: "ghp_token",
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { teamId_userId: { teamId: TEAM_ID, userId: PREFER_ID } },
      include: expect.any(Object),
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("falls back to pool when preferred user lacks consent", async () => {
    const preferUser = makeUser({ id: PREFER_ID, login: "prefer", allowAgentPrCreate: false });
    const adminUser = makeUser({ id: ADMIN_ID, login: "admin" });
    findUnique.mockResolvedValue({ user: preferUser });
    findMany.mockResolvedValue([{ user: adminUser }]);

    const result = await findDelegationUser(TEAM_ID, "allowAgentPrCreate", {
      preferUserId: PREFER_ID,
    });

    expect(result?.userId).toBe(ADMIN_ID);
    expect(findMany).toHaveBeenCalled();
  });

  it("falls back to pool when preferred user has no GitHub connected", async () => {
    const preferUser = makeUser({ id: PREFER_ID, githubAccessToken: null });
    const adminUser = makeUser({ id: ADMIN_ID, login: "admin" });
    findUnique.mockResolvedValue({ user: preferUser });
    findMany.mockResolvedValue([{ user: adminUser }]);

    const result = await findDelegationUser(TEAM_ID, "allowAgentPrCreate", {
      preferUserId: PREFER_ID,
    });

    expect(result?.userId).toBe(ADMIN_ID);
  });

  it("falls back to pool when preferred user is not a team member", async () => {
    const adminUser = makeUser({ id: ADMIN_ID, login: "admin" });
    findUnique.mockResolvedValue(null);
    findMany.mockResolvedValue([{ user: adminUser }]);

    const result = await findDelegationUser(TEAM_ID, "allowAgentPrCreate", {
      preferUserId: PREFER_ID,
    });

    expect(result?.userId).toBe(ADMIN_ID);
  });

  it("uses pool when no preferUserId is given (legacy behavior)", async () => {
    const adminUser = makeUser({ id: ADMIN_ID, login: "admin" });
    findMany.mockResolvedValue([{ user: adminUser }]);

    const result = await findDelegationUser(TEAM_ID, "allowAgentPrCreate");

    expect(result?.userId).toBe(ADMIN_ID);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("returns null when no eligible user exists in either path", async () => {
    findUnique.mockResolvedValue(null);
    findMany.mockResolvedValue([
      { user: makeUser({ id: "u1", allowAgentPrCreate: false }) },
      { user: makeUser({ id: "u2", githubAccessToken: null }) },
    ]);

    const result = await findDelegationUser(TEAM_ID, "allowAgentPrCreate", {
      preferUserId: PREFER_ID,
    });

    expect(result).toBeNull();
  });

  it("respects per-permission consent (preferred user has create but not merge)", async () => {
    const preferUser = makeUser({
      id: PREFER_ID,
      allowAgentPrCreate: true,
      allowAgentPrMerge: false,
    });
    const adminUser = makeUser({ id: ADMIN_ID, login: "admin" });
    findUnique.mockResolvedValue({ user: preferUser });
    findMany.mockResolvedValue([{ user: adminUser }]);

    const create = await findDelegationUser(TEAM_ID, "allowAgentPrCreate", {
      preferUserId: PREFER_ID,
    });
    expect(create?.userId).toBe(PREFER_ID);

    findUnique.mockResolvedValue({ user: preferUser });
    const merge = await findDelegationUser(TEAM_ID, "allowAgentPrMerge", {
      preferUserId: PREFER_ID,
    });
    expect(merge?.userId).toBe(ADMIN_ID);
  });

  it("pool fallback orders ADMIN before regular members (orderBy passed to findMany)", async () => {
    findMany.mockResolvedValue([
      { user: makeUser({ id: ADMIN_ID, login: "admin" }) },
      { user: makeUser({ id: MEMBER_ID, login: "member" }) },
    ]);

    const result = await findDelegationUser(TEAM_ID, "allowAgentPrCreate");

    expect(result?.userId).toBe(ADMIN_ID);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: { role: "asc" },
    }));
  });
});
