/** @vitest-environment jsdom */
/**
 * /projects header summary vs. the list: the team view lists the team's own
 * projects AND the projects shared with the caller, so when any shared
 * project is in the list the summary says so ("Team One · 3 projects,
 * 1 shared"); with none it stays the plain team count. The toolbar's
 * "Showing a-b of N" keeps counting the whole list. Mock/render pattern
 * mirrors ProjectsPage.activeCount.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import type { Project, Team, User } from "../../src/lib/api";

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
  getWorkflows: vi.fn(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  syncTeamFromGitHub: vi.fn(),
  logout: vi.fn(),
}));

import ProjectsPageRaw from "../../src/app/projects/page";
import { withTeamList } from "./helpers/withTeamList";
const ProjectsPage = withTeamList(ProjectsPageRaw);
import { nav } from "../setup/fakeNavigation";
import { getCurrentUser, getTeams, getProjects, getTasks, getWorkflows } from "../../src/lib/api";

function team(projectCount?: number): Team {
  return {
    id: "t1",
    name: "Team One",
    slug: "team-one",
    role: "ADMIN",
    createdAt: "2026-01-01T00:00:00Z",
    ...(projectCount === undefined ? {} : { projectCount }),
  } as Team;
}

function project(i: number, accessSource: "team" | "project"): Project {
  return {
    id: `proj-${i}`,
    teamId: "t1",
    name: `Project ${i}`,
    slug: `project-${i}`,
    description: null,
    githubRepo: null,
    accessSource,
  } as unknown as Project;
}

function teamProjects(count: number): Project[] {
  return Array.from({ length: count }, (_, i) => project(i + 1, "team"));
}

function sharedProjects(count: number): Project[] {
  return Array.from({ length: count }, (_, i) => project(100 + i, "project"));
}

function summaryText(): string | null {
  const el = document.querySelector(".page-header-summary");
  return el?.textContent ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  nav.reset("/projects");
  window.localStorage.clear();
  vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", login: "lan" } as User);
  vi.mocked(getTasks).mockResolvedValue([]);
  vi.mocked(getWorkflows).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("/projects: team summary vs. the shared projects in the list", () => {
  it("names the shared projects when the team view lists them (projectCount known)", async () => {
    vi.mocked(getTeams).mockResolvedValue([team(3)]);
    vi.mocked(getProjects).mockResolvedValue([...teamProjects(3), ...sharedProjects(1)]);

    render(<ProjectsPage />);

    await waitFor(() => expect(summaryText()).toBe("Team One · 3 projects, 1 shared"));
    expect(screen.getByText(/Showing 1-4 of 4/)).toBeInTheDocument();
  });

  it("names the shared projects when the team view lists them (projectCount absent, fallback to the list)", async () => {
    vi.mocked(getTeams).mockResolvedValue([team()]);
    vi.mocked(getProjects).mockResolvedValue([...teamProjects(3), ...sharedProjects(1)]);

    render(<ProjectsPage />);

    await waitFor(() => expect(summaryText()).toBe("Team One · 3 projects, 1 shared"));
  });

  it("stays the plain team count with no shared project", async () => {
    vi.mocked(getTeams).mockResolvedValue([team(3)]);
    vi.mocked(getProjects).mockResolvedValue(teamProjects(3));

    render(<ProjectsPage />);

    await waitFor(() => expect(summaryText()).toBe("Team One · 3 projects"));
  });

  it("uses the singular for one team project", async () => {
    vi.mocked(getTeams).mockResolvedValue([team(1)]);
    vi.mocked(getProjects).mockResolvedValue(teamProjects(1));

    render(<ProjectsPage />);

    await waitFor(() => expect(summaryText()).toBe("Team One · 1 project"));
  });

  it("keeps the singular for the team and still names one shared project", async () => {
    vi.mocked(getTeams).mockResolvedValue([team(1)]);
    vi.mocked(getProjects).mockResolvedValue([...teamProjects(1), ...sharedProjects(1)]);

    render(<ProjectsPage />);

    await waitFor(() => expect(summaryText()).toBe("Team One · 1 project, 1 shared"));
  });
});
