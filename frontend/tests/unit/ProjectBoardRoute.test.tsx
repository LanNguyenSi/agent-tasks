/** @vitest-environment jsdom */
/**
 * The real /projects/[id]/board route is the hub layout wrapping the board
 * page, and both load the project. A project that answers 404/403 lands on
 * the Projects page, a 401 lands on sign-in with the board's path and query
 * as the way back; any other failure (500, network) must keep the user on
 * the board's own "Could not load tasks" banner with Retry, with no
 * navigation from either component.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { expectDocumentTitle } from "./helpers/documentTitle";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiRequestError, type User, type Project, type Task } from "../../src/lib/api";

const nav = vi.hoisted(() => ({ router: { replace: vi.fn(), push: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => nav.router,
  useParams: () => ({ id: "p-1" }),
  usePathname: () => "/projects/p-1/board",
  useSearchParams: () => new URLSearchParams(""),
  useSelectedLayoutSegment: () => "board",
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    getCurrentUser: vi.fn(),
    getTeams: vi.fn(),
    getProject: vi.fn(),
    getTasks: vi.fn(),
    getTask: vi.fn(),
    getEffectiveWorkflow: vi.fn(),
    getWorkflows: vi.fn(),
  };
});

import ProjectLayout from "../../src/app/projects/[id]/layout";
import ProjectBoardPage from "../../src/app/projects/[id]/board/page";
import { ToastProvider } from "../../src/components/ui/Toast";
import { getCurrentUser, getTeams, getProject, getTasks, getTask, getWorkflows } from "../../src/lib/api";

const mockGetProject = vi.mocked(getProject);

const USER = {
  id: "u-1",
  login: "lan",
  name: "Lan",
  avatarUrl: null,
  email: null,
  githubConnected: false,
  allowAgentPrCreate: false,
  allowAgentPrMerge: false,
  allowAgentPrComment: false,
} as User;

const PROJECT = {
  id: "p-1",
  teamId: "t-1",
  name: "Project One",
  slug: "project-one",
  githubRepo: null,
  governanceMode: "AUTONOMOUS",
  accessRole: "ADMIN",
} as unknown as Project;

function renderRoute() {
  return render(
    <ToastProvider>
      <ProjectLayout>
        <ProjectBoardPage />
      </ProjectLayout>
    </ToastProvider>,
  );
}

function redirectTargets(): string[] {
  return [...new Set(nav.router.replace.mock.calls.map((c) => String(c[0])))];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue(USER);
  vi.mocked(getTeams).mockResolvedValue([]);
  vi.mocked(getTasks).mockResolvedValue([]);
  window.localStorage.clear();
  window.history.replaceState({}, "", "/projects/p-1/board");
  Element.prototype.scrollIntoView = vi.fn();
});

describe("board route (hub layout + board page)", () => {
  it("loads the board for an accessible project without navigating", async () => {
    mockGetProject.mockResolvedValue(PROJECT);
    renderRoute();
    // The toolbar's button comes first; the empty board repeats it in its first-run state.
    await waitFor(() => expect(screen.getAllByRole("button", { name: /new task/i })[0]).toBeEnabled());
    expect(nav.router.replace).not.toHaveBeenCalled();
  });

  it("titles the tab '<Project> · Board - agent-tasks'", async () => {
    mockGetProject.mockResolvedValue(PROJECT);
    document.title = "stale";
    renderRoute();
    await waitFor(() => expect(document.title).toBe("Project One · Board - agent-tasks"));
  });

  it("keeps the tab title and adds no history entry while the task modal opens and closes", async () => {
    // The board's ?taskId= sync uses history.replaceState: no router call,
    // which in Next re-renders the document head with the segment title.
    const task = {
      id: "k-1",
      projectId: "p-1",
      title: "Deep-linked task",
      status: "open",
      priority: "MEDIUM",
      labels: [],
      attachments: [],
      artifacts: [],
      comments: [],
      blockedBy: [],
      blocks: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    } as unknown as Task;
    mockGetProject.mockResolvedValue(PROJECT);
    vi.mocked(getTasks).mockResolvedValue([task]);
    vi.mocked(getTask).mockResolvedValue(task);
    const replaceState = vi.spyOn(window.history, "replaceState");
    try {
      renderRoute();
      await waitFor(() => expect(document.title).toBe("Project One · Board - agent-tasks"));
      const entries = window.history.length;

      await userEvent.click(await screen.findByRole("button", { name: /Deep-linked task/ }));
      await screen.findByRole("dialog");
      await waitFor(() => expect(window.location.search).toBe("?taskId=k-1"));
      await expectDocumentTitle("Project One · Board - agent-tasks");

      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(window.location.search).toBe(""));
      await expectDocumentTitle("Project One · Board - agent-tasks");

      expect(replaceState).toHaveBeenCalledTimes(2);
      expect(window.history.length).toBe(entries);
      expect(nav.router.replace).not.toHaveBeenCalled();
      expect(nav.router.push).not.toHaveBeenCalled();
    } finally {
      replaceState.mockRestore();
    }
  });

  it("sends a 401 from the project load to sign-in with the board path and query as the way back", async () => {
    window.history.replaceState({}, "", "/projects/p-1/board?taskId=k-1");
    mockGetProject.mockRejectedValue(
      new ApiRequestError("unauthorized", "Invalid or expired token", 401),
    );
    renderRoute();

    await waitFor(() => expect(nav.router.replace).toHaveBeenCalled());
    // The layout and the board both react; both go to the same sign-in URL.
    expect(redirectTargets()).toEqual([
      "/auth?redirect=%2Fprojects%2Fp-1%2Fboard%3FtaskId%3Dk-1",
    ]);
    expect(nav.router.push).not.toHaveBeenCalled();
    expect(screen.queryByText("Could not load tasks")).not.toBeInTheDocument();
  });

  it.each([
    ["a 500", new ApiRequestError("internal", "Server exploded", 500)],
    ["a network failure", new TypeError("Failed to fetch")],
  ])("keeps the board's error banner with Retry and does not navigate on %s", async (_label, err) => {
    mockGetProject.mockRejectedValue(err);
    renderRoute();

    expect(await screen.findByText("Could not load tasks")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    // Let the layout's own load settle too before asserting the absence.
    await waitFor(() => expect(mockGetProject.mock.calls.length).toBeGreaterThanOrEqual(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("Could not load project")).not.toBeInTheDocument();
    expect(nav.router.replace).not.toHaveBeenCalled();
  });

  it.each([
    [404, "not_found"],
    [403, "forbidden"],
  ])("sends a project that answers %i to the Projects page and nowhere else", async (status, code) => {
    mockGetProject.mockRejectedValue(new ApiRequestError(code, "nope", status));
    renderRoute();

    await waitFor(() => expect(nav.router.replace).toHaveBeenCalledWith("/projects"));
    // The layout and the board both react; both go to the same place.
    expect(redirectTargets()).toEqual(["/projects"]);
    expect(nav.router.push).not.toHaveBeenCalled();
    expect(screen.queryByText("Could not load tasks")).not.toBeInTheDocument();
  });
});

describe("board route columns from the project's workflows", () => {
  function boardTask(id: string, status: string) {
    return {
      id,
      projectId: "p-1",
      title: `Task ${id}`,
      status,
      priority: "MEDIUM",
      labels: [],
      attachments: [],
      artifacts: [],
      comments: [],
      blockedBy: [],
      blocks: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    } as unknown as Task;
  }

  const CUSTOM_WORKFLOWS = [
    {
      id: "wf-1",
      projectId: "p-1",
      name: "Custom",
      isDefault: true,
      definition: {
        initialState: "open",
        states: [
          { name: "open", label: "Open", terminal: false },
          { name: "plan", label: "Plan", terminal: false },
          { name: "build", label: "Build", terminal: false },
          { name: "qa", label: "QA", terminal: false },
          { name: "shipped", label: "Shipped", terminal: true },
        ],
        transitions: [
          { from: "open", to: "plan" },
          { from: "plan", to: "build" },
          { from: "build", to: "qa" },
          { from: "qa", to: "shipped" },
        ],
      },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  ] as unknown as Awaited<ReturnType<typeof getWorkflows>>;

  const STATUSES = ["backlog", "open", "plan", "build", "qa", "shipped", "legacy_x", "abandoned"];

  /** The shipped default workflow row (what a built-in project answers). */
  const BUILT_IN_WORKFLOWS = [
    {
      ...CUSTOM_WORKFLOWS[0],
      id: "wf-built-in",
      definition: {
        initialState: "open",
        states: [
          { name: "open", label: "Open", terminal: false },
          { name: "in_progress", label: "In progress", terminal: false },
          { name: "review", label: "Review", terminal: false },
          { name: "done", label: "Done", terminal: true },
        ],
        transitions: [
          { from: "open", to: "in_progress" },
          { from: "in_progress", to: "review" },
          { from: "review", to: "done" },
        ],
      },
    },
  ] as unknown as Awaited<ReturnType<typeof getWorkflows>>;

  /** The board's column sections, in DOM order. */
  function columnIds(): string[] {
    return [...document.querySelectorAll("#board-region .db-board > .db-col")].map((el) => el.id);
  }

  it("renders the custom workflow's columns with the task in each of them", async () => {
    mockGetProject.mockResolvedValue(PROJECT);
    vi.mocked(getTasks).mockResolvedValue(STATUSES.map((s, i) => boardTask(`t-${i}`, s)));
    vi.mocked(getWorkflows).mockResolvedValue(CUSTOM_WORKFLOWS);
    renderRoute();

    await waitFor(() =>
      expect(columnIds()).toEqual([
        "db-col-backlog",
        "db-col-open",
        "db-col-plan",
        "db-col-build",
        "db-col-qa",
        "db-col-shipped",
        "db-col-legacy_x",
        // and no eighth column for the task in the reserved `abandoned` status
      ]),
    );
    // The unknown-status task is visible in its extra column; the discarded
    // one is on no column at all (the board has never shown `abandoned`).
    expect(screen.getByLabelText("legacy_x, 1 task")).toBeInTheDocument();
    expect(document.getElementById("db-col-abandoned")).toBeNull();
    // And the list-view chip row follows the same column list.
    await userEvent.click(screen.getByRole("tab", { name: "List" }));
    const summary = await waitFor(() => {
      const el = document.querySelector(".db-status-summary");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(summary.textContent).toContain("QA");
    expect(summary.textContent).toContain("legacy_x");
    expect(summary.textContent).not.toContain("In Progress");
  });

  it("shows the five built-in columns for a built-in project with discarded tasks", async () => {
    mockGetProject.mockResolvedValue(PROJECT);
    vi.mocked(getTasks).mockResolvedValue([
      boardTask("t-1", "backlog"),
      boardTask("t-2", "open"),
      boardTask("t-3", "done"),
      boardTask("t-4", "abandoned"),
      boardTask("t-5", "abandoned"),
    ]);
    vi.mocked(getWorkflows).mockResolvedValue(BUILT_IN_WORKFLOWS);
    renderRoute();

    await waitFor(() => expect(screen.queryByText("Loading tasks")).not.toBeInTheDocument());
    expect(columnIds()).toEqual([
      "db-col-backlog",
      "db-col-open",
      "db-col-in_progress",
      "db-col-review",
      "db-col-done",
    ]);
    // A discarded task is neither a column nor a card in one.
    expect(screen.queryByText("Task t-4")).not.toBeInTheDocument();
    // The list-view chip row stays on the same five.
    await userEvent.click(screen.getByRole("tab", { name: "List" }));
    const summary = await waitFor(() => {
      const el = document.querySelector(".db-status-summary");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(summary.textContent).not.toContain("abandoned");
  });

  it("shows the five built-in columns when the workflows answer 403", async () => {
    mockGetProject.mockResolvedValue(PROJECT);
    vi.mocked(getTasks).mockResolvedValue([boardTask("t-1", "open"), boardTask("t-2", "plan")]);
    vi.mocked(getWorkflows).mockRejectedValue(new ApiRequestError("forbidden", "nope", 403));
    renderRoute();

    await waitFor(() => expect(screen.queryByText("Loading tasks")).not.toBeInTheDocument());
    expect(columnIds()).toEqual([
      "db-col-backlog",
      "db-col-open",
      "db-col-in_progress",
      "db-col-review",
      "db-col-done",
      // The invariant holds even at 403: the plan task is not invisible.
      "db-col-plan",
    ]);
  });

  it("shows the five built-in columns when the workflow request fails on the network", async () => {
    mockGetProject.mockResolvedValue(PROJECT);
    vi.mocked(getTasks).mockResolvedValue([boardTask("t-1", "open")]);
    vi.mocked(getWorkflows).mockRejectedValue(new TypeError("Failed to fetch"));
    renderRoute();

    await waitFor(() => expect(screen.queryByText("Loading tasks")).not.toBeInTheDocument());
    expect(columnIds()).toEqual([
      "db-col-backlog",
      "db-col-open",
      "db-col-in_progress",
      "db-col-review",
      "db-col-done",
    ]);
  });

  it("keeps the built-in columns while the workflow list is on its way", async () => {
    mockGetProject.mockResolvedValue(PROJECT);
    vi.mocked(getTasks).mockResolvedValue([boardTask("t-1", "open")]);
    let release: (w: typeof CUSTOM_WORKFLOWS) => void = () => {};
    vi.mocked(getWorkflows).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    renderRoute();

    await waitFor(() => expect(screen.queryByText("Loading tasks")).not.toBeInTheDocument());
    expect(columnIds()).toHaveLength(5);
    release(CUSTOM_WORKFLOWS);
    await waitFor(() => expect(columnIds()).toContain("db-col-plan"));
  });
});
