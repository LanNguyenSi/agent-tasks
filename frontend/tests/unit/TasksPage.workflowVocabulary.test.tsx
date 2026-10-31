/** @vitest-environment jsdom */
/**
 * /tasks page with stored custom workflows (src/app/tasks/page.tsx): the
 * Priority, My Tasks, In Review and Recently Done presets resolve their status
 * lists from the team's project workflows, the status filter keeps any state
 * name of the URL (unknown names reach the server unchecked and match no task), and a chip appears for
 * each custom state the loaded workflows define.
 * Active stays the fixed open + in progress. With no workflow readable the
 * presets are the built-in lists. Mock/render pattern mirrors
 * TasksPageCustomFilter.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Task, User, Team, TeamTasksProject, Workflow } from "../../src/lib/api";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/tasks",
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  getTeamTasks: vi.fn(),
  getWorkflows: vi.fn(),
  updateTask: vi.fn(),
}));

vi.mock("../../src/components/tasks/NewTaskFlow", () => ({ default: () => null }));

import TasksPageRaw from "../../src/app/tasks/page";
import { withTeamList } from "./helpers/withTeamList";
const TasksPage = withTeamList(TasksPageRaw);
import { getCurrentUser, getTeams, getTeamTasks, getWorkflows } from "../../src/lib/api";

const USER: User = { id: "u-1", login: "lan" } as User;
const TEAM: Team = { id: "team-1", name: "Pandora", slug: "pandora", role: "ADMIN", createdAt: "2026-01-01T00:00:00Z" };
const PROJECTS: TeamTasksProject[] = [
  { id: "p1", name: "Pipeline", slug: "pipeline", accessSource: "team" },
  { id: "p2", name: "QA", slug: "qa", accessSource: "team" },
];

const TASK = {
  id: "task-1",
  projectId: "p1",
  title: "A task",
  description: null,
  status: "spec",
  priority: "HIGH",
  templateData: null,
  claimedByUserId: null,
  claimedByAgentId: null,
  labels: [],
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
  attachments: [],
} as unknown as Task;

function flow(id: string, projectId: string, states: [string, string, boolean][], edges: [string, string][]): Workflow {
  return {
    id,
    projectId,
    name: id,
    isDefault: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    definition: {
      states: states.map(([name, label, terminal]) => ({ name, label, terminal })),
      transitions: edges.map(([from, to]) => ({ from, to })),
      initialState: "open",
    },
  } as Workflow;
}

const PIPELINE = flow(
  "wf-pipeline",
  "p1",
  [["open", "Open", false], ["spec", "Spec", false], ["plan", "Plan", false], ["implement", "Implement", false], ["test", "Test", false], ["review", "Review", false], ["done", "Done", true]],
  [["open", "spec"], ["spec", "plan"], ["plan", "implement"], ["implement", "test"], ["test", "review"], ["review", "done"], ["review", "implement"]],
);
const QA_FLOW = flow(
  "wf-qa",
  "p2",
  [["open", "Open", false], ["work", "Work", false], ["qa", "Quality gate", false], ["shipped", "Shipped", true], ["wontfix", "Won't fix", true]],
  [["open", "work"], ["work", "qa"], ["qa", "shipped"], ["qa", "work"], ["work", "wontfix"]],
);

const ACTIONABLE = "open,in_progress,review,spec,plan,implement,test,work,qa";

function listResponse() {
  return {
    tasks: [TASK],
    projects: PROJECTS,
    counts: { open: 1, review: 0, done: 0, priority: 1, mine: 0, total: 1 },
    filteredTotal: 1,
  };
}

async function renderAt(search: string) {
  nav.search = search;
  render(<TasksPage />);
  await screen.findByRole("heading", { level: 1 });
}

function statusRequests(): (string | undefined)[] {
  return vi.mocked(getTeamTasks).mock.calls.map((c) => c[1]?.status);
}

async function lastStatusIs(expected: string | undefined) {
  await waitFor(() => expect(statusRequests().at(-1)).toBe(expected));
}

/** The status chips only: the buttons between the Status and the Priority label. */
function statusChips(): HTMLButtonElement[] {
  const label = screen.getByText("Status", { selector: ".tasks-filter-label" });
  const chips: HTMLButtonElement[] = [];
  for (let el = label.nextElementSibling; el && !el.classList.contains("tasks-filter-label"); el = el.nextElementSibling) {
    if (el instanceof HTMLButtonElement) chips.push(el);
  }
  return chips;
}

