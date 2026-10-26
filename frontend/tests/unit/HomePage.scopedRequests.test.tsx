/** @vitest-environment jsdom */
/**
 * /home counts and rows: every widget is filled by its own scoped request, the
 * "+N more" link counts rows not shown, the stale-data alert exists only while
 * the warning is active, and the labels carry the shared "Active" definition
 * and the done window.
 *
 * `getTeamTasks` is replaced by a small fake of the backend route
 * (GET /teams/:teamId/tasks): it honours status, priority, mine, recency and
 * limit, returns rows newest-update first, caps a page at 500 rows like the
 * real default, and computes team-wide `counts` independent of the filters.
 * Mock/render pattern mirrors HomePage.statStrip.backlog.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, within, fireEvent } from "@testing-library/react";
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

import HomeDashboardPage from "../../src/app/home/page";
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

function many(n: number, over: (i: number) => Partial<Task>): Task[] {
  return Array.from({ length: n }, (_, i) => makeTask(over(i)));
}

const ACTIVE = new Set(["open", "in_progress"]);

/** The backend route over an in-memory team: filters, newest first, 500-row cap. */
function serve(dataset: Task[], opts: Opts = {}): TeamTasksResponse {
  const boundary = Date.now() - 14 * DAY;
  const statuses = opts.status?.split(",");
  const priorities = opts.priority?.split(",");
  let rows = dataset.filter((t) => {
    if (statuses && !statuses.includes(t.status)) return false;
    if (priorities && !priorities.includes(t.priority)) return false;
    if (opts.mine && t.claimedByUserId !== ME) return false;
    if (opts.recency === "recent" && new Date(t.updatedAt).getTime() < boundary) return false;
    if (opts.recency === "older" && new Date(t.updatedAt).getTime() >= boundary) return false;
    return true;
  });
  const filteredTotal = rows.length;
  rows = [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const limit = Math.min(opts.limit ?? 500, 1000);
  const done = dataset.filter((t) => t.status === "done");
  const counts: TeamTasksCounts = {
    open: dataset.filter((t) => ACTIVE.has(t.status)).length,
    review: dataset.filter((t) => t.status === "review").length,
    done: done.length,
    doneRecent: done.filter((t) => new Date(t.updatedAt).getTime() >= boundary).length,
    doneOlder: done.filter((t) => new Date(t.updatedAt).getTime() < boundary).length,
    priority: dataset.filter(
      (t) =>
        (t.priority === "HIGH" || t.priority === "CRITICAL") &&
        ["open", "in_progress", "review"].includes(t.status),
    ).length,
    mine: dataset.filter(
      (t) => t.claimedByUserId === ME && t.status !== "done" && t.status !== "abandoned",
    ).length,
    backlog: dataset.filter((t) => t.status === "backlog").length,
    total: dataset.length,
  };
  return { tasks: rows.slice(0, limit), projects: PROJECTS, counts, filteredTotal };
}

function serveDataset(dataset: Task[]) {
  mockGetTeamTasks.mockImplementation(async (_teamId, opts) => serve(dataset, opts));
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

function rowCount(title: string): number {
  return widget(title).querySelectorAll(".home-task-row").length;
}

function footerLinks(title: string): string[] {
  return Array.from(widget(title).querySelectorAll(".home-widget-footer a")).map(
    (a) => a.textContent ?? "",
  );
}

function headerTotal(title: string): string {
  return widget(title).querySelector(".home-widget-more")?.textContent ?? "";
}

/** Run the page's 15 s poll once, now. */
async function pollNow(spy: { mock: { calls: unknown[][] } }) {
  const call = spy.mock.calls.find((c) => c[1] === 15_000);
  if (!call) throw new Error("no 15 s poll registered");
  await act(async () => {
    (call[0] as () => void)();
  });
}

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

describe("home page: one scoped request per widget", () => {
  it("asks for each widget's own scope, with its limit", async () => {
    serveDataset([makeTask()]);
    await renderHome();

    const calls = mockGetTeamTasks.mock.calls;
    expect(calls).toHaveLength(6);
    expect(calls.every((c) => c[0] === "team-1")).toBe(true);
    const opts = calls.map((c) => c[1]);
    expect(opts).toEqual(
      expect.arrayContaining([
        { status: "backlog,open,in_progress,review", mine: true, limit: 10 },
        { status: "open,in_progress,review", priority: "CRITICAL,HIGH", limit: 10 },
        { status: "backlog", limit: 10 },
        { status: "open,in_progress", limit: 500 },
        { status: "review", limit: 10 },
        { status: "done", recency: "recent", limit: 10 },
      ]),
    );
  });

  it("repeats all six requests on every 15 s poll", async () => {
    serveDataset([makeTask()]);
    const interval = vi.spyOn(globalThis, "setInterval");
    await renderHome();
    expect(mockGetTeamTasks).toHaveBeenCalledTimes(6);

    await pollNow(interval);
    expect(mockGetTeamTasks).toHaveBeenCalledTimes(12);
  });
});

describe("home page: more than 500 team tasks", () => {
  // 520 recent done tasks fill a 500-row, newest-first page on their own; the
  // backlog, active, review, priority and mine tasks are all older than that
  // page reaches. A widget filled from one such page would be empty.
  function bigTeam(): Task[] {
    const old = (n: number) => new Date(Date.now() - (30 + n) * DAY).toISOString();
    return [
      ...many(520, () => ({ status: "done" as const })),
      ...many(15, (i) => ({ status: "backlog" as const, updatedAt: old(i) })),
      ...many(7, (i) => ({
        status: "open" as const,
        projectId: "p1",
        priority: "HIGH" as const,
        updatedAt: old(i),
      })),
      ...many(5, (i) => ({
        status: "in_progress" as const,
        projectId: "p2",
        claimedByUserId: i < 4 ? ME : null,
        updatedAt: old(i),
      })),
      ...many(3, (i) => ({ status: "review" as const, updatedAt: old(i) })),
    ];
  }

  it("still fills every widget with up to 10 rows of its own scope", async () => {
    serveDataset(bigTeam());
    await renderHome();

    expect(rowCount("Backlog")).toBe(10);
    expect(rowCount("Active Tasks")).toBe(10);
    expect(rowCount("In Review")).toBe(3);
    expect(rowCount("Priority (High / Critical)")).toBe(7);
    expect(rowCount("My Tasks")).toBe(4);
    expect(rowCount("Done · 14 days")).toBe(10);
  });

  it("shows the real total and counts the rows not shown", async () => {
    serveDataset(bigTeam());
    await renderHome();

    expect(headerTotal("Backlog")).toBe("15 total →");
    expect(footerLinks("Backlog")).toEqual(["+5 more →"]);
    expect(headerTotal("Active Tasks")).toBe("12 total →");
    expect(footerLinks("Active Tasks")).toEqual(["+2 more →"]);
    expect(headerTotal("Done · 14 days")).toBe("520 total →");
    expect(footerLinks("Done · 14 days")[0]).toBe("+510 more →");
    // 3 rows of 3: nothing more to show.
    expect(footerLinks("In Review")).toEqual([]);
  });

  it("keeps the per-project active counts of the strip complete", async () => {
    serveDataset(bigTeam());
    await renderHome();

    const counts = Array.from(document.querySelectorAll(".home-projects-item-count")).map(
      (el) => el.textContent,
    );
    // p1: 7 open; p2: 5 in progress. Review and backlog tasks do not count.
    expect(counts).toEqual(["7 active", "5 active"]);
  });
});

describe("home page: +N more is the total minus the rows shown", () => {
  it("total 15 with 3 rows loaded shows +12 more", async () => {
    // The backend reports 15 backlog tasks but this response carries 3 rows.
    mockGetTeamTasks.mockImplementation(async (_teamId, opts) => {
      const base = serve([], opts);
      return {
        ...base,
        tasks: opts?.status === "backlog" ? many(3, () => ({ status: "backlog" as const })) : [],
        counts: { ...base.counts!, backlog: 15, total: 15 },
      };
    });
    await renderHome();

    expect(rowCount("Backlog")).toBe(3);
    expect(headerTotal("Backlog")).toBe("15 total →");
    expect(footerLinks("Backlog")).toEqual(["+12 more →"]);
  });

  it("total 15 with 10 rows shows +5 more", async () => {
    serveDataset(many(15, () => ({ status: "backlog" as const })));
    await renderHome();

    expect(rowCount("Backlog")).toBe(10);
    expect(footerLinks("Backlog")).toEqual(["+5 more →"]);
  });

  it("shows no link when every row of the total is on screen", async () => {
    serveDataset(many(4, () => ({ status: "backlog" as const })));
    await renderHome();

    expect(rowCount("Backlog")).toBe(4);
    expect(footerLinks("Backlog")).toEqual([]);
  });
});

describe("home page: rows of a response that ignores a filter", () => {
  it("does not show a task outside the widget's scope", async () => {
    // Every request is answered with the same unfiltered page.
    const all = [
      makeTask({ status: "done", title: "Finished one" }),
      makeTask({ status: "backlog", title: "A draft" }),
      makeTask({ status: "review", title: "Under review" }),
    ];
    mockGetTeamTasks.mockResolvedValue({
      tasks: all,
      projects: PROJECTS,
      counts: serve(all).counts,
    });
    await renderHome();

    expect(within(widget("Backlog")).queryByText("A draft")).not.toBeNull();
    expect(within(widget("Backlog")).queryByText("Finished one")).toBeNull();
    expect(within(widget("Active Tasks")).queryByText("A draft")).toBeNull();
    expect(within(widget("In Review")).queryByText("Under review")).not.toBeNull();
    expect(within(widget("In Review")).queryByText("Finished one")).toBeNull();
    expect(within(widget("Done · 14 days")).queryByText("Finished one")).not.toBeNull();
  });
});

describe("home page: per-project active counts need a complete active scope", () => {
  it("shows them when the team is bigger but the active rows are complete", async () => {
    // total 500 would have hidden the counts before; only the active scope matters now.
    serveDataset([
      ...many(2, () => ({ status: "open" as const, projectId: "p1" })),
      ...many(3, () => ({ status: "review" as const, projectId: "p1" })),
      ...many(495, () => ({ status: "done" as const, projectId: "p2" })),
    ]);
    await renderHome();

    expect(
      Array.from(document.querySelectorAll(".home-projects-item-count")).map((el) => el.textContent),
    ).toEqual(["2 active", "0 active"]);
  });

  it("hides them when the active scope is cut short", async () => {
    // counts say 3 active tasks; the response carries only 2 rows of them.
    const rows = many(2, () => ({ status: "open" as const }));
    mockGetTeamTasks.mockResolvedValue({
      tasks: rows,
      projects: PROJECTS,
      counts: { ...serve(rows).counts!, open: 3, total: 3 },
    });
    await renderHome();

    expect(document.querySelector(".home-projects-item-count")).toBeNull();
  });
});

describe("home page: stale-data alert", () => {
  it("is not in the accessibility tree while the data is fresh", async () => {
    serveDataset([makeTask()]);
    await renderHome();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Last update failed/)).toBeNull();
  });

  it("appears after a failed poll, can be dismissed, and goes away on the next good poll", async () => {
    serveDataset([makeTask()]);
    const interval = vi.spyOn(globalThis, "setInterval");
    await renderHome();

    mockGetTeamTasks.mockRejectedValue(new Error("boom"));
    await pollNow(interval);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Last update failed");

    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();

    await pollNow(interval);
    expect(await screen.findByRole("alert")).toBeTruthy();
    serveDataset([makeTask()]);
    await pollNow(interval);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("home page: labels", () => {
  it("calls open + in_progress 'Active' on the tile and the widget", async () => {
    serveDataset([makeTask()]);
    await renderHome();

    const tileLabels = Array.from(document.querySelectorAll(".home-stat-tile-label")).map(
      (el) => el.textContent,
    );
    expect(tileLabels).toContain("Active");
    expect(tileLabels).not.toContain("Open");
    expect(screen.getByRole("heading", { level: 2, name: "Active Tasks" })).toBeTruthy();
    // The scope value in the URL stays `open`.
    const tile = Array.from(document.querySelectorAll(".home-stat-tile")).find(
      (el) => el.textContent?.includes("Active"),
    ) as HTMLAnchorElement;
    expect(tile.getAttribute("href")).toContain("scope=open");
  });

  it("labels the done tile and widget with the 14-day window", async () => {
    serveDataset([makeTask({ status: "done" })]);
    await renderHome();

    const tileLabels = Array.from(document.querySelectorAll(".home-stat-tile-label")).map(
      (el) => el.textContent,
    );
    expect(tileLabels).toContain("Done · 14 days");
    expect(screen.getByRole("heading", { level: 2, name: "Done · 14 days" })).toBeTruthy();
    expect(screen.queryByText("Recently Done")).toBeNull();
  });

  it("keeps the stat tiles the only link to a scope: widget titles are plain text", async () => {
    serveDataset([makeTask()]);
    await renderHome();

    for (const h of Array.from(document.querySelectorAll(".home-widget-title"))) {
      expect(h.closest("a")).toBeNull();
    }
  });
});

describe("home page: reference chip", () => {
  it("keeps the full reference in the title and in reading order in the text", async () => {
    const ref = "fu-2026-10-26/very-long-reference-suffix";
    serveDataset([makeTask({ externalRef: ref })]);
    await renderHome();

    const chip = document.querySelector(".home-task-row-ref") as HTMLElement;
    expect(chip.getAttribute("title")).toBe(ref);
    // <bdi> isolates the text so the right-to-left box that truncates from
    // the start does not reorder the characters.
    expect(chip.querySelector("bdi")?.textContent).toBe(ref);
  });
});
