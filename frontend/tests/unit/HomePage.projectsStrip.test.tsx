/** @vitest-environment jsdom */
/**
 * /home "Your projects" jump strip (T05, agent-tasks-ui-ia S1).
 *
 * Pins the strip's behaviour: recents-first ordering (localStorage recents
 * in recorded order, then the remaining projects in the getTeamTasks order),
 * the 6-item cap, the board-href form, the "All projects" link, the
 * per-project open/in_progress count under the truncation rule (shown only
 * when counts is present AND counts.total <= allTasks.length — never a
 * wrong number), the zero-project empty state, and that the strip only
 * appears after the task aggregation resolved (no empty-state flash).
 *
 * Mock/render pattern mirrors HomePage.scopeOrder.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, waitFor } from "@testing-library/react";
import type {
  User,
  Team,
  Task,
  TeamTasksProject,
  TeamTasksCounts,
  TeamTasksResponse,
  Project,
} from "../../src/lib/api";
import { readRecentProjects, recordRecentProject } from "../../src/lib/recentProjects";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
const boardState = vi.hoisted(() => ({ projectId: "p1" }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams(""),
  useParams: () => ({ id: boardState.projectId }),
  usePathname: () => `/projects/${boardState.projectId}/board`,
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    getCurrentUser: vi.fn(),
    getTeams: vi.fn(),
    getProjects: vi.fn(),
    getTeamTasks: vi.fn(),
    getProject: vi.fn(),
    getTasks: vi.fn(),
    getTask: vi.fn(),
    getEffectiveWorkflow: vi.fn(),
  };
});

import HomeDashboardPageRaw from "../../src/app/home/page";
import { withTeamList } from "./helpers/withTeamList";
const HomeDashboardPage = withTeamList(HomeDashboardPageRaw);
import ProjectBoardPage from "../../src/app/projects/[id]/board/page";
import { ToastProvider } from "../../src/components/ui/Toast";
import {
  getCurrentUser,
  getProjects,
  getProject,
  getTasks,
  getTeams,
  getTeamTasks,
} from "../../src/lib/api";

const mockGetCurrentUser = vi.mocked(getCurrentUser);
const mockGetTeams = vi.mocked(getTeams);
const mockGetProjects = vi.mocked(getProjects);
const mockGetTeamTasks = vi.mocked(getTeamTasks);
const mockGetProject = vi.mocked(getProject);
const mockGetTasks = vi.mocked(getTasks);

function makeUser(): User {
  return {
    id: "u-1",
    login: "lan",
    name: "Lan",
    avatarUrl: null,
    email: "lan@example.com",
    githubConnected: false,
    allowAgentPrCreate: false,
    allowAgentPrMerge: false,
    allowAgentPrComment: false,
  };
}

function makeTeam(): Team {
  return {
    id: "team-1",
    name: "Pandora",
    slug: "pandora",
    role: "ADMIN",
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function makeProject(id: string, over: Partial<TeamTasksProject> = {}): TeamTasksProject {
  return { id, name: `Project ${id}`, slug: id, accessSource: "team", ...over };
}

function makeTask(id: string, projectId: string, status: Task["status"]): Task {
  return {
    id,
    projectId,
    title: `Task ${id}`,
    description: null,
    status,
    priority: "MEDIUM",
    templateData: null,
    claimedByUserId: null,
    claimedByAgentId: null,
    claimedAt: null,
    dueAt: null,
    branchName: null,
    prUrl: null,
    prNumber: null,
    result: null,
    externalRef: null,
    labels: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    attachments: [],
  };
}

function makeCounts(over: Partial<TeamTasksCounts> = {}): TeamTasksCounts {
  return { open: 0, review: 0, done: 0, priority: 0, mine: 0, total: 0, ...over };
}

function stripItems(): HTMLAnchorElement[] {
  return Array.from(document.querySelectorAll(".home-projects-items .home-projects-item"));
}

function itemCounts(): string[] {
  return Array.from(document.querySelectorAll(".home-projects-item-count")).map(
    (el) => el.textContent,
  );
}

async function renderLoaded(response: TeamTasksResponse) {
  mockGetCurrentUser.mockResolvedValue(makeUser());
  mockGetTeams.mockResolvedValue([makeTeam()]);
  mockGetProjects.mockResolvedValue([]);
  mockGetTeamTasks.mockResolvedValue(response);

  render(<HomeDashboardPage />);
  await vi.waitFor(() => {
    expect(document.querySelector(".home-projects-strip")).not.toBeNull();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("home page — Your projects strip ordering", () => {
  it("lists recents first in recorded order, then the rest in getTeamTasks order", async () => {
    // API order p1..p4; visited p3 then p1 (p1 most recent).
    recordRecentProject("team-1", "p3");
    recordRecentProject("team-1", "p1");
    await renderLoaded({
      tasks: [],
      projects: [makeProject("p1"), makeProject("p2"), makeProject("p3"), makeProject("p4")],
      counts: makeCounts(),
    });

    expect(
      stripItems().map((a) => a.querySelector(".home-projects-item-name")?.textContent),
    ).toEqual(["Project p1", "Project p3", "Project p2", "Project p4"]);
  });

  it("links each project to its board (boardHref form)", async () => {
    await renderLoaded({
      tasks: [],
      projects: [makeProject("p1")],
      counts: makeCounts(),
    });

    const items = stripItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.getAttribute("href")).toBe("/projects/p1/board");
  });

  it("skips a recent id that is no longer in the team's projects", async () => {
    recordRecentProject("team-1", "gone");
    recordRecentProject("team-1", "p2");
    await renderLoaded({
      tasks: [],
      projects: [makeProject("p1"), makeProject("p2")],
      counts: makeCounts(),
    });

    expect(stripItems()).toHaveLength(2);
    expect(stripItems()[0]!.getAttribute("href")).toBe("/projects/p2/board");
  });

  it("caps the strip at 6 projects", async () => {
    const projects = Array.from({ length: 8 }, (_, i) => makeProject(`p${i + 1}`));
    await renderLoaded({ tasks: [], projects, counts: makeCounts() });

    const items = stripItems();
    expect(items).toHaveLength(6);
    expect(items.map((a) => a.getAttribute("href"))).toEqual([
      "/projects/p1/board",
      "/projects/p2/board",
      "/projects/p3/board",
      "/projects/p4/board",
      "/projects/p5/board",
      "/projects/p6/board",
    ]);
  });

  it("lists a shared project (accessSource project) like any other", async () => {
    await renderLoaded({
      tasks: [],
      projects: [makeProject("p1", { accessSource: "project" })],
      counts: makeCounts(),
    });
    expect(stripItems()[0]!.getAttribute("href")).toBe("/projects/p1/board");
  });
});

describe("home page — Your projects strip links", () => {
  it("links All projects to the team's Projects page", async () => {
    await renderLoaded({ tasks: [], projects: [makeProject("p1")], counts: makeCounts() });

    const all = screen.getByRole("link", { name: "View all projects" });
    expect(all.getAttribute("href")).toBe("/projects?teamId=team-1");
    // Quiet ViewAllLink: the visible label carries no arrow glyph.
    expect(all.textContent).toBe("All projects");
    expect(all).toHaveClass("view-all-link");
  });

  it("gives each item link a discernible name (project name in the label)", async () => {
    await renderLoaded({
      tasks: [makeTask("t1", "p1", "open")],
      projects: [makeProject("p1", { name: "Agent Tasks" })],
      counts: makeCounts({ total: 1 }),
    });

    const item = screen.getByRole("link", { name: "Agent Tasks, 1 active" });
    expect(item.getAttribute("href")).toBe("/projects/p1/board");
  });
});

describe("home page — Your projects strip counts", () => {
  it("shows open + in_progress counts per project when the aggregation is complete", async () => {
    await renderLoaded({
      tasks: [
        makeTask("t1", "p1", "open"),
        makeTask("t2", "p1", "in_progress"),
        makeTask("t3", "p1", "review"),
        makeTask("t4", "p2", "done"),
      ],
      projects: [makeProject("p1"), makeProject("p2"), makeProject("p3")],
      counts: makeCounts({ open: 2, total: 4 }),
    });

    expect(itemCounts()).toEqual(["2 active", "0 active", "0 active"]);
  });

  it("omits the counts when the aggregation is truncated (counts.total > loaded tasks)", async () => {
    await renderLoaded({
      tasks: [makeTask("t1", "p1", "open")],
      projects: [makeProject("p1")],
      // 500 total vs 1 loaded row: the DEFAULT_LIMIT=500 cap dropped tasks,
      // so the per-project tally below would be wrong.
      counts: makeCounts({ open: 250, total: 500 }),
    });

    expect(document.querySelector(".home-projects-item-count")).toBeNull();
    // The name is still a complete, sane link name.
    expect(stripItems()[0]!.getAttribute("aria-label")).toBe("Project p1");
  });

  it("omits the counts when the backend sends no counts block (forward-compat)", async () => {
    await renderLoaded({
      tasks: [makeTask("t1", "p1", "open")],
      projects: [makeProject("p1")],
    });

    expect(document.querySelector(".home-projects-item-count")).toBeNull();
  });
});

describe("home page — Your projects strip empty state", () => {
  it("with no projects: one line linking to the Projects page, no item chips", async () => {
    await renderLoaded({ tasks: [], projects: [], counts: makeCounts() });

    const empty = document.querySelector(".home-projects-empty");
    expect(empty).not.toBeNull();
    expect(stripItems()).toHaveLength(0);
    const link = empty!.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/projects?teamId=team-1");
  });

  it("does not render (no empty-state flash) while the aggregation is in flight", async () => {
    mockGetCurrentUser.mockResolvedValue(makeUser());
    mockGetTeams.mockResolvedValue([makeTeam()]);
    mockGetProjects.mockResolvedValue([]);
    // Never resolves: the page stays in the pre-tasksLoaded state.
    mockGetTeamTasks.mockReturnValue(new Promise<TeamTasksResponse>(() => {}));

    render(<HomeDashboardPage />);
    await vi.waitFor(() => {
      expect(document.querySelector(".home-scopes")).not.toBeNull();
    });

    expect(document.querySelector(".home-projects-strip")).toBeNull();
    expect(document.querySelector(".home-projects-empty")).toBeNull();
  });
});

describe("board page records a strip visit (AC2)", () => {
  const BOARD_PROJECT = {
    id: "p9",
    teamId: "team-1",
    name: "Board Project",
    slug: "board-project",
    githubRepo: null,
    accessRole: "ADMIN",
  } as unknown as Project;

  beforeEach(() => {
    boardState.projectId = "p9";
    mockGetCurrentUser.mockResolvedValue(makeUser());
    mockGetTasks.mockResolvedValue([]);
    vi.mocked(getProjects).mockResolvedValue([]);
  });

  async function openBoard() {
    mockGetProject.mockResolvedValue(BOARD_PROJECT);
    render(
      <ToastProvider>
        <ProjectBoardPage />
      </ToastProvider>,
    );
    await waitFor(() => {
      const ids = JSON.parse(
        window.localStorage.getItem("agent-tasks:recentProjects:team-1") ?? "[]",
      ) as string[];
      expect(ids[0]).toBe("p9");
    });
  }

  it("records the project under its team when the board loads", async () => {
    await openBoard();
    expect(window.localStorage.getItem("agent-tasks:recentProjects:team-1")).toBe(
      JSON.stringify(["p9"]),
    );
    // Keyed by team id, never by project id (the strip reads it by team).
    expect(window.localStorage.getItem("agent-tasks:recentProjects:p9")).toBeNull();
  });

  it("moves the project to the front over an older recent", async () => {
    recordRecentProject("team-1", "p8");
    await openBoard();
    expect(readRecentProjects("team-1")).toEqual(["p9", "p8"]);
  });
});