function chipNames(): string[] {
  return statusChips().map((b) => b.textContent ?? "");
}

function pressedStatusChips(): string[] {
  return statusChips().filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent ?? "");
}

function lastReplace(): URLSearchParams {
  const calls = routerMocks.replace.mock.calls;
  const href = String(calls[calls.length - 1]![0]);
  return new URLSearchParams(href.split("?")[1] ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  nav.search = "";
  vi.mocked(getCurrentUser).mockResolvedValue(USER);
  vi.mocked(getTeams).mockResolvedValue([TEAM]);
  vi.mocked(getTeamTasks).mockResolvedValue(listResponse() as never);
  vi.mocked(getWorkflows).mockImplementation(async (projectId) => (projectId === "p1" ? [PIPELINE] : [QA_FLOW]));
});
afterEach(cleanup);

describe("/tasks presets follow the workflow vocabulary", () => {
  it("Priority asks for every actionable name of the projects' workflows", async () => {
    await renderAt("scope=priority");
    await lastStatusIs(ACTIONABLE);
    expect(vi.mocked(getTeamTasks).mock.calls.at(-1)![1]!.priority).toBe("CRITICAL,HIGH");
    // The first request ran before the workflows were known: the built-in list.
    expect(statusRequests()[0]).toBe("open,in_progress,review");
  });

  it("My Tasks asks for the actionable names and keeps mine", async () => {
    await renderAt("scope=mine");
    await lastStatusIs(ACTIONABLE);
    expect(vi.mocked(getTeamTasks).mock.calls.at(-1)![1]!.mine).toBe(true);
  });

  it("In Review asks for the review-like names", async () => {
    await renderAt("scope=review");
    await lastStatusIs("review,qa");
  });

  it("Recently Done asks for the terminal names and keeps the recency window", async () => {
    await renderAt("scope=done");
    await lastStatusIs("done,shipped,wontfix");
    expect(vi.mocked(getTeamTasks).mock.calls.at(-1)![1]!.recency).toBe("recent");
  });

  it("In Review reads a legacy stored copy of the default workflow like the backend: review, not in_progress", async () => {
    const legacy = flow(
      "wf-legacy",
      "p1",
      [["backlog", "Backlog", false], ["open", "Open", false], ["in_progress", "In Progress", false], ["review", "Review", false], ["done", "Done", true]],
      [["backlog", "open"], ["open", "in_progress"], ["in_progress", "review"], ["in_progress", "done"], ["review", "done"]],
    );
    (legacy.definition as { initialState: string }).initialState = "backlog";
    vi.mocked(getWorkflows).mockImplementation(async (projectId) => (projectId === "p1" ? [legacy] : []));
    await renderAt("scope=review");
    await waitFor(() => expect(getWorkflows).toHaveBeenCalledTimes(2));
    await lastStatusIs("review");
    expect(new Set(statusRequests())).toEqual(new Set(["review"]));
  });

  it("Active stays open and in progress", async () => {
    await renderAt("scope=open");
    await waitFor(() => expect(getWorkflows).toHaveBeenCalledTimes(2));
    await lastStatusIs("open,in_progress");
    expect(new Set(statusRequests())).toEqual(new Set(["open,in_progress"]));
  });

  it("All sends no status filter", async () => {
    await renderAt("");
    await waitFor(() => expect(getWorkflows).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(new Set(statusRequests())).toEqual(new Set([undefined])));
  });

  it("uses the built-in lists when the workflows cannot be read", async () => {
    vi.mocked(getWorkflows).mockRejectedValue(new Error("boom"));
    await renderAt("scope=review");
    await waitFor(() => expect(getWorkflows).toHaveBeenCalled());
    await lastStatusIs("review");
    expect(new Set(statusRequests())).toEqual(new Set(["review"]));
    expect(chipNames()).toEqual(["Backlog", "Open", "In Progress", "In Review", "Done"]);
  });

  it("uses the built-in lists when a project's workflows answer 403 (and reads the others)", async () => {
    vi.mocked(getWorkflows).mockImplementation(async (projectId) => {
      if (projectId === "p2") throw Object.assign(new Error("Forbidden"), { status: 403 });
      return [PIPELINE];
    });
    await renderAt("scope=priority");
    await lastStatusIs("open,in_progress,review,spec,plan,implement,test");
  });
});

