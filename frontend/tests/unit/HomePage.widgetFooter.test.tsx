/** @vitest-environment jsdom */
/**
 * /home widget footer row and the empty-state links, without text arrows.
 *
 * Branches pinned here (each with role, accessible name and exact href):
 * moreCount > 0 only; olderCount > 0 only (with rows); both in ONE footer
 * row; displayTotal === 0 with older tasks (empty-state action); displayTotal
 * === 0 with zero older tasks (NO empty-state action); the
 * projects strip with zero projects. Links whose hrefs differ must never
 * share an accessible name, and every accessible name contains its visible
 * text (WCAG 2.5.3). Mock/render pattern mirrors
 * HomePage.scopedRequests.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type {
  Team,
  Task,
  TeamTasksCounts,
  TeamTasksProject,
  TeamTasksResponse,
  User,
} from "../../src/lib/api";

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
}));

import HomeDashboardPageRaw from "../../src/app/home/page";
import { withTeamList } from "./helpers/withTeamList";
const HomeDashboardPage = withTeamList(HomeDashboardPageRaw);
import { getCurrentUser, getTeams, getTeamTasks } from "../../src/lib/api";

const mockGetCurrentUser = vi.mocked(getCurrentUser);
const mockGetTeams = vi.mocked(getTeams);
const mockGetTeamTasks = vi.mocked(getTeamTasks);

type Opts = NonNullable<Parameters<typeof getTeamTasks>[1]>;

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

function many(n: number, over: (i: number) => Partial<Task>): Task[] {
  return Array.from({ length: n }, (_, i) => makeTask(over(i)));
}

const ACTIVE = new Set(["open", "in_progress"]);

/** The backend route over an in-memory team (same fake as scopedRequests). */
function serve(dataset: Task[], opts: Opts = {}, projects = PROJECTS): TeamTasksResponse {
  const boundary = Date.now() - 14 * DAY;
  const statuses = opts.status?.split(",");
  const rows = dataset.filter((t) => {
    if (statuses && !statuses.includes(t.status)) return false;
    if (opts.mine && t.claimedByUserId !== ME) return false;
    if (opts.recency === "recent" && new Date(t.updatedAt).getTime() < boundary) return false;
    if (opts.recency === "older" && new Date(t.updatedAt).getTime() >= boundary) return false;
    return true;
  });
  const filteredTotal = rows.length;
  const limit = Math.min(opts.limit ?? 500, 1000);
  const done = dataset.filter((t) => t.status === "done");
  const counts: TeamTasksCounts = {
    open: dataset.filter((t) => ACTIVE.has(t.status)).length,
    review: dataset.filter((t) => t.status === "review").length,
    done: done.length,
    doneRecent: done.filter((t) => new Date(t.updatedAt).getTime() >= boundary).length,
    doneOlder: done.filter((t) => new Date(t.updatedAt).getTime() < boundary).length,
    priority: 0,
    mine: 0,
    backlog: dataset.filter((t) => t.status === "backlog").length,
    total: dataset.length,
  };
  return { tasks: rows.slice(0, limit), projects, counts, filteredTotal };
}

function serveDataset(dataset: Task[], projects = PROJECTS) {
  mockGetTeamTasks.mockImplementation(async (_teamId, opts) => serve(dataset, opts, projects));
}

async function renderHome() {
  render(<HomeDashboardPage />);
  await vi.waitFor(() => {
    expect(document.querySelector(".home-widgets-grid")).not.toBeNull();
  });
}

function widget(title: string): HTMLElement {
  const heading = screen.getByRole("heading", { level: 2, name: title });
  return heading.closest(".home-widget-card") as HTMLElement;
}

function footers(title: string): Element[] {
  return Array.from(widget(title).querySelectorAll(".home-widget-footer"));
}

const OLDER_HREF = "/tasks?teamId=team-1&scope=done&recency=older";

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

