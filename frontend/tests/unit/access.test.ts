/**
 * lib/access: the needsOnboarding truth table and the context loader.
 *
 * Input precedence: either input alone keeps a user out of onboarding, so
 * only {teams: 0, sharedProjects: 0} needs it. With a team, the shared
 * projects are not even fetched (the unscoped listing answers 400
 * multiple_teams for a user in several teams and cannot change the outcome).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project, Team } from "../../src/lib/api";

vi.mock("../../src/lib/api", () => ({
  getTeams: vi.fn(),
  getProjects: vi.fn(),
}));

import { getAccessContext, needsOnboarding, retrySharedProjects } from "../../src/lib/access";
import { getProjects, getTeams } from "../../src/lib/api";

const TEAM = { id: "t1", name: "Team", slug: "team", role: "ADMIN", createdAt: "x" } as Team;
const TEAM_2 = { ...TEAM, id: "t2" } as Team;
const SHARED = { id: "p3", name: "Shared", teamId: "t9" } as Project;

describe("needsOnboarding truth table", () => {
  it.each([
    { teams: [], sharedProjects: [], expected: true, label: "no teams, no shared projects" },
    { teams: [], sharedProjects: [SHARED], expected: false, label: "no teams, one shared project" },
    { teams: [TEAM], sharedProjects: [], expected: false, label: "one team, no shared projects" },
    { teams: [TEAM], sharedProjects: [SHARED], expected: false, label: "one team and a shared project" },
    { teams: [TEAM, TEAM_2], sharedProjects: [], expected: false, label: "several teams" },
    { teams: [], sharedProjects: [SHARED, { ...SHARED, id: "p4" }], expected: false, label: "no teams, several shared" },
  ])("$label -> $expected", ({ teams, sharedProjects, expected }) => {
    expect(needsOnboarding({ teams, sharedProjects })).toBe(expected);
  });
});

describe("getAccessContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("zero teams: lists the shared projects through the unscoped listing", async () => {
    vi.mocked(getTeams).mockResolvedValue([]);
    vi.mocked(getProjects).mockResolvedValue([SHARED]);
    const ctx = await getAccessContext();
    expect(ctx).toEqual({ teams: [], sharedProjects: [SHARED] });
    expect(getProjects).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getProjects).mock.calls[0]).toEqual([]);
  });

  it("zero teams and nothing shared: both lists empty", async () => {
    vi.mocked(getTeams).mockResolvedValue([]);
    vi.mocked(getProjects).mockResolvedValue([]);
    const ctx = await getAccessContext();
    expect(ctx).toEqual({ teams: [], sharedProjects: [] });
    expect(needsOnboarding(ctx)).toBe(true);
  });

  it("with a team: no project request is made and the shared list stays empty", async () => {
    vi.mocked(getTeams).mockResolvedValue([TEAM]);
    vi.mocked(getProjects).mockResolvedValue([SHARED]);
    const ctx = await getAccessContext();
    expect(ctx).toEqual({ teams: [TEAM], sharedProjects: [] });
    expect(getProjects).not.toHaveBeenCalled();
    expect(needsOnboarding(ctx)).toBe(false);
  });

  it("zero teams and a failing shared lookup: counts as nothing shared and flags the error", async () => {
    vi.mocked(getTeams).mockResolvedValue([]);
    vi.mocked(getProjects).mockRejectedValue(new Error("boom"));
    const ctx = await getAccessContext();
    expect(ctx).toEqual({ teams: [], sharedProjects: [], sharedProjectsError: true });
    expect(needsOnboarding(ctx)).toBe(true);
  });

  it("the error flag is absent when the shared lookup succeeds", async () => {
    vi.mocked(getTeams).mockResolvedValue([]);
    vi.mocked(getProjects).mockResolvedValue([SHARED]);
    expect(await getAccessContext()).not.toHaveProperty("sharedProjectsError");
  });

  it("a failing team request rejects instead of reading as 'needs onboarding'", async () => {
    vi.mocked(getTeams).mockRejectedValue(new Error("boom"));
    await expect(getAccessContext()).rejects.toThrow("boom");
    expect(getProjects).not.toHaveBeenCalled();
  });
});

describe("retrySharedProjects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("success: returns the list, no teams request, no error flag", async () => {
    vi.mocked(getProjects).mockResolvedValue([SHARED]);
    expect(await retrySharedProjects()).toEqual({ sharedProjects: [SHARED] });
    expect(getTeams).not.toHaveBeenCalled();
  });

  it("success with nothing shared: empty list, no error flag", async () => {
    vi.mocked(getProjects).mockResolvedValue([]);
    expect(await retrySharedProjects()).toEqual({ sharedProjects: [] });
  });

  it("failure: empty list plus the error flag, never a throw", async () => {
    vi.mocked(getProjects).mockRejectedValue(new Error("boom"));
    await expect(retrySharedProjects()).resolves.toEqual({
      sharedProjects: [],
      sharedProjectsError: true,
    });
  });
});
