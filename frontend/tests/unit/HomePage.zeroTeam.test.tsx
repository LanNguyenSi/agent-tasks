/** @vitest-environment jsdom */
/**
 * /home for each {teams 0/1, shared projects 0/1} combination.
 *
 * needsOnboarding (no teams AND no shared projects) is the only case that
 * redirects to /onboarding. A team-less user with shared projects stays on
 * /home: the shared projects (each linking to its board) replace the task
 * widgets, no task aggregation is requested, and a "Create a team" action
 * points to /onboarding. A user with a team gets the team view unchanged, and
 * the unscoped project listing is not requested for them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import type { Project, Team, User } from "../../src/lib/api";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/home",
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  getProjects: vi.fn(),
  getTeamTasks: vi.fn(),
}));

import HomeDashboardPage from "../../src/app/home/page";
import { getCurrentUser, getProjects, getTeams, getTeamTasks } from "../../src/lib/api";

const USER = { id: "u-1", login: "lan", name: "Lan" } as User;
const TEAM = { id: "t1", name: "Pandora", slug: "pandora", role: "ADMIN", createdAt: "x" } as Team;
const SHARED = {
  id: "p3",
  name: "Shared Project",
  description: "From a friend",
  githubRepo: null,
} as Project;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue(USER);
  vi.mocked(getTeamTasks).mockResolvedValue({
    tasks: [],
    projects: [],
    counts: { open: 0, review: 0, done: 0, priority: 0, mine: 0, total: 0 },
  } as never);
});
afterEach(cleanup);

function setAccess(teams: Team[], shared: Project[]) {
  vi.mocked(getTeams).mockResolvedValue(teams);
  vi.mocked(getProjects).mockResolvedValue(shared);
}

describe("/home with no teams", () => {
  it("and no shared projects: redirects to /onboarding", async () => {
    setAccess([], []);
    render(<HomeDashboardPage />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/onboarding"));
    expect(getTeamTasks).not.toHaveBeenCalled();
  });

  it("and the shared lookup fails: redirects to /onboarding like no shared projects", async () => {
    vi.mocked(getTeams).mockResolvedValue([]);
    vi.mocked(getProjects).mockRejectedValue(new Error("projects unavailable"));
    render(<HomeDashboardPage />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/onboarding"));
    expect(getTeamTasks).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "Create a team" })).toBeNull();
  });

  it("with shared projects: no redirect, lists them with the Create a team action", async () => {
    setAccess([], [SHARED]);
    render(<HomeDashboardPage />);

    const card = await screen.findByRole("link", { name: /Shared Project/ });
    expect(card.getAttribute("href")).toBe("/projects/p3/board");
    expect(screen.getByRole("heading", { name: "Home" })).toBeInTheDocument();
    const create = screen.getByRole("link", { name: "Create a team" });
    expect(create.getAttribute("href")).toBe("/onboarding");

    // No task widgets, no team aggregation request, no redirect.
    expect(screen.queryByText("My Tasks")).toBeNull();
    expect(screen.queryByText("Active Tasks")).toBeNull();
    expect(getTeamTasks).not.toHaveBeenCalled();
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });
});

describe("/home with a team", () => {
  it.each([
    { name: "no shared projects", shared: [] as Project[] },
    { name: "shared projects", shared: [SHARED] },
  ])("and $name: the team view, no Create a team action, no redirect", async ({ shared }) => {
    setAccess([TEAM], shared);
    render(<HomeDashboardPage />);

    expect(await screen.findByRole("heading", { name: "Pandora" })).toBeInTheDocument();
    await waitFor(() => expect(getTeamTasks).toHaveBeenCalledWith("t1", expect.anything()));
    expect(await screen.findByText("My Tasks")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Create a team" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Shared Project/ })).toBeNull();
    expect(getProjects).not.toHaveBeenCalled();
    // No redirect: the only replace writes the resolved team into this page's
    // own URL (lib/teamSwitch useCurrentTeam).
    expect(routerMocks.replace.mock.calls.map((c) => c[0])).toEqual(["/home?teamId=t1"]);
  });
});
