/** @vitest-environment jsdom */
/**
 * The board page reads the project's workflows for the route's project id, so
 * the route may move on while a workflow list is still on its way. The board
 * must then show neither the project it left (its columns drop the moment the
 * route changes, before the new project's list answers) nor its late reply
 * (a resolved promise for the old project never overwrites the new one).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { Project, Task, User, Workflow } from "../../src/lib/api";

const nav = vi.hoisted(() => ({ id: "p-1", router: { replace: vi.fn(), push: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => nav.router,
  useParams: () => ({ id: nav.id }),
  usePathname: () => `/projects/${nav.id}/board`,
  useSearchParams: () => new URLSearchParams(""),
  useSelectedLayoutSegment: () => "board",
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    getCurrentUser: vi.fn(),
    getProject: vi.fn(),
    getTasks: vi.fn(),
    getTask: vi.fn(),
    getEffectiveWorkflow: vi.fn(),
    getWorkflows: vi.fn(),
  };
});

import ProjectBoardPage from "../../src/app/projects/[id]/board/page";
import { ToastProvider } from "../../src/components/ui/Toast";
import { getCurrentUser, getProject, getTasks, getTask, getWorkflows } from "../../src/lib/api";

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

function project(id: string, name: string): Project {
  return {
    id,
    teamId: "t-1",
    name,
    slug: id,
    githubRepo: null,
    governanceMode: "AUTONOMOUS",
    accessRole: "ADMIN",
  } as unknown as Project;
}

function task(id: string, projectId: string, status: string): Task {
  return {
    id,
    projectId,
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

function workflow(projectId: string, states: string[]): Workflow {
  return {
    id: `wf-${projectId}`,
    projectId,
    name: "Default",
    isDefault: true,
    definition: {
      initialState: "open",
      states: [
        { name: "open", label: "Open", terminal: false },
        ...states.map((name) => ({ name, label: name, terminal: false })),
        { name: `${states[0] ?? "plan"}_end`, label: "End", terminal: true },
      ],
      transitions: [
        { from: "open", to: states[0] ?? "plan" },
        { from: states[0] ?? "plan", to: `${states[0] ?? "plan"}_end` },
      ],
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  } as unknown as Workflow;
}

const BUILT_IN_COLUMNS = ["db-col-backlog", "db-col-open", "db-col-in_progress", "db-col-review", "db-col-done"];

function columnIds(): string[] {
  return [...document.querySelectorAll(".db-board > .db-col")].map((el) => el.id);
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  nav.id = "p-1";
  vi.mocked(getCurrentUser).mockResolvedValue(USER);
  vi.mocked(getTask).mockResolvedValue(task("t-1", "p-1", "open"));
  window.localStorage.clear();
  window.history.replaceState({}, "", "/projects/p-1/board");
});

function renderBoard() {
  return render(
    <ToastProvider>
      <ProjectBoardPage />
    </ToastProvider>,
  );
}

describe("board page -- the workflow list of the project the route left", () => {
  it("drops the first project's columns as soon as the route moves on, before the new list answers", async () => {
    const projectOne = project("p-1", "Project One");
    const projectTwo = project("p-2", "Project Two");
    vi.mocked(getProject).mockImplementation(async (id: string) =>
      id === "p-1" ? projectOne : projectTwo,
    );
    vi.mocked(getTasks).mockImplementation(async (id: string) =>
      id === "p-1" ? [task("t-1", "p-1", "open")] : [task("t-2", "p-2", "open")],
    );
    const pendingTwo = deferred<Workflow[]>();
    vi.mocked(getWorkflows).mockImplementation((id: string) =>
      id === "p-1"
        ? Promise.resolve([workflow("p-1", ["plan"])])
        : pendingTwo.promise,
    );

    const view = renderBoard();
    await waitFor(() => expect(columnIds()).toContain("db-col-plan"));

    nav.id = "p-2";
    view.rerender(
      <ToastProvider>
        <ProjectBoardPage />
      </ToastProvider>,
    );

    // Project one's column is gone while project two's list is still loading,
    // and no column of the old workflow survives in its place.
    await waitFor(() => expect(columnIds()).toEqual(BUILT_IN_COLUMNS));
    expect(columnIds()).not.toContain("db-col-plan");

    pendingTwo.resolve([workflow("p-2", ["triage"])]);
    await waitFor(() =>
      expect(columnIds()).toEqual(["db-col-backlog", "db-col-open", "db-col-triage", "db-col-triage_end"]),
    );
  });

  it("never lets a late reply for the project the route left overwrite the new project's columns", async () => {
    const projectOne = project("p-1", "Project One");
    const projectTwo = project("p-2", "Project Two");
    vi.mocked(getProject).mockImplementation(async (id: string) =>
      id === "p-1" ? projectOne : projectTwo,
    );
    vi.mocked(getTasks).mockImplementation(async (id: string) =>
      id === "p-1" ? [task("t-1", "p-1", "open")] : [task("t-2", "p-2", "open")],
    );
    const pendingOne = deferred<Workflow[]>();
    const pendingTwo = deferred<Workflow[]>();
    vi.mocked(getWorkflows).mockImplementation((id: string) =>
      id === "p-1" ? pendingOne.promise : pendingTwo.promise,
    );

    const view = renderBoard();
    await waitFor(() => expect(screen.queryByText("Loading tasks")).not.toBeInTheDocument());
    expect(columnIds()).toEqual(BUILT_IN_COLUMNS);
    // The workflow request starts after the tasks load; wait for it instead of
    // reading the mock right after the loading text disappears.
    await waitFor(() => expect(vi.mocked(getWorkflows).mock.calls.map((c) => c[0])).toEqual(["p-1"]));

    nav.id = "p-2";
    view.rerender(
      <ToastProvider>
        <ProjectBoardPage />
      </ToastProvider>,
    );
    await waitFor(() => expect(vi.mocked(getWorkflows)).toHaveBeenCalledWith("p-2"));

    // The project the route left stays off the board while its own reply and
    // the new project's reply are both on their way.
    expect(columnIds()).toEqual(BUILT_IN_COLUMNS);

    pendingTwo.resolve([workflow("p-2", ["triage"])]);
    await waitFor(() =>
      expect(columnIds()).toEqual(["db-col-backlog", "db-col-open", "db-col-triage", "db-col-triage_end"]),
    );

    // The first project's answer arrives late: the second project's columns win.
    pendingOne.resolve([workflow("p-1", ["plan"])]);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(columnIds()).toEqual(["db-col-backlog", "db-col-open", "db-col-triage", "db-col-triage_end"]);
    expect(columnIds()).not.toContain("db-col-plan");
  });
});
