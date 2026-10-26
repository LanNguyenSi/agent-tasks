/** @vitest-environment jsdom */
/**
 * /tasks follows the header team switcher through `?teamId`: the switcher
 * navigates to `/tasks?teamId=<id>` and the page re-syncs its team from the
 * URL after bootstrap (no listener needed). The page has no team select of
 * its own any more. Mock pattern mirrors TasksPage.zeroTeam.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import type { Team, User } from "../../src/lib/api";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
const navState = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams(navState.search),
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
import { getCurrentUser, getTeams, getTeamTasks } from "../../src/lib/api";

const TEAMS = [
  { id: "t1", name: "Team One", slug: "one", role: "ADMIN", createdAt: "x" },
  { id: "t2", name: "Team Two", slug: "two", role: "MEMBER", createdAt: "x" },
] as Team[];

beforeEach(() => {
  vi.clearAllMocks();
  navState.search = "";
  window.localStorage.clear();
  vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", login: "lan" } as User);
  vi.mocked(getTeams).mockResolvedValue(TEAMS);
  vi.mocked(getTeamTasks).mockResolvedValue({
    tasks: [],
    projects: [],
    counts: { open: 0, review: 0, done: 0, priority: 0, mine: 0, total: 0 },
    filteredTotal: 0,
  } as never);
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("/tasks — header team switch", () => {
  it("has no in-page team select (the header switcher owns switching)", async () => {
    render(<TasksPage />);
    await waitFor(() => expect(getTeamTasks).toHaveBeenCalled());
    expect(screen.queryByRole("combobox", { name: "Switch team" })).not.toBeInTheDocument();
  });

  it("loads the other team's tasks when the URL changes to ?teamId=<other>", async () => {
    const { rerender } = render(<TasksPage />);
    await waitFor(() => expect(getTeamTasks).toHaveBeenCalledWith("t1", expect.anything()));

    navState.search = "teamId=t2";
    rerender(<TasksPage />);

    await waitFor(() => expect(getTeamTasks).toHaveBeenCalledWith("t2", expect.anything()));
    expect(window.localStorage.getItem("agent-tasks:lastTeamId")).toBe("t2");
  });
});
