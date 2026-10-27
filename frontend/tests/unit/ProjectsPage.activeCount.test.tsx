/** @vitest-environment jsdom */
/**
 * /projects "N active tasks": counted with the shared active definition
 * (open + in_progress), the same one Home's "Your projects" strip uses, so a
 * project shows the same number on both pages. Review, backlog, done and
 * abandoned tasks are not active. Mock/render pattern mirrors
 * ProjectsPage.currentTeam.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import type { Project, Task, Team, User } from "../../src/lib/api";

vi.mock("next/navigation", async () => {
  const m = await import("../setup/fakeNavigation");
  return {
    usePathname: m.usePathname,
    useRouter: m.useRouter,
    useSearchParams: m.useSearchParams,
  };
});

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  getProjects: vi.fn(),
  getTasks: vi.fn(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  syncTeamFromGitHub: vi.fn(),
  logout: vi.fn(),
}));

import ProjectsPage from "../../src/app/projects/page";
import { nav } from "../setup/fakeNavigation";
import { getCurrentUser, getTeams, getProjects, getTasks } from "../../src/lib/api";

const TEAM = {
  id: "t1",
  name: "Team One",
  slug: "team-one",
  role: "ADMIN",
  createdAt: "2026-01-01T00:00:00Z",
} as Team;

const PROJECT = {
  id: "proj-1",
  teamId: "t1",
  name: "Agent Tasks",
  slug: "agent-tasks",
  description: null,
  githubRepo: null,
} as unknown as Project;

function tasksWith(statuses: string[]): Task[] {
  return statuses.map((status, i) => ({ id: `t${i}`, projectId: "proj-1", status }) as Task);
}

beforeEach(() => {
  vi.clearAllMocks();
  nav.reset("/projects");
  window.localStorage.clear();
  vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", login: "lan" } as User);
  vi.mocked(getTeams).mockResolvedValue([TEAM]);
  vi.mocked(getProjects).mockResolvedValue([PROJECT]);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("/projects: heading", () => {
  it("is the one H1 'Projects' with the team name in the band summary, not an H2", async () => {
    vi.mocked(getTasks).mockResolvedValue([]);
    render(<ProjectsPage />);
    expect(await screen.findByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole("heading", { level: 2, name: TEAM.name })).toBeNull();
    await waitFor(() =>
      expect(document.querySelector(".page-header-summary")).toHaveTextContent(`${TEAM.name} · 1 projects`),
    );
  });
});

describe("/projects: active task count", () => {
  it("counts open and in_progress only", async () => {
    vi.mocked(getTasks).mockResolvedValue(
      tasksWith(["open", "open", "in_progress", "review", "backlog", "done", "abandoned"]),
    );

    render(<ProjectsPage />);

    await waitFor(() => expect(getTasks).toHaveBeenCalledWith("proj-1"));
    expect(await screen.findByText("3 active tasks")).toBeInTheDocument();
  });

  it("shows no count for a project whose tasks are all review, backlog or finished", async () => {
    vi.mocked(getTasks).mockResolvedValue(tasksWith(["review", "backlog", "done"]));

    render(<ProjectsPage />);

    await waitFor(() => expect(getTasks).toHaveBeenCalledWith("proj-1"));
    expect(await screen.findByText("Agent Tasks")).toBeInTheDocument();
    // Let the count request settle before asserting that nothing shows.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/active task/)).toBeNull();
  });
});
