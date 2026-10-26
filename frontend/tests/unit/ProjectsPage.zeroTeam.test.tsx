/** @vitest-environment jsdom */
/**
 * /projects for each {teams 0/1, shared projects 0/1} combination.
 *
 * Only needsOnboarding (no teams AND no shared projects) redirects to
 * /onboarding. A team-less user with shared projects sees them (each opening
 * its board), a "Create a team" action, and none of the team-bound controls
 * (New Project, Sync GitHub / Connect GitHub). A user with a team gets the
 * team's project list and controls; the unscoped listing is never requested
 * for them (their listing names the team).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import type { Project, Team, User } from "../../src/lib/api";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  getProjects: vi.fn(),
  getTasks: vi.fn(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  syncTeamFromGitHub: vi.fn(),
}));

import ProjectsPage from "../../src/app/projects/page";
import { getCurrentUser, getProjects, getTeams, getTasks } from "../../src/lib/api";

const USER = { id: "u-1", login: "lan", githubConnected: false } as User;
const TEAM = { id: "t1", name: "Pandora", slug: "pandora", role: "ADMIN", createdAt: "x" } as Team;
const SHARED = {
  id: "p3",
  teamId: "t9",
  name: "Shared Project",
  description: null,
  githubRepo: null,
} as Project;
const OWN = { ...SHARED, id: "p1", teamId: "t1", name: "Own Project" } as Project;

Element.prototype.scrollIntoView = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue(USER);
  vi.mocked(getTasks).mockResolvedValue([]);
});
afterEach(cleanup);

function setAccess(teams: Team[], shared: Project[]) {
  vi.mocked(getTeams).mockResolvedValue(teams);
  // The unscoped listing (no argument) is the shared one; a team id lists that team.
  vi.mocked(getProjects).mockImplementation(async (teamId?: string) =>
    teamId ? [OWN] : shared,
  );
}

describe("/projects with no teams", () => {
  it("and no shared projects: redirects to /onboarding", async () => {
    setAccess([], []);
    render(<ProjectsPage />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/onboarding"));
    expect(screen.queryByRole("link", { name: "Create a team" })).toBeNull();
  });

  it("and the shared lookup fails: redirects to /onboarding like no shared projects", async () => {
    vi.mocked(getTeams).mockResolvedValue([]);
    vi.mocked(getProjects).mockRejectedValue(new Error("projects unavailable"));
    render(<ProjectsPage />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/onboarding"));
    expect(screen.queryByRole("link", { name: "Create a team" })).toBeNull();
  });

  it("with shared projects: lists them, offers Create a team, hides create and sync controls", async () => {
    setAccess([], [SHARED]);
    render(<ProjectsPage />);

    const card = await screen.findByRole("link", { name: /Shared Project/ });
    expect(card.getAttribute("href")).toBe("/projects/p3/board");
    expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create a team" }).getAttribute("href")).toBe("/onboarding");

    expect(screen.queryByRole("button", { name: /New Project/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Sync GitHub/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Connect GitHub/ })).toBeNull();
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });
});

describe("/projects with a team", () => {
  it.each([
    { name: "no shared projects", shared: [] as Project[] },
    { name: "shared projects", shared: [SHARED] },
  ])("and $name: the team list with its controls, no Create a team action", async ({ shared }) => {
    setAccess([TEAM], shared);
    render(<ProjectsPage />);

    expect(await screen.findByRole("heading", { name: "Pandora" })).toBeInTheDocument();
    await screen.findByText("Own Project");
    expect(screen.getAllByRole("button", { name: /New Project/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "Create a team" })).toBeNull();
    expect(screen.queryByText("Shared Project")).toBeNull();
    expect(vi.mocked(getProjects).mock.calls.every((c) => c[0] === "t1")).toBe(true);
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });
});
