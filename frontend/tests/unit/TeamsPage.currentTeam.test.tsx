/** @vitest-environment jsdom */
/**
 * /teams page-level tests for the single current-team rule (T02):
 * the initial team resolves through lib/currentTeam (?teamId -> remembered
 * team -> teams[0]), a valid `?teamId` is remembered, and the header
 * switcher keeps writing the same `agent-tasks:lastTeamId` key via
 * rememberTeam. Mock/render pattern mirrors TasksPageDemote.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
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

import TeamsPage from "../../src/app/teams/page";
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

// jsdom has no scrollIntoView; the Select listbox scrolls on open.
Element.prototype.scrollIntoView = () => {};

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

describe("/teams page — current-team resolution (lib/currentTeam)", () => {
  it("a remembered team beats teams[0] when the URL carries no teamId", async () => {
    window.localStorage.setItem("agent-tasks:lastTeamId", "t2");

    render(<TeamsPage />);
    await screen.findByRole("combobox", { name: "Switch team" });

    await waitFor(() => expect(mockGetProjects).toHaveBeenCalledWith("t2"));
    expect(await screen.findByRole("heading", { name: "Team Two" })).toBeInTheDocument();
  });

  it("a valid ?teamId wins over the remembered team and is remembered", async () => {
    navState.search = "teamId=t2";
    window.localStorage.setItem("agent-tasks:lastTeamId", "t1");

    render(<TeamsPage />);
    await screen.findByRole("combobox", { name: "Switch team" });

    expect(mockGetProjects).toHaveBeenCalledWith("t2");
    expect(await screen.findByRole("heading", { name: "Team Two" })).toBeInTheDocument();
    // URL-selected team becomes the remembered one (same key as the switcher).
    expect(window.localStorage.getItem("agent-tasks:lastTeamId")).toBe("t2");
  });

  it("an invalid ?teamId falls through to the remembered team", async () => {
    navState.search = "teamId=ghost";
    window.localStorage.setItem("agent-tasks:lastTeamId", "t2");

    render(<TeamsPage />);
    await screen.findByRole("combobox", { name: "Switch team" });

    expect(mockGetProjects).toHaveBeenCalledWith("t2");
  });

  it("the header switcher remembers the picked team", async () => {
    render(<TeamsPage />);
    const trigger = await screen.findByRole("combobox", { name: "Switch team" });
    await waitFor(() => expect(mockGetProjects).toHaveBeenCalledWith("t1"));

    fireEvent.click(trigger);
    const option = await screen.findByRole("option", { name: "Team Two" });
    fireEvent.click(option);

    await waitFor(() => expect(mockGetProjects).toHaveBeenCalledWith("t2"));
    expect(window.localStorage.getItem("agent-tasks:lastTeamId")).toBe("t2");
  });
});
