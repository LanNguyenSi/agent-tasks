/** @vitest-environment jsdom */
/**
 * /projects page-level tests for the single current-team rule (T02):
 * the initial team resolves through lib/currentTeam (?teamId -> remembered
 * team -> teams[0]) and a valid `?teamId` is remembered. The page has no
 * team select of its own: the header switcher owns switching (AppHeader),
 * and the page re-resolves its team when the switch is announced.
 * Mock/render pattern mirrors TasksPageDemote.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import type { Project, Team, User } from "../../src/lib/api";

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
  getTasks: vi.fn(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  syncTeamFromGitHub: vi.fn(),
}));

import ProjectsPage from "../../src/app/projects/page";
import { announceTeamChange } from "../../src/lib/teamSwitch";
import { getCurrentUser, getTeams, getProjects, getTasks } from "../../src/lib/api";

const mockGetCurrentUser = vi.mocked(getCurrentUser);
const mockGetTeams = vi.mocked(getTeams);
const mockGetProjects = vi.mocked(getProjects);
const mockGetTasks = vi.mocked(getTasks);

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

function makeTeam(over: Partial<Team> = {}): Team {
  return {
    id: "t1",
    name: "Team One",
    slug: "team-one",
    role: "ADMIN",
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const PROJECT: Project = {
  id: "proj-1",
  teamId: "t1",
  name: "Agent Tasks",
  slug: "agent-tasks",
  description: null,
  githubRepo: null,
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

beforeEach(() => {
  vi.clearAllMocks();
  navState.search = "";
  window.localStorage.clear();
  mockGetCurrentUser.mockResolvedValue(USER);
  mockGetTeams.mockResolvedValue([makeTeam(), makeTeam({ id: "t2", name: "Team Two", slug: "team-two" })]);
  mockGetProjects.mockResolvedValue([PROJECT]);
  mockGetTasks.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("/projects page — current-team resolution (lib/currentTeam)", () => {
  it("a remembered team beats teams[0] when the URL carries no teamId", async () => {
    window.localStorage.setItem("agent-tasks:lastTeamId", "t2");

    render(<ProjectsPage />);
    await waitFor(() => expect(mockGetProjects).toHaveBeenCalledWith("t2"));
    expect(await screen.findByRole("heading", { name: "Team Two" })).toBeInTheDocument();
  });

  it("a valid ?teamId wins over the remembered team and is remembered", async () => {
    navState.search = "teamId=t2";
    window.localStorage.setItem("agent-tasks:lastTeamId", "t1");

    render(<ProjectsPage />);
    expect(await screen.findByRole("heading", { name: "Team Two" })).toBeInTheDocument();
    expect(mockGetProjects).toHaveBeenCalledWith("t2");
    // URL-selected team becomes the remembered one (same key as the switcher).
    expect(window.localStorage.getItem("agent-tasks:lastTeamId")).toBe("t2");
  });

  it("an invalid ?teamId falls through to the remembered team", async () => {
    navState.search = "teamId=ghost";
    window.localStorage.setItem("agent-tasks:lastTeamId", "t2");

    render(<ProjectsPage />);
    expect(await screen.findByRole("heading", { name: "Team Two" })).toBeInTheDocument();
    expect(mockGetProjects).toHaveBeenCalledWith("t2");
  });

  it("has no in-page team select (the header switcher owns switching)", async () => {
    render(<ProjectsPage />);
    expect(await screen.findByRole("heading", { name: "Team One" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Switch team" })).not.toBeInTheDocument();
  });
});

describe("/projects page — header team switch", () => {
  const T2_PROJECT: Project = { ...PROJECT, id: "proj-2", teamId: "t2", name: "Second Team Project", slug: "second" };

  it("re-resolves the team and reloads its projects when the switch is announced", async () => {
    mockGetProjects.mockImplementation(async (teamId?: string) =>
      teamId === "t2" ? [T2_PROJECT] : [PROJECT],
    );
    render(<ProjectsPage />);
    expect(await screen.findByRole("heading", { name: "Team One" })).toBeInTheDocument();
    await waitFor(() => expect(mockGetProjects).toHaveBeenCalledWith("t1"));

    act(() => announceTeamChange("t2"));

    expect(await screen.findByRole("heading", { name: "Team Two" })).toBeInTheDocument();
    await waitFor(() => expect(mockGetProjects).toHaveBeenCalledWith("t2"));
    expect((await screen.findAllByText("Second Team Project")).length).toBeGreaterThan(0);
    expect(window.localStorage.getItem("agent-tasks:lastTeamId")).toBe("t2");
  });

  it("ignores an announced switch to the team already shown or to an unknown team", async () => {
    render(<ProjectsPage />);
    expect(await screen.findByRole("heading", { name: "Team One" })).toBeInTheDocument();
    await waitFor(() => expect(mockGetProjects).toHaveBeenCalledTimes(1));

    act(() => announceTeamChange("t1"));
    act(() => announceTeamChange("ghost"));

    expect(screen.getByRole("heading", { name: "Team One" })).toBeInTheDocument();
    expect(mockGetProjects).toHaveBeenCalledTimes(1);
  });
});
