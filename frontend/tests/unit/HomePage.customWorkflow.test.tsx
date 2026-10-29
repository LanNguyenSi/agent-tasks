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

// ── Mine, In Review and Done widgets ──────────────────────────────────────────
//
// p1 follows a seven-stage pipeline (spec, plan, implement, test, review, done),
// p2 a QA flow (work, qa, then shipped or wontfix). Each widget asks for the
// names its scope means in those workflows and keeps the rows that are of that
// scope in the task's OWN workflow: `review` is not review-like in p2, `done`
// is not finished in p2, `shipped` is.

function flow(id: string, projectId: string, states: [string, boolean][], edges: [string, string][]): Workflow {
  return {
    id,
    projectId,
    name: id,
    isDefault: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    definition: {
      states: states.map(([name, terminal]) => ({ name, label: name, terminal })),
      transitions: edges.map(([from, to]) => ({ from, to })),
      initialState: "open",
    },
  } as Workflow;
}

const PIPELINE = flow(
  "wf-pipeline",
  "p1",
  [["open", false], ["spec", false], ["plan", false], ["implement", false], ["test", false], ["review", false], ["done", true]],
  [["open", "spec"], ["spec", "plan"], ["plan", "implement"], ["implement", "test"], ["test", "review"], ["review", "done"], ["review", "implement"]],
);
const QA_FLOW = flow(
  "wf-qa",
  "p2",
  [["open", false], ["work", false], ["qa", false], ["shipped", true], ["wontfix", true]],
  [["open", "work"], ["work", "qa"], ["qa", "shipped"], ["qa", "work"], ["work", "wontfix"]],
);

type Key = "mine" | "priority" | "review" | "done";

/** The calls of one widget's request (the widgets differ in their filters). */
function callsOf(key: Key) {
  return mockGetTeamTasks.mock.calls
    .map((c) => c[1] ?? {})
    .filter((o) => {
      if (key === "mine") return o.mine === true;
      if (key === "priority") return o.priority === "CRITICAL,HIGH";
      if (key === "done") return o.recency === "recent";
      return !o.mine && !o.priority && !o.recency && o.status?.startsWith("review");
    })
    .map((o) => o.status);
}

function widgetTitles(heading: string | RegExp): string[] {
  const h = screen.getByRole("heading", { level: 2, name: heading });
  const card = h.closest(".home-widget-card") as HTMLElement;
  return Array.from(card.querySelectorAll(".home-task-row")).map((r) => r.getAttribute("aria-label") ?? "");
}

function has(titles: string[], title: string): boolean {
  return titles.some((t) => t.startsWith(title));
}

/** A fake of GET /teams/:teamId/tasks: status, mine and recency filters, newest first. */
function serveScoped(dataset: Task[], opts: { status?: string; mine?: boolean }): TeamTasksResponse {
  const statuses = opts.status?.split(",");
  const rows = dataset.filter(
    (t) => (!statuses || statuses.includes(t.status)) && (!opts.mine || t.claimedByUserId === ME),
  );
  return {
    tasks: rows,
    projects: PROJECTS,
    counts: { open: 9, review: 9, done: 9, doneRecent: 9, doneOlder: 0, priority: 9, mine: 9, backlog: 9, total: dataset.length },
    filteredTotal: rows.length,
  };
}

const SCOPED_DATASET = () => [
  makeTask({ title: "my spec", status: "spec", claimedByUserId: ME, projectId: "p1" }),
  makeTask({ title: "my qa", status: "qa", claimedByUserId: ME, projectId: "p2" }),
  makeTask({ title: "my shipped", status: "shipped", claimedByUserId: ME, projectId: "p2" }),
  makeTask({ title: "my open", status: "open", claimedByUserId: ME, projectId: "p1" }),
  makeTask({ title: "someone else's test", status: "test", claimedByUserId: "u-2", projectId: "p1" }),
  makeTask({ title: "pipeline review", status: "review", projectId: "p1" }),
  makeTask({ title: "qa gate", status: "qa", projectId: "p2" }),
  makeTask({ title: "p2 review name", status: "review", projectId: "p2" }),
  makeTask({ title: "pipeline spec", status: "spec", projectId: "p1" }),
  makeTask({ title: "pipeline done", status: "done", projectId: "p1" }),
  makeTask({ title: "qa shipped", status: "shipped", projectId: "p2" }),
  makeTask({ title: "qa wontfix", status: "wontfix", projectId: "p2" }),
  makeTask({ title: "p2 done name", status: "done", projectId: "p2" }),
  makeTask({ title: "old shipped", status: "shipped", projectId: "p2", updatedAt: new Date(Date.now() - 40 * DAY).toISOString() }),
];

const FLOWS_BY_PROJECT = (projectId: string) => (projectId === "p1" ? [PIPELINE] : [QA_FLOW]);