describe("/tasks status chips", () => {
  it("adds a chip for each custom state of the loaded workflows, labelled as the workflow does", async () => {
    await renderAt("scope=priority");
    await lastStatusIs(ACTIONABLE);
    await waitFor(() => expect(chipNames()).toContain("Quality gate"));
    expect(chipNames()).toEqual([
      "Backlog", "Open", "In Progress", "In Review", "Done",
      "Spec", "Plan", "Implement", "Test", "Work", "Quality gate", "Shipped", "Won't fix",
    ]);
  });

  it("shows only the five built-in chips when no workflow defines another state", async () => {
    vi.mocked(getWorkflows).mockResolvedValue([]);
    await renderAt("scope=priority");
    await waitFor(() => expect(getWorkflows).toHaveBeenCalledTimes(2));
    expect(chipNames()).toEqual(["Backlog", "Open", "In Progress", "In Review", "Done"]);
  });

  it("presses the preset's chips, custom ones included", async () => {
    await renderAt("scope=review");
    await lastStatusIs("review,qa");
    await waitFor(() => expect(pressedStatusChips()).toEqual(["In Review", "Quality gate"]));
  });

  it("toggling a custom chip off the preset writes the remaining names to the URL", async () => {
    await renderAt("scope=review");
    await waitFor(() => expect(pressedStatusChips()).toContain("Quality gate"));
    await userEvent.click(screen.getByRole("button", { name: "Quality gate" }));
    expect(lastReplace().get("status")).toBe("review");
  });

  it("toggling a custom chip on writes it with the preset's names", async () => {
    await renderAt("scope=review");
    await waitFor(() => expect(chipNames()).toContain("Plan"));
    await userEvent.click(screen.getByRole("button", { name: "Plan" }));
    expect(lastReplace().get("status")).toBe("review,qa,plan");
  });
});

