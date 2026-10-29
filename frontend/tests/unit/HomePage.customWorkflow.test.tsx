/** @vitest-environment jsdom */
/**
 * /home Priority widget with a stored custom workflow: a custom open state is
 * shown, a custom terminal state is not, and the widget asks the team route
 * for the workflows' open states once it knows them. `getTeamTasks` is a small
 * fake of GET /teams/:teamId/tasks (status filter, newest first); `getWorkflows`
 * serves the project's stored workflow rows. Mock/render pattern mirrors
 * HomePage.scopedRequests.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { Team, Task, TeamTasksProject, TeamTasksResponse, User, Workflow } from "../../src/lib/api";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/home",
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  getTeamTasks: vi.fn(),
  getWorkflows: vi.fn(),
}));

import HomeDashboardPageRaw from "../../src/app/home/page";
import { withTeamList } from "./helpers/withTeamList";
const HomeDashboardPage = withTeamList(HomeDashboardPageRaw);
import { getCurrentUser, getTeams, getTeamTasks, getWorkflows } from "../../src/lib/api";

const mockGetCurrentUser = vi.mocked(getCurrentUser);
const mockGetTeams = vi.mocked(getTeams);
const mockGetTeamTasks = vi.mocked(getTeamTasks);
const mockGetWorkflows = vi.mocked(getWorkflows);

const DAY = 24 * 60 * 60 * 1000;
const ME = "u-1";

const USER = {
  id: ME,
  login: "lan",
  name: "Lan",
  avatarUrl: null,
  email: null,
  githubConnected: false,
  allowAgentPrCreate: false,
  allowAgentPrMerge: false,
  allowAgentPrComment: false,
} as User;

const TEAM = {
  id: "team-1",
  name: "Pandora",
  slug: "pandora",
  role: "ADMIN",
  createdAt: "2026-01-01T00:00:00Z",
} as Team;

const PROJECTS: TeamTasksProject[] = [
  { id: "p1", name: "Alpha", slug: "alpha", accessSource: "team" },
  { id: "p2", name: "Beta", slug: "beta", accessSource: "team" },
];

let seq = 0;
function makeTask(over: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `task-${seq}`,
    projectId: "p1",
    title: `Task ${seq}`,
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
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: new Date(Date.now() - DAY).toISOString(),
    attachments: [],
    ...over,
  };
}

const SEVEN = {
  id: "wf-seven",
  projectId: "p1",
  name: "Seven",
  isDefault: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  definition: {
    states: [
      { name: "open", label: "Open", terminal: false },
      { name: "qa", label: "QA", terminal: false },
      { name: "shipped", label: "Shipped", terminal: true },
    ],
    transitions: [],
    initialState: "open",
  },
} as Workflow;

function serve(dataset: Task[], statusParam: string | undefined): TeamTasksResponse {
  const statuses = statusParam?.split(",");
  const rows = dataset.filter((t) => !statuses || statuses.includes(t.status));
  return {
    tasks: rows,
    projects: PROJECTS,
    // Counts only decide whether a widget shows its empty state; the rows under test come from `tasks`.
    counts: { open: 9, review: 9, done: 9, doneRecent: 9, doneOlder: 0, priority: 9, mine: 9, backlog: 9, total: dataset.length },
    filteredTotal: rows.length,
  };
}

function priorityRequests(): (string | undefined)[] {
  return mockGetTeamTasks.mock.calls.filter((c) => c[1]?.priority === "CRITICAL,HIGH").map((c) => c[1]?.status);
}

function priorityTitles(): string[] {
  const heading = screen.getByRole("heading", { level: 2, name: "Priority (High / Critical)" });
  const card = heading.closest(".home-widget-card") as HTMLElement;
  return Array.from(card.querySelectorAll(".home-task-row")).map((r) => r.getAttribute("aria-label") ?? "");
}

async function renderHome() {
  render(<HomeDashboardPage />);
  await vi.waitFor(() => {
    expect(document.querySelector(".home-widgets-grid")).not.toBeNull();
  });
}

const DATASET = () => [
  makeTask({ title: "needs qa", status: "qa", priority: "HIGH", projectId: "p1" }),
  makeTask({ title: "already shipped", status: "shipped", priority: "CRITICAL", projectId: "p1" }),
  makeTask({ title: "plain open", status: "open", priority: "HIGH", projectId: "p1" }),
  makeTask({ title: "other project review", status: "review", priority: "HIGH", projectId: "p2" }),
  makeTask({ title: "other project done", status: "done", priority: "HIGH", projectId: "p2" }),
  makeTask({ title: "medium qa", status: "qa", priority: "MEDIUM", projectId: "p1" }),
];

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  seq = 0;
  mockGetCurrentUser.mockResolvedValue(USER);
  mockGetTeams.mockResolvedValue([TEAM]);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  window.localStorage.clear();
});

describe("home page: Priority widget follows the project workflows", () => {
  it("shows a custom open state, hides a custom terminal state and asks for the open states", async () => {
    const dataset = DATASET();
    mockGetTeamTasks.mockImplementation(async (_t, opts) => serve(dataset, opts?.status));
    mockGetWorkflows.mockImplementation(async (projectId) => (projectId === "p1" ? [SEVEN] : []));
    await renderHome();
    await vi.waitFor(() => {
      expect(priorityTitles().some((t) => t.startsWith("needs qa"))).toBe(true);
    });

    const titles = priorityTitles();
    expect(titles.some((t) => t.startsWith("plain open"))).toBe(true);
    expect(titles.some((t) => t.startsWith("other project review"))).toBe(true);
    expect(titles.some((t) => t.startsWith("already shipped"))).toBe(false);
    expect(titles.some((t) => t.startsWith("other project done"))).toBe(false);
    expect(titles.some((t) => t.startsWith("medium qa"))).toBe(false);
    // First request before the workflows are known, then once with the custom open state.
    expect(priorityRequests()).toEqual(["open,in_progress,review", "open,in_progress,review,qa"]);
    expect(mockGetWorkflows.mock.calls.map((c) => c[0]).sort()).toEqual(["p1", "p2"]);
  });

  it("does not show a custom terminal state a response returns anyway", async () => {
    // A response that ignores the status filter must not put a finished task in the widget.
    const dataset = DATASET();
    mockGetTeamTasks.mockImplementation(async () => serve(dataset, undefined));
    mockGetWorkflows.mockImplementation(async (projectId) => (projectId === "p1" ? [SEVEN] : []));
    await renderHome();
    await vi.waitFor(() => {
      expect(mockGetWorkflows).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(priorityTitles().some((t) => t.startsWith("needs qa"))).toBe(true);
    });
    expect(priorityTitles().some((t) => t.startsWith("already shipped"))).toBe(false);
  });

  it("falls back to the built-in workflow when the workflows cannot be read", async () => {
    const dataset = DATASET();
    mockGetTeamTasks.mockImplementation(async (_t, opts) => serve(dataset, opts?.status));
    mockGetWorkflows.mockRejectedValue(new Error("403"));
    await renderHome();
    await vi.waitFor(() => {
      expect(mockGetWorkflows).toHaveBeenCalled();
    });
    expect(priorityRequests()).toEqual(["open,in_progress,review"]);
    const titles = priorityTitles();
    expect(titles.some((t) => t.startsWith("plain open"))).toBe(true);
    expect(titles.some((t) => t.startsWith("needs qa"))).toBe(false);
  });

  it("keeps the four-state requests when the projects only have the built-in workflow", async () => {
    const dataset = DATASET();
    mockGetTeamTasks.mockImplementation(async (_t, opts) => serve(dataset, opts?.status));
    mockGetWorkflows.mockResolvedValue([]);
    await renderHome();
    await vi.waitFor(() => {
      expect(mockGetWorkflows).toHaveBeenCalledTimes(2);
    });
    expect(priorityRequests()).toEqual(["open,in_progress,review"]);
    expect(mockGetTeamTasks).toHaveBeenCalledTimes(6);
  });
});