describe("home page: Mine, In Review and Done widgets follow the project workflows", () => {
  const ACTIONABLE = "open,in_progress,review,spec,plan,implement,test,work,qa";

  it("asks each widget for its own names once the workflows are known, and no widget twice more", async () => {
    const dataset = SCOPED_DATASET();
    mockGetTeamTasks.mockImplementation(async (_t, opts) => serveScoped(dataset, opts ?? {}));
    mockGetWorkflows.mockImplementation(async (projectId) => FLOWS_BY_PROJECT(projectId));
    await renderHome();
    await vi.waitFor(() => {
      expect(widgetTitles("My Tasks").some((t) => t.startsWith("my spec"))).toBe(true);
    });

    expect(callsOf("mine")).toEqual(["open,in_progress,review", ACTIONABLE]);
    expect(callsOf("priority")).toEqual(["open,in_progress,review", ACTIONABLE]);
    expect(callsOf("review")).toEqual(["review", "review,qa"]);
    expect(callsOf("done")).toEqual(["done", "done,shipped,wontfix"]);
    // Six first requests, then one more for each of the four widgets whose names grew.
    expect(mockGetTeamTasks).toHaveBeenCalledTimes(10);
  });

  it("My Tasks lists my rows in custom open states and drops custom terminal ones", async () => {
    const dataset = SCOPED_DATASET();
    mockGetTeamTasks.mockImplementation(async (_t, opts) => serveScoped(dataset, opts ?? {}));
    mockGetWorkflows.mockImplementation(async (projectId) => FLOWS_BY_PROJECT(projectId));
    await renderHome();
    await vi.waitFor(() => {
      expect(widgetTitles("My Tasks").some((t) => t.startsWith("my spec"))).toBe(true);
    });
    const titles = widgetTitles("My Tasks");
    expect(has(titles, "my qa")).toBe(true);
    expect(has(titles, "my open")).toBe(true);
    expect(has(titles, "my shipped")).toBe(false);
    expect(has(titles, "someone else's test")).toBe(false);
  });

  it("My Tasks drops a custom terminal row a response returns anyway", async () => {
    // A response that ignores the status filter must not put a finished task in the widget.
    const dataset = SCOPED_DATASET();
    mockGetTeamTasks.mockImplementation(async (_t, opts) => serveScoped(dataset, { mine: opts?.mine }));
    mockGetWorkflows.mockImplementation(async (projectId) => FLOWS_BY_PROJECT(projectId));
    await renderHome();
    await vi.waitFor(() => {
      expect(widgetTitles("My Tasks").some((t) => t.startsWith("my spec"))).toBe(true);
    });
    const titles = widgetTitles("My Tasks");
    expect(has(titles, "my shipped")).toBe(false);
    expect(has(titles, "my qa")).toBe(true);
  });

  it("In Review lists the review-like state of each workflow, not a same-named state elsewhere", async () => {
    const dataset = SCOPED_DATASET();
    mockGetTeamTasks.mockImplementation(async (_t, opts) => serveScoped(dataset, opts ?? {}));
    mockGetWorkflows.mockImplementation(async (projectId) => FLOWS_BY_PROJECT(projectId));
    await renderHome();
    await vi.waitFor(() => {
      expect(widgetTitles("In Review").some((t) => t.startsWith("qa gate"))).toBe(true);
    });
    const titles = widgetTitles("In Review");
    expect(has(titles, "pipeline review")).toBe(true);
    expect(has(titles, "p2 review name")).toBe(false);
    expect(has(titles, "pipeline spec")).toBe(false);
  });

  it("Done lists the recent terminal rows of each workflow, not a same-named open state elsewhere", async () => {
    const dataset = SCOPED_DATASET();
    mockGetTeamTasks.mockImplementation(async (_t, opts) => serveScoped(dataset, opts ?? {}));
    mockGetWorkflows.mockImplementation(async (projectId) => FLOWS_BY_PROJECT(projectId));
    await renderHome();
    await vi.waitFor(() => {
      expect(widgetTitles(/^Done/).some((t) => t.startsWith("qa shipped"))).toBe(true);
    });
    const titles = widgetTitles(/^Done/);
    expect(has(titles, "pipeline done")).toBe(true);
    expect(has(titles, "qa wontfix")).toBe(true);
    expect(has(titles, "p2 done name")).toBe(false);
    expect(has(titles, "old shipped")).toBe(false);
  });

  it("keeps the fixed lists and the built-in rules when the workflows cannot be read", async () => {
    const dataset = SCOPED_DATASET();
    mockGetTeamTasks.mockImplementation(async (_t, opts) => serveScoped(dataset, opts ?? {}));
    mockGetWorkflows.mockRejectedValue(new Error("boom"));
    await renderHome();
    await vi.waitFor(() => {
      expect(mockGetWorkflows).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(widgetTitles("My Tasks").some((t) => t.startsWith("my open"))).toBe(true);
    });
    expect(callsOf("mine")).toEqual(["open,in_progress,review"]);
    expect(callsOf("review")).toEqual(["review"]);
    expect(callsOf("done")).toEqual(["done"]);
    expect(mockGetTeamTasks).toHaveBeenCalledTimes(6);
    expect(has(widgetTitles("My Tasks"), "my spec")).toBe(false);
    expect(has(widgetTitles("In Review"), "p2 review name")).toBe(true);
    expect(has(widgetTitles(/^Done/), "p2 done name")).toBe(true);
  });
});

