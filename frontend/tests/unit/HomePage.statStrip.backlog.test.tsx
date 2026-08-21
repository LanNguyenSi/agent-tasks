/** @vitest-environment jsdom */
/**
 * /home stat strip — Backlog tile (T-004, agent-tasks fc7959a8).
 *
 * Full-page render (src/lib/api mocked wholesale via vi.mock, matching the
 * pattern in SettingsPage.tokenRename.test.tsx / TaskDetail.variant.test.tsx)
 * rather than a component extraction: the stat strip's tiles are inline in
 * HomeDashboardPage and read state (`counts`, `allTasks`) that lives in that
 * page, so pulling the strip out would be a structural change beyond this
 * task's scope. `next/navigation`'s `useRouter` is stubbed so the page can
 * mount without a real router.
 *
 * Covers:
 *   - The Backlog tile renders `counts.backlog` when the server supplies it
 *     (mutation probe: swapping the tile's source to another counts field,
 *     e.g. counts.review, or to a literal 0, turns this red).
 *   - Fallback: when the server response omits `counts.backlog` (older
 *     backend, forward-compat), the tile falls back to a client-side count
 *     of loaded tasks with status "backlog" instead of crashing or
 *     rendering NaN/undefined (mutation probe: replacing the client-side
 *     count with 0 turns this red).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
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

async function renderHomePage() {
  render(<HomeDashboardPage />);
  // Wait for the stat strip to appear (bootstrap + task fetch resolved).
  // "Backlog" labels both the stat tile and the widget title further down,
  // so wait on all matches rather than a single findByText.
  await vi.waitFor(() => {
    expect(screen.getAllByText("Backlog").length).toBeGreaterThanOrEqual(2);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(makeUser());
  mockGetTeams.mockResolvedValue([makeTeam()]);
});

afterEach(() => {
  cleanup();
});

function backlogTileNumber(): string {
  // "Backlog" also labels the widget's <h2> title further down the page;
  // the stat-tile label carries the home-stat-tile-label class.
  const label = screen
    .getAllByText("Backlog")
    .find((el) => el.className === "home-stat-tile-label");
  if (!label) throw new Error("Backlog stat-tile label not found");
  const tile = label.closest("a");
  if (!tile) throw new Error("Backlog tile <a> not found");
  return within(tile).getByText(/^\d+$/).textContent ?? "";
}

describe("home stat strip — Backlog tile", () => {
  it("renders counts.backlog from the server, independent of loaded task rows", async () => {
    mockGetTeamTasks.mockResolvedValue({
      tasks: [makeTask({ id: "t1", status: "backlog" })], // only 1 loaded row
      projects: [makeProject()],
      counts: makeCounts({ backlog: 7, open: 3 }), // server total says 7
    });

    await renderHomePage();

    expect(backlogTileNumber()).toBe("7");
  });

  it("falls back to a client-side count of backlog-status tasks when counts.backlog is absent (older backend)", async () => {
    mockGetTeamTasks.mockResolvedValue({
      tasks: [
        makeTask({ id: "t1", status: "backlog" }),
        makeTask({ id: "t2", status: "backlog" }),
        makeTask({ id: "t3", status: "open" }),
      ],
      projects: [makeProject()],
      counts: makeCounts({ open: 1 }), // no `backlog` field at all
    });

    await renderHomePage();

    expect(backlogTileNumber()).toBe("2");
  });
});
