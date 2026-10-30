/** @vitest-environment jsdom */
/**
 * /projects goes back to page 1 when the team, the search, the sort or the
 * GitHub filter changes, so a list that is still longer than one page does not
 * stay on a stale page number. Mock pattern mirrors
 * ProjectsPage.currentTeam.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
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
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  syncTeamFromGitHub: vi.fn(),
  logout: vi.fn(),
}));

import ProjectsPageRaw from "../../src/app/projects/page";
import { withTeamList } from "./helpers/withTeamList";
const ProjectsPage = withTeamList(ProjectsPageRaw);
import { nav } from "../setup/fakeNavigation";
import { getCurrentUser, getTeams, getProjects, getTasks } from "../../src/lib/api";

const USER: User = {
  id: "u-1",
  login: "lan",
  name: "Lan",
  avatarUrl: null,
  email: null,
  githubConnected: false,
  allowAgentPrCreate: false,
  allowAgentPrMerge: false,
  allowAgentPrComment: false,
};

const TEAM: Team = { id: "t1", name: "Team One", slug: "team-one", role: "ADMIN", createdAt: "2026-01-01T00:00:00Z" };

function project(n: number, githubRepo: string | null = null): Project {
  const id = String(n).padStart(2, "0");
  return {
    id: `proj-${id}`,
    teamId: "t1",
    name: `Project ${id}`,
    slug: `project-${id}`,
    description: null,
    githubRepo,
    githubSyncAt: null,
    taskTemplate: null,
    confidenceThreshold: 60,
    requireDistinctReviewer: false,
    soloMode: true,
    governanceMode: "AUTONOMOUS",
    notificationWebhookUrl: null,
    hasNotificationWebhookSecret: false,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

// 30 projects: two pages of 25 (25 + 5).
const PROJECTS = Array.from({ length: 30 }, (_, i) => project(i + 1, "org/repo"));

beforeEach(() => {
  vi.clearAllMocks();
  nav.reset("/projects");
  window.localStorage.clear();
  vi.mocked(getCurrentUser).mockResolvedValue(USER);
  vi.mocked(getTeams).mockResolvedValue([TEAM]);
  vi.mocked(getProjects).mockResolvedValue(PROJECTS);
  vi.mocked(getTasks).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

async function onPageTwo() {
  render(<ProjectsPage />);
  expect(await screen.findByText("Showing 1-25 of 30")).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button", { name: /Next/ })[0]!);
  expect(await screen.findByText("Showing 26-30 of 30")).toBeInTheDocument();
}

describe("/projects pagination reset", () => {
  it("a changed search goes back to page 1 while the list still spans two pages", async () => {
    await onPageTwo();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search projects" }), {
      target: { value: "project" },
    });

    expect(await screen.findByText("Showing 1-25 of 30")).toBeInTheDocument();
  });

  it("the GitHub-only filter goes back to page 1", async () => {
    await onPageTwo();

    fireEvent.click(screen.getByRole("checkbox", { name: /GitHub projects only/ }));

    await waitFor(() => expect(screen.getByText("Showing 1-25 of 30")).toBeInTheDocument());
  });
});
