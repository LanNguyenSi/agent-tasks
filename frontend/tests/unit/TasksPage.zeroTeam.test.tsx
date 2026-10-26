/** @vitest-environment jsdom */
/**
 * /tasks for each {teams 0/1, shared projects 0/1} combination.
 *
 * Only needsOnboarding (no teams AND no shared projects) redirects to
 * /onboarding. A team-less user with shared projects sees an explanatory
 * empty state with a link to Projects (cross-project tasks need a team) and
 * no task request is made. A user with a team gets the normal list.
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
  getTeamTasks: vi.fn(),
  updateTask: vi.fn(),
}));

vi.mock("../../src/components/tasks/NewTaskFlow", () => ({ default: () => null }));

import TasksPage from "../../src/app/tasks/page";
import { getCurrentUser, getProjects, getTeams, getTeamTasks } from "../../src/lib/api";

const USER = { id: "u-1", login: "lan" } as User;
const TEAM = { id: "t1", name: "Pandora", slug: "pandora", role: "ADMIN", createdAt: "x" } as Team;
const SHARED = { id: "p3", name: "Shared Project" } as Project;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue(USER);
  vi.mocked(getTeamTasks).mockResolvedValue({
    tasks: [],
    projects: [],
    counts: { open: 0, review: 0, done: 0, priority: 0, mine: 0, total: 0 },
    filteredTotal: 0,
  } as never);
});
afterEach(cleanup);

function setAccess(teams: Team[], shared: Project[]) {
  vi.mocked(getTeams).mockResolvedValue(teams);
  vi.mocked(getProjects).mockResolvedValue(shared);
}

describe("/tasks with no teams", () => {
  it("and no shared projects: redirects to /onboarding", async () => {
    setAccess([], []);
    render(<TasksPage />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/onboarding"));
    expect(getTeamTasks).not.toHaveBeenCalled();
  });

  it("with shared projects: explanatory empty state linking to Projects, no redirect", async () => {
    setAccess([], [SHARED]);
    render(<TasksPage />);

    expect(await screen.findByText("Cross-project tasks need a team.")).toBeInTheDocument();
    expect(screen.getByText(/Open a project from Projects/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Projects" }).getAttribute("href")).toBe("/projects");
    expect(getTeamTasks).not.toHaveBeenCalled();
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });
});

describe("/tasks with a team", () => {
  it.each([
    { name: "no shared projects", shared: [] as Project[] },
    { name: "shared projects", shared: [SHARED] },
  ])("and $name: the normal list, no empty-state explanation, no redirect", async ({ shared }) => {
    setAccess([TEAM], shared);
    render(<TasksPage />);

    await waitFor(() => expect(getTeamTasks).toHaveBeenCalled());
    expect(vi.mocked(getTeamTasks).mock.calls[0]![0]).toBe("t1");
    expect(screen.queryByText("Cross-project tasks need a team.")).toBeNull();
    expect(getProjects).not.toHaveBeenCalled();
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });
});
