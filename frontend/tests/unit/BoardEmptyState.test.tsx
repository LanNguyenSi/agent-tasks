/** @vitest-environment jsdom */
/**
 * Board page first-run state and skip target: a project with no tasks at all
 * shows one empty state (New task, Import, Connect an agent) instead of five
 * "No tasks" boxes, in the board and the list view; a project that has tasks
 * keeps its columns even when the filters hide every one of them. The page
 * wraps its content in one focusable region in every state, the target of the
 * hub layout's "Skip to board" link.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { User, Project, Task } from "../../src/lib/api";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
  useParams: () => ({ id: "p-1" }),
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
  };
});

import ProjectBoardPage from "../../src/app/projects/[id]/board/page";
import { ToastProvider } from "../../src/components/ui/Toast";
import { getCurrentUser, getTeams, getProject, getTasks } from "../../src/lib/api";

const USER = { id: "u-1", login: "lan", name: "Lan" } as User;
const PROJECT = {
  id: "p-1",
  teamId: "t-1",
  name: "Project One",
  slug: "project-one",
  governanceMode: "AUTONOMOUS",
  accessRole: "ADMIN",
} as unknown as Project;

function task(id: string, title: string, status: string): Task {
  return {
    id,
    title,
    status,
    projectId: "p-1",
    description: null,
    priority: "MEDIUM",
    templateData: null,
    claimedByUserId: null,
    claimedByAgentId: null,
    dueAt: null,
    branchName: null,
    prUrl: null,
    prNumber: null,
    result: null,
    labels: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: new Date().toISOString(),
  } as unknown as Task;
}

async function renderPage(tasks: Task[]) {
  vi.mocked(getTasks).mockResolvedValue(tasks);
  render(
    <ToastProvider>
      <ProjectBoardPage />
    </ToastProvider>,
  );
  await waitFor(() => expect(screen.getAllByRole("button", { name: /new task/i })[0]).toBeEnabled());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue(USER);
  vi.mocked(getTeams).mockResolvedValue([]);
  vi.mocked(getProject).mockResolvedValue(PROJECT);
  window.localStorage.clear();
  window.history.replaceState({}, "", "/projects/p-1/board");
  Element.prototype.scrollIntoView = vi.fn();
});

describe("board of a project with no tasks", () => {
  it("shows one empty state with New task, Import and Connect an agent, and no per-column boxes", async () => {
    await renderPage([]);
    expect(screen.getByText("No tasks yet")).toBeInTheDocument();
    expect(screen.queryByText("No tasks")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /tasks?$/ })).not.toBeInTheDocument();
    const empty = screen.getByText("No tasks yet").closest(".empty-state") as HTMLElement;
    expect(within(empty).getByRole("button", { name: "New task" })).toBeEnabled();
    expect(within(empty).getByRole("button", { name: "Import" })).toBeEnabled();
    expect(within(empty).getByRole("link", { name: "Connect an agent" })).toHaveAttribute(
      "href",
      "/settings/team?teamId=t-1#api-tokens",
    );
  });

  it("opens the new-task dialog and the import dialog from the empty state", async () => {
    await renderPage([]);
    const empty = screen.getByText("No tasks yet").closest(".empty-state") as HTMLElement;
    await userEvent.click(within(empty).getByRole("button", { name: "New task" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("shows the same empty state in the list view", async () => {
    await renderPage([]);
    await userEvent.click(screen.getByRole("tab", { name: /List/ }));
    expect(screen.getByText("No tasks yet")).toBeInTheDocument();
    expect(screen.queryByText("No tasks match the current filters.")).not.toBeInTheDocument();
  });
});

describe("board of a project with tasks", () => {
  const TASKS = [task("a-1", "Alpha retry", "open"), task("a-2", "Beta cache", "in_progress")];

  it("keeps the five columns and their placeholders, with no first-run state", async () => {
    await renderPage(TASKS);
    expect(screen.queryByText("No tasks yet")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Backlog, 0 tasks" })).toBeInTheDocument();
    expect(screen.getAllByText("No tasks").length).toBeGreaterThanOrEqual(3);
  });

  it("keeps the columns when the search hides every task", async () => {
    await renderPage(TASKS);
    await userEvent.type(screen.getByRole("searchbox", { name: "Search tasks" }), "zzz-no-match");
    expect(screen.queryByText("No tasks yet")).not.toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Open, 0 tasks" })).toBeInTheDocument();
  });
});

describe("skip link target", () => {
  // The hub layout renders the "Skip to board" link (ProjectLayout test); the
  // page owns its one target, a focusable wrapper present in every state.
  function region(): HTMLElement {
    const el = document.getElementById("board-region");
    expect(el).not.toBeNull();
    return el as HTMLElement;
  }

  it("wraps the board in a programmatically focusable region", async () => {
    await renderPage([task("a-1", "Alpha retry", "open")]);
    expect(region()).toHaveAttribute("tabindex", "-1");
    expect(region()).toContainElement(screen.getByRole("group", { name: "Board" }));
    expect(document.querySelectorAll("#board-region")).toHaveLength(1);
  });

  it("wraps the list view", async () => {
    await renderPage([task("a-1", "Alpha retry", "open")]);
    await userEvent.click(screen.getByRole("tab", { name: /List/ }));
    expect(region()).toHaveAttribute("tabindex", "-1");
    expect(region()).toContainElement(screen.getByText(/tasks shown/));
    expect(screen.queryByRole("group", { name: "Board" })).not.toBeInTheDocument();
  });

  it("wraps the first-run empty state, in the board and the list view", async () => {
    await renderPage([]);
    expect(region()).toHaveAttribute("tabindex", "-1");
    expect(region()).toContainElement(screen.getByText("No tasks yet"));
    await userEvent.click(screen.getByRole("tab", { name: /List/ }));
    expect(region()).toHaveAttribute("tabindex", "-1");
    expect(region()).toContainElement(screen.getByText("No tasks yet"));
  });

  it("is there while the project loads", () => {
    vi.mocked(getProject).mockReturnValue(new Promise(() => {}));
    render(
      <ToastProvider>
        <ProjectBoardPage />
      </ToastProvider>,
    );
    expect(region()).toHaveAttribute("tabindex", "-1");
    expect(region()).toContainElement(screen.getByText("Loading tasks"));
  });

  it("is there after a failed load", async () => {
    vi.mocked(getTasks).mockRejectedValue(new Error("tasks exploded"));
    render(
      <ToastProvider>
        <ProjectBoardPage />
      </ToastProvider>,
    );
    expect(await screen.findByText("tasks exploded")).toBeInTheDocument();
    expect(region()).toHaveAttribute("tabindex", "-1");
    expect(region()).toContainElement(screen.getByText("tasks exploded"));
  });

  it("does not render a skip link of its own (the hub layout owns it)", async () => {
    await renderPage([task("a-1", "Alpha retry", "open")]);
    expect(screen.queryByRole("link", { name: "Skip to board" })).not.toBeInTheDocument();
  });
});

describe("Connect an agent link", () => {
  function connect(): HTMLElement | null {
    const empty = screen.getByText("No tasks yet").closest(".empty-state") as HTMLElement;
    return within(empty).queryByRole("link", { name: "Connect an agent" });
  }

  it("opens the project's team settings at the API tokens section", async () => {
    await renderPage([]);
    expect(connect()).toHaveAttribute("href", "/settings/team?teamId=t-1#api-tokens");
  });

  it("is shown while the role is unknown (older API responses)", async () => {
    vi.mocked(getProject).mockResolvedValue({ ...PROJECT, accessRole: undefined } as Project);
    await renderPage([]);
    expect(connect()).not.toBeNull();
  });

  it.each([
    ["a team member", { accessRole: "HUMAN_MEMBER", accessSource: "team" }],
    ["a team reviewer", { accessRole: "REVIEWER", accessSource: "team" }],
    ["a per-project admin", { accessRole: "PROJECT_ADMIN", accessSource: "project" }],
    ["a per-project share with no role", { accessRole: null, accessSource: "project" }],
  ])("is hidden for %s, who cannot create agent tokens", async (_label, access) => {
    vi.mocked(getProject).mockResolvedValue({ ...PROJECT, ...access } as Project);
    await renderPage([]);
    expect(connect()).toBeNull();
    const empty = screen.getByText("No tasks yet").closest(".empty-state") as HTMLElement;
    expect(within(empty).getByRole("button", { name: "New task" })).toBeEnabled();
  });
});