describe("/tasks status parameter", () => {
  it("renders its chips when a stored workflow holds a state entry that is not an object", async () => {
    const broken = {
      ...QA_FLOW,
      definition: { ...QA_FLOW.definition, states: [null, 7, { label: "No name" }, ...QA_FLOW.definition.states] },
    } as unknown as Workflow;
    vi.mocked(getWorkflows).mockImplementation(async (projectId) => (projectId === "p1" ? [PIPELINE] : [broken]));
    await renderAt("scope=all");
    await waitFor(() => expect(chipNames()).toContain("Quality gate"));
    expect(chipNames()).toContain("Spec");
  });

  it("accepts a custom state name from the workflows", async () => {
    await renderAt("status=qa,spec");
    await waitFor(() => expect(statusRequests().at(-1)).toBe("qa,spec"));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Tasks · custom filter");
  });

  it("keeps a name no workflow defines and sends it to the server", async () => {
    await renderAt("scope=review&status=nonsense");
    await waitFor(() => expect(getWorkflows).toHaveBeenCalledTimes(2));
    await lastStatusIs("nonsense");
    expect(new Set(statusRequests())).toEqual(new Set(["nonsense"]));
  });

  it("keeps a custom name in the very first request, before the workflows are read", async () => {
    await renderAt("status=qa,spec");
    await waitFor(() => expect(statusRequests()[0]).toBe("qa,spec"));
    await waitFor(() => expect(getWorkflows).toHaveBeenCalledTimes(2));
    expect(new Set(statusRequests())).toEqual(new Set(["qa,spec"]));
  });

  it("a chip clicked while the workflows are still loading keeps the custom name from the URL", async () => {
    vi.mocked(getWorkflows).mockReturnValue(new Promise(() => {}));
    await renderAt("status=qa");
    await waitFor(() => expect(getWorkflows).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(lastReplace().get("status")).toBe("qa,open");
  });

  it("drops an empty entry and a repeated name, and ignores the clear-all sentinel inside a list", async () => {
    await renderAt("status=qa,,qa,__any__, spec ");
    await lastStatusIs("qa,spec");
  });

  it("keeps the built-in names working when the workflows cannot be read", async () => {
    vi.mocked(getWorkflows).mockRejectedValue(new Error("boom"));
    await renderAt("status=review,done");
    await waitFor(() => expect(getWorkflows).toHaveBeenCalled());
    await lastStatusIs("review,done");
  });

  it("a custom state name stays in the request while the workflows cannot be read", async () => {
    vi.mocked(getWorkflows).mockRejectedValue(new Error("boom"));
    await renderAt("status=qa");
    await waitFor(() => expect(getWorkflows).toHaveBeenCalled());
    await lastStatusIs("qa");
    expect(new Set(statusRequests())).toEqual(new Set(["qa"]));
  });

  it("a custom state name stays in the request when the project's workflows answer 403", async () => {
    vi.mocked(getWorkflows).mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));
    await renderAt("status=qa,review");
    await waitFor(() => expect(getWorkflows).toHaveBeenCalledTimes(2));
    await lastStatusIs("qa,review");
    expect(new Set(statusRequests())).toEqual(new Set(["qa,review"]));
    // The chip for the name does not exist (nothing was read), the filter still carries it.
    expect(chipNames()).toEqual(["Backlog", "Open", "In Progress", "In Review", "Done"]);
    expect(pressedStatusChips()).toEqual(["In Review"]);
  });

  it("the clear-all sentinel still clears the status filter", async () => {
    await renderAt("scope=review&status=__any__");
    await lastStatusIs(undefined);
  });
});

describe("/tasks custom-filter detection against the resolved presets", () => {
  it.each([
    ["Priority with no overrides", "scope=priority", "Priority (High / Critical)"],
    ["Review with no overrides", "scope=review", "In Review"],
    ["Done with no overrides", "scope=done", "Recently Done"],
    ["My Tasks with no overrides", "scope=mine", "My Tasks"],
    ["Review with its resolved names written out, in another order", "scope=review&status=qa,review", "In Review"],
  ])("%s is the tab itself", async (_label, search, heading) => {
    await renderAt(search);
    if (search.includes("status=")) {
      await lastStatusIs("qa,review");
    } else {
      // No status param: just wait for the first request to have been made,
      // the expected status is whatever the preset resolved to.
      await waitFor(() => expect(statusRequests().length).toBeGreaterThan(0));
    }
    await waitFor(() => expect(getWorkflows).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(chipNames()).toContain("Quality gate"));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(heading);
    expect(screen.queryByRole("button", { name: /^Reset to / })).not.toBeInTheDocument();
  });

  it("one custom name off the resolved Review preset is a custom filter", async () => {
    await renderAt("scope=review&status=review");
    await waitFor(() => expect(chipNames()).toContain("Quality gate"));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Tasks · custom filter");
    expect(screen.getByRole("button", { name: "Reset to In Review" })).toBeInTheDocument();
  });
});