// A project whose stored workflow is the legacy copy of the built-in default
// (initial state backlog, backlog -> open): the backend reads it after
// sanitizing, where in_progress is the entry's target and not review-like, so
// neither In Review nor the review request may include in_progress.
describe("home page: a legacy stored copy of the default workflow is read like the backend reads it", () => {
  const LEGACY = {
    ...flow(
      "wf-legacy",
      "p1",
      [["backlog", false], ["open", false], ["in_progress", false], ["review", false], ["done", true]],
      [["backlog", "open"], ["open", "in_progress"], ["in_progress", "review"], ["in_progress", "done"], ["review", "done"]],
    ),
  } as Workflow;
  (LEGACY.definition as { initialState: string }).initialState = "backlog";

  const dataset = () => [
    makeTask({ title: "legacy progress", status: "in_progress", claimedByUserId: ME, projectId: "p1" }),
    makeTask({ title: "legacy review", status: "review", projectId: "p1" }),
    makeTask({ title: "legacy open", status: "open", claimedByUserId: ME, projectId: "p1" }),
  ];

  it("asks In Review for review only and lists no in_progress row, even when a response returns one", async () => {
    const rows = dataset();
    // The fake ignores the status filter: only the per-task rule can keep in_progress out.
    mockGetTeamTasks.mockImplementation(async (_t, opts) => serveScoped(rows, { mine: opts?.mine }));
    mockGetWorkflows.mockResolvedValue([LEGACY]);
    await renderHome();
    await vi.waitFor(() => {
      expect(mockGetWorkflows).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(widgetTitles("In Review").some((t) => t.startsWith("legacy review"))).toBe(true);
    });
    expect(callsOf("review").every((status) => status === "review")).toBe(true);
    const titles = widgetTitles("In Review");
    expect(has(titles, "legacy progress")).toBe(false);
    expect(has(titles, "legacy open")).toBe(false);
    // My Tasks still lists the in_progress row: it is actionable.
    expect(has(widgetTitles("My Tasks"), "legacy progress")).toBe(true);
  });
});

// ── 403 on the workflow list is remembered across polls ───────────────────────

describe("home page: a project whose workflows answer 403 is asked once", () => {
  let tick: (() => void) | null = null;

  beforeEach(() => {
    tick = null;
    const realSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === 15_000) {
        tick = fn;
        return 0 as unknown as ReturnType<typeof setInterval>;
      }
      return realSetInterval(fn, ms);
    }) as typeof setInterval);
  });

  async function pollOnce() {
    const before = mockGetTeamTasks.mock.calls.length;
    tick!();
    await vi.waitFor(() => {
      expect(mockGetTeamTasks.mock.calls.length).toBeGreaterThan(before);
    });
    // Let the poll's workflow step settle.
    await new Promise((r) => setTimeout(r, 20));
  }

  const callsFor = (id: string) => mockGetWorkflows.mock.calls.filter((c) => c[0] === id).length;

  it("requests a 403 project once across two polls and still reads the other project's workflows", async () => {
    mockGetTeamTasks.mockImplementation(async (_t, opts) => serveScoped(SCOPED_DATASET(), opts ?? {}));
    mockGetWorkflows.mockImplementation(async (projectId) => {
      if (projectId === "p2") throw Object.assign(new Error("Forbidden"), { status: 403 });
      return [PIPELINE];
    });
    await renderHome();
    await vi.waitFor(() => {
      expect(callsFor("p2")).toBe(1);
    });
    await pollOnce();
    await pollOnce();
    expect(callsFor("p2")).toBe(1);
    expect(callsFor("p1")).toBe(1);
    // p1's workflow still applies: its custom open state is in the mine request.
    expect(callsOf("mine").at(-1)).toBe("open,in_progress,review,spec,plan,implement,test");
  });

  it("asks again after a failure that is not a 403", async () => {
    mockGetTeamTasks.mockImplementation(async (_t, opts) => serveScoped(SCOPED_DATASET(), opts ?? {}));
    mockGetWorkflows.mockImplementation(async (projectId) => {
      if (projectId === "p2") throw Object.assign(new Error("Bad gateway"), { status: 502 });
      return [PIPELINE];
    });
    await renderHome();
    await vi.waitFor(() => {
      expect(callsFor("p2")).toBe(1);
    });
    await pollOnce();
    expect(callsFor("p2")).toBe(2);
    expect(callsFor("p1")).toBe(1);
  });

  it("asks again after a plain network error without a status", async () => {
    mockGetTeamTasks.mockImplementation(async (_t, opts) => serveScoped(SCOPED_DATASET(), opts ?? {}));
    mockGetWorkflows.mockImplementation(async (projectId) => {
      if (projectId === "p2") throw new Error("network down");
      return [PIPELINE];
    });
    await renderHome();
    await vi.waitFor(() => {
      expect(callsFor("p2")).toBe(1);
    });
    await pollOnce();
    expect(callsFor("p2")).toBe(2);
  });
});
