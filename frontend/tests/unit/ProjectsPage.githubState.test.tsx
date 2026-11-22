/** @vitest-environment jsdom */
/**
 * /projects: the GitHub connection state comes from `githubConnected` alone.
 * A user without a usable connection (never made, or a stored token that can
 * no longer be read, which `/auth/me` reports the same way) sees the Connect
 * button and banner and no Sync button; a connected user sees Sync and no banner.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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
  getWorkflows: vi.fn().mockResolvedValue([]),
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

const TEAM: Team = {
  id: "t1",
  name: "Team One",
  slug: "team-one",
  role: "ADMIN",
  createdAt: "2026-01-01T00:00:00Z",
};

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
  nav.reset("/projects");
  window.localStorage.clear();
  vi.mocked(getTeams).mockResolvedValue([TEAM]);
  vi.mocked(getProjects).mockResolvedValue([PROJECT]);
  vi.mocked(getTasks).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("/projects page: GitHub connection state", () => {
  it("not connected: a Connect GitHub button, the banner with a settings link, no Sync button", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ ...USER, githubConnected: false });
    render(<ProjectsPage />);
    await screen.findAllByText("Agent Tasks");

    expect(screen.getByRole("link", { name: "Connect GitHub" })).toHaveAttribute(
      "href",
      "/api/auth/github/connect",
    );
    expect(screen.getByText("GitHub is not connected")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect now" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sync GitHub" })).not.toBeInTheDocument();
  });

  it("connected: a Sync GitHub button and no Connect button or banner", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ ...USER, githubConnected: true });
    render(<ProjectsPage />);
    await screen.findAllByText("Agent Tasks");

    expect(screen.getByRole("button", { name: "Sync GitHub" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Connect GitHub" })).not.toBeInTheDocument();
    expect(screen.queryByText("GitHub is not connected")).not.toBeInTheDocument();
  });
});