describe("home widget footer row", () => {
  it("moreCount > 0 only: one footer row with the named overflow link, no arrow glyph", async () => {
    // 12 backlog tasks, 10-row widget cap: 2 rows are not shown.
    serveDataset(many(12, () => ({ status: "backlog" as const })));
    await renderHome();

    const link = screen.getByRole("link", { name: "Backlog: 2 more in Tasks" });
    expect(link.getAttribute("href")).toBe("/tasks?teamId=team-1&status=backlog");
    // Visible text is contained in the accessible name (WCAG 2.5.3) and
    // carries no arrow glyph; the arrow is the aria-hidden Icon.
    expect(link.textContent).toBe("2 more in Tasks");
    const icon = link.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon!.getAttribute("aria-hidden")).toBe("true");
    // One footer row in the widget, holding this single link.
    const footers_ = footers("Backlog");
    expect(footers_).toHaveLength(1);
    expect(footers_[0]!.querySelectorAll("a")).toHaveLength(1);
    // The header View all link has a different name for the same href.
    expect(screen.getByRole("link", { name: "View all Backlog" })).not.toBeNull();
  });

  it("olderCount > 0 only (with rows): one footer row with the quieter older link", async () => {
    // 2 recent done rows + 3 older done tasks: recent window full, no overflow.
    serveDataset([
      ...many(2, () => ({ status: "done" as const })),
      ...many(3, () => ({
        status: "done" as const,
        updatedAt: new Date(Date.now() - 30 * DAY).toISOString(),
      })),
    ]);
    await renderHome();

    const link = screen.getByRole("link", { name: "Done \u00b7 14 days: 3 older than 14 days" });
    expect(link.getAttribute("href")).toBe(OLDER_HREF);
    expect(link.textContent).toBe("3 older than 14 days");
    const footers_ = footers("Done \u00b7 14 days");
    expect(footers_).toHaveLength(1);
    expect(footers_[0]!.querySelectorAll("a")).toHaveLength(1);
  });

  it("both counts at once: ONE footer row holding the overflow link and the older link", async () => {
    // 6 recent done rows on screen while the team-wide recent count is 12,
    // plus 3 older done tasks.
    const dataset = many(6, () => ({ status: "done" as const }));
    mockGetTeamTasks.mockImplementation(async (_teamId, opts) => {
      const base = serve(dataset, opts);
      return { ...base, counts: { ...base.counts!, doneRecent: 12, doneOlder: 3 } };
    });
    await renderHome();

    const footers_ = footers("Done \u00b7 14 days");
    expect(footers_).toHaveLength(1);
    const links = Array.from(footers_[0]!.querySelectorAll("a"));
    expect(links).toHaveLength(2);

    const more = screen.getByRole("link", { name: "Done \u00b7 14 days: 6 more in Tasks" });
    expect(more.getAttribute("href")).toBe("/tasks?teamId=team-1&scope=done&recency=recent");
    expect(more.textContent).toBe("6 more in Tasks");

    const older = screen.getByRole("link", { name: "Done \u00b7 14 days: 3 older than 14 days" });
    expect(older.getAttribute("href")).toBe(OLDER_HREF);
    expect(older.textContent).toBe("3 older than 14 days");

    // Different hrefs, different names, both names carry the widget title.
    expect(more.getAttribute("href")).not.toBe(older.getAttribute("href"));
  });

  it("no overflow and no older tasks: the footer row itself is not rendered", async () => {
    // 3 backlog rows, all of the total shown; Done has nothing.
    serveDataset(many(3, () => ({ status: "backlog" as const })));
    await renderHome();

    expect(footers("Backlog")).toHaveLength(0);
    expect(footers("Done \u00b7 14 days")).toHaveLength(0);
  });
});

describe("home Done widget empty state", () => {
  it("shows the reveal as an empty-state action, not a text-arrow link", async () => {
    // Only older done tasks exist: the recent window is empty.
    serveDataset(
      many(2, () => ({
        status: "done" as const,
        updatedAt: new Date(Date.now() - 30 * DAY).toISOString(),
      })),
    );
    await renderHome();

    const emptyTitle = screen.getByText("No tasks completed in the last 14 days.");
    const button = screen.getByRole("link", {
      name: "Show 2 older done tasks in Done \u00b7 14 days",
    });
    expect(emptyTitle.closest(".empty-state")!.contains(button)).toBe(true);
    expect(button.getAttribute("href")).toBe(OLDER_HREF);
    expect(button.textContent).toBe("Show 2 older done");
    // Same look as the other empty-state actions: ghost Button, sm.
    expect(button).toHaveClass("btn-ghost", "btn--sm");
    // No footer row while the widget is empty.
    expect(footers("Done \u00b7 14 days")).toHaveLength(0);
  });

  it("empty with zero older tasks: the empty state shows no older-done action", async () => {
    // Nothing done at all: the action must stay undefined, never a
    // "Show 0 older done" CTA.
    serveDataset(many(2, () => ({ status: "backlog" as const })));
    await renderHome();

    expect(screen.getByText("No tasks completed in the last 14 days.")).not.toBeNull();
    expect(screen.queryByRole("link", { name: /older done/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /older done/i })).toBeNull();
  });
});

describe("home projects strip empty state", () => {
  it("zero projects: plain inline 'Go to Projects' link, same href, no arrow", async () => {
    serveDataset([], []);
    await renderHome();

    const link = screen.getByRole("link", { name: "Go to Projects" });
    expect(link.getAttribute("href")).toBe("/projects?teamId=team-1");
    expect(link.textContent).toBe("Go to Projects");
    expect(link).toHaveClass("settings-inline-link");
  });
});
