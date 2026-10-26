/** @vitest-environment jsdom */
/**
 * /home follows the header team switcher. The page resolves its team once in
 * a bootstrap effect, so it re-resolves from the announced team change: it
 * reloads that team's tasks, shows the new team's name, drops the old team's
 * tasks while loading, and ignores a change to the team already shown or to a
 * team the user is not in. Mock pattern mirrors HomePage.scopeOrder.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import type { User, Team, Task, TeamTasksProject } from "../../src/lib/api";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  getTeamTasks: vi.fn(),
}));

import HomeDashboardPage from "../../src/app/home/page";
import { announceTeamChange } from "../../src/lib/teamSwitch";
import { getCurrentUser, getTeams, getTeamTasks } from "../../src/lib/api";

const TEAMS = [
  { id: "team-1", name: "Alpha Team", slug: "alpha", role: "ADMIN", createdAt: "2026-01-01T00:00:00Z" },
  { id: "team-2", name: "Beta Team", slug: "beta", role: "MEMBER", createdAt: "2026-01-01T00:00:00Z" },
] as Team[];

function task(id: string, title: string): Task {
  return {
    id, projectId: "proj-1", title, description: null, status: "open", priority: "MEDIUM",
    templateData: null, claimedByUserId: null, claimedByAgentId: null, claimedAt: null, dueAt: null,
    branchName: null, prUrl: null, prNumber: null, result: null, externalRef: null, labels: [],
    createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", attachments: [],
  } as Task;
}

const PROJECT = { id: "proj-1", name: "Proj", slug: "proj", accessSource: "team" } as TeamTasksProject;
const COUNTS = { open: 1, review: 0, done: 0, priority: 0, mine: 0, total: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", login: "lan" } as User);
  vi.mocked(getTeams).mockResolvedValue(TEAMS);
  vi.mocked(getTeamTasks).mockImplementation(async (teamId: string) => ({
    tasks: [teamId === "team-2" ? task("b", "Beta only task") : task("a", "Alpha only task")],
    projects: [PROJECT],
    counts: COUNTS,
  }));
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("/home — header team switch", () => {
  it("re-resolves the team and loads its tasks when the switch is announced", async () => {
    render(<HomeDashboardPage />);
    expect(await screen.findByRole("heading", { name: "Alpha Team" })).toBeInTheDocument();
    expect(await screen.findAllByText("Alpha only task")).not.toHaveLength(0);

    act(() => announceTeamChange("team-2"));

    expect(await screen.findByRole("heading", { name: "Beta Team" })).toBeInTheDocument();
    expect(await screen.findAllByText("Beta only task")).not.toHaveLength(0);
    expect(vi.mocked(getTeamTasks)).toHaveBeenLastCalledWith("team-2");
    // The old team's tasks do not linger next to the new team's heading.
    expect(screen.queryByText("Alpha only task")).not.toBeInTheDocument();
  });

  it("shows the loading state, not the old team's tasks, until the new team's tasks arrive", async () => {
    let release: (v: Awaited<ReturnType<typeof getTeamTasks>>) => void = () => {};
    render(<HomeDashboardPage />);
    await screen.findAllByText("Alpha only task");

    vi.mocked(getTeamTasks).mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    act(() => announceTeamChange("team-2"));

    expect(await screen.findByRole("heading", { name: "Beta Team" })).toBeInTheDocument();
    expect(screen.queryByText("Alpha only task")).not.toBeInTheDocument();
    expect(document.querySelector(".home-widgets-grid")).toBeNull();

    await act(async () => {
      release({ tasks: [task("b", "Beta only task")], projects: [PROJECT], counts: COUNTS });
    });
    expect(await screen.findAllByText("Beta only task")).not.toHaveLength(0);
  });

  it("ignores a change to the team already shown or to an unknown team", async () => {
    render(<HomeDashboardPage />);
    await screen.findAllByText("Alpha only task");
    const calls = vi.mocked(getTeamTasks).mock.calls.length;

    act(() => announceTeamChange("team-1"));
    act(() => announceTeamChange("ghost"));

    expect(screen.getByRole("heading", { name: "Alpha Team" })).toBeInTheDocument();
    expect(screen.getAllByText("Alpha only task")).not.toHaveLength(0);
    expect(vi.mocked(getTeamTasks).mock.calls).toHaveLength(calls);
  });
});
