/** @vitest-environment jsdom */
/**
 * /home stat strip + widget grid — shared D1 order (T-001, agent-tasks
 * f1112ab1-8864-40d0-a689-64532011caa4).
 *
 * Both surfaces render the same `homeScopes` list in home/page.tsx, in
 * the D1 order: My Tasks, Priority, Backlog, Open Tasks, In Review,
 * Recently Done. This test pins the DOM order of the stat-tile labels
 * and the widget h2 titles so a future edit that reorders one surface
 * (or swaps two entries in the shared list) turns this red.
 *
 * Mock/render pattern mirrors HomePage.statStrip.backlog.test.tsx: the
 * page mocks `src/lib/api` wholesale and stubs `next/navigation`'s
 * useRouter so the page can mount without a real router.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { User, Team, Task, TeamTasksProject, TeamTasksCounts } from "../../src/lib/api";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  getTeamTasks: vi.fn(),
}));

import HomeDashboardPage from "../../src/app/home/page";
import { getCurrentUser, getTeams, getTeamTasks } from "../../src/lib/api";

const mockGetCurrentUser = vi.mocked(getCurrentUser);
const mockGetTeams = vi.mocked(getTeams);
const mockGetTeamTasks = vi.mocked(getTeamTasks);

function makeUser(over: Partial<User> = {}): User {
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
    ...over,
  };
}

function makeTeam(over: Partial<Team> = {}): Team {
  return {
    id: "team-1",
    name: "Pandora",
    slug: "pandora",
    role: "ADMIN",
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function makeProject(over: Partial<TeamTasksProject> = {}): TeamTasksProject {
  return { id: "proj-1", name: "Agent Tasks", slug: "agent-tasks", accessSource: "team", ...over };
}

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    projectId: "proj-1",
    title: "A task",
    description: null,
    status: "open",
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
    ...over,
  };
}

function makeCounts(over: Partial<TeamTasksCounts> = {}): TeamTasksCounts {
  return {
    open: 0,
    review: 0,
    done: 0,
    priority: 0,
    mine: 0,
    total: 0,
    ...over,
  };
}

// D1: My Tasks, Priority, Backlog, Open Tasks, In Review, Recently Done.
const EXPECTED_STAT_LABELS = ["Mine", "Priority", "Backlog", "Open", "In Review", "Recently Done"];
const EXPECTED_WIDGET_TITLES = [
  "My Tasks",
  "Priority (High / Critical)",
  "Backlog",
  "Open Tasks",
  "In Review",
  "Recently Done",
];

async function renderHomePage() {
  mockGetCurrentUser.mockResolvedValue(makeUser());
  mockGetTeams.mockResolvedValue([makeTeam()]);
  mockGetTeamTasks.mockResolvedValue({
    tasks: [makeTask({ id: "t1", status: "open" })],
    projects: [makeProject()],
    counts: makeCounts({ open: 1 }),
  });

  render(<HomeDashboardPage />);
  await vi.waitFor(() => {
    expect(document.querySelector(".home-stat-strip")).not.toBeNull();
    expect(document.querySelector(".home-widgets-grid")).not.toBeNull();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("home page — shared scope order (stat strip + widget grid)", () => {
  it("renders the stat tiles in D1 order", async () => {
    await renderHomePage();

    const strip = document.querySelector(".home-stat-strip");
    if (!strip) throw new Error("stat strip not found");
    const labels = Array.from(strip.querySelectorAll(".home-stat-tile-label")).map(
      (el) => el.textContent,
    );

    expect(labels).toEqual(EXPECTED_STAT_LABELS);
  });

  it("renders the widget grid in D1 order (same order as the stat strip)", async () => {
    await renderHomePage();

    const grid = document.querySelector(".home-widgets-grid");
    if (!grid) throw new Error("widget grid not found");
    const titles = Array.from(grid.querySelectorAll(".home-widget-title")).map(
      (el) => el.textContent,
    );

    expect(titles).toEqual(EXPECTED_WIDGET_TITLES);
  });
});

describe("home page — widget plumbing", () => {
  it("(a) Backlog widget title link and more-link href end with &status=backlog (moreHrefOverride)", async () => {
    await renderHomePage();

    const grid = document.querySelector(".home-widgets-grid");
    if (!grid) throw new Error("widget grid not found");

    // Find the Backlog widget (third widget in D1 order)
    const widgets = Array.from(grid.querySelectorAll(".home-widget-card"));
    const backlogWidget = widgets[2]; // My Tasks, Priority, then Backlog
    if (!backlogWidget) throw new Error("Backlog widget not found");

    // Check title link href
    const titleLink = backlogWidget.querySelector(".home-widget-title-link") as HTMLAnchorElement;
    expect(titleLink).not.toBeNull();
    expect(titleLink.href).toContain("status=backlog");

    // Check more-link href
    const moreLink = backlogWidget.querySelector(".home-widget-more") as HTMLAnchorElement;
    expect(moreLink).not.toBeNull();
    expect(moreLink.href).toContain("status=backlog");
  });

  it("(b) Recently Done widget shows link to scope=done&recency=older when olderCount > 0", async () => {
    mockGetCurrentUser.mockResolvedValue(makeUser());
    mockGetTeams.mockResolvedValue([makeTeam()]);
    mockGetTeamTasks.mockResolvedValue({
      tasks: [
        makeTask({ id: "t1", status: "done", updatedAt: new Date().toISOString() }),
        makeTask({ id: "t2", status: "done", updatedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() }),
      ],
      projects: [makeProject()],
      counts: makeCounts({
        doneRecent: 1,
        doneOlder: 1, // Ensures olderCount > 0
      }),
    });

    render(<HomeDashboardPage />);
    await vi.waitFor(() => {
      expect(document.querySelector(".home-stat-strip")).not.toBeNull();
      expect(document.querySelector(".home-widgets-grid")).not.toBeNull();
    });

    const grid = document.querySelector(".home-widgets-grid");
    if (!grid) throw new Error("widget grid not found");

    // Find the Recently Done widget (last widget in D1 order)
    const widgets = Array.from(grid.querySelectorAll(".home-widget-card"));
    const doneWidget = widgets[5]; // Six widgets total, Recently Done is last
    if (!doneWidget) throw new Error("Recently Done widget not found");

    // Check for the older done link
    const olderLinks = Array.from(doneWidget.querySelectorAll(".widget-link")) as HTMLAnchorElement[];
    const olderLink = olderLinks.find((link) => link.href.includes("recency=older"));
    expect(olderLink).not.toBeNull();
    expect(olderLink?.href).toContain("scope=done");
    expect(olderLink?.href).toContain("recency=older");
  });

  it("(c) Empty state action buttons render with correct hrefs when mine and open slices are empty", async () => {
    mockGetCurrentUser.mockResolvedValue(makeUser({ id: "u-1" }));
    mockGetTeams.mockResolvedValue([makeTeam()]);
    mockGetTeamTasks.mockResolvedValue({
      tasks: [], // No tasks: mine and open will both be empty
      projects: [makeProject()],
      counts: makeCounts({
        mine: 0,
        open: 0,
        priority: 0,
        review: 0,
        doneRecent: 0,
      }),
    });

    render(<HomeDashboardPage />);
    await vi.waitFor(() => {
      expect(document.querySelector(".home-stat-strip")).not.toBeNull();
      expect(document.querySelector(".home-widgets-grid")).not.toBeNull();
    });

    const grid = document.querySelector(".home-widgets-grid");
    if (!grid) throw new Error("widget grid not found");

    // Find the My Tasks widget (first widget in D1 order) - should have "Browse open tasks" button
    const widgets = Array.from(grid.querySelectorAll(".home-widget-card"));
    const myTasksWidget = widgets[0];
    if (!myTasksWidget) throw new Error("My Tasks widget not found");

    // Check for "Browse open tasks" button with href containing scope=open
    const browseOpenButton = Array.from(myTasksWidget.querySelectorAll("a, button")).find(
      (el) => el.textContent?.includes("Browse open tasks")
    ) as HTMLAnchorElement | null;
    expect(browseOpenButton).not.toBeNull();
    expect(browseOpenButton?.href).toContain("scope=open");

    // Find the Open Tasks widget (fourth widget in D1 order) - should have "View all tasks" button
    const openTasksWidget = widgets[3];
    if (!openTasksWidget) throw new Error("Open Tasks widget not found");

    // Check for "View all tasks" button with href containing scope=all
    const viewAllButton = Array.from(openTasksWidget.querySelectorAll("a, button")).find(
      (el) => el.textContent?.includes("View all tasks")
    ) as HTMLAnchorElement | null;
    expect(viewAllButton).not.toBeNull();
    expect(viewAllButton?.href).toContain("scope=all");
  });
});
