/** @vitest-environment jsdom */
/**
 * Board toolbar (app/projects/[id]/board): the row below the hub band. It
 * carries no title of its own (the band owns the page's only H1 and the
 * crumb), keeps search / filter / view toggle / import / new task, shows the
 * task count next to the view toggle, and no longer has the "Project
 * settings" overflow menu, whose Workflow / Members / Settings links are
 * tabs of the band.
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

const TASKS = [
  task("a-1", "Alpha retry", "open"),
  task("a-2", "Beta cache", "open"),
  task("a-3", "Gamma retry loop", "in_progress"),
];

async function renderToolbar() {
  render(
    <ToastProvider>
      <ProjectBoardPage />
    </ToastProvider>,
  );
  await waitFor(() => expect(screen.getByRole("button", { name: /new task/i })).toBeEnabled());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue(USER);
  vi.mocked(getTeams).mockResolvedValue([]);
  vi.mocked(getProject).mockResolvedValue(PROJECT);
  vi.mocked(getTasks).mockResolvedValue(TASKS);
  window.localStorage.clear();
  window.history.replaceState({}, "", "/projects/p-1/board");
  Element.prototype.scrollIntoView = vi.fn();
});

describe("board toolbar below the hub band", () => {
  it("renders no heading and no project name of its own", async () => {
    await renderToolbar();
    expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
    expect(screen.queryByText("Project One")).not.toBeInTheDocument();
  });

  it("keeps search, filter, view toggle, import and new task", async () => {
    await renderToolbar();
    expect(screen.getByRole("searchbox", { name: "Search tasks" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Filter/ })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "View" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /new task/i })).toBeEnabled();
  });

  it("has no project overflow menu: Workflow, Members and Settings are the band's tabs", async () => {
    await renderToolbar();
    expect(screen.queryByRole("button", { name: "Project settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /workflow/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /members/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /settings/i })).not.toBeInTheDocument();
  });

  it("shows the task count in the same group as the view toggle", async () => {
    await renderToolbar();
    const count = screen.getByText("3 tasks");
    const group = count.closest(".db-toolbar-main");
    expect(group).not.toBeNull();
    expect(within(group as HTMLElement).getByRole("tablist", { name: "View" })).toBeInTheDocument();
  });

  it("shows 'shown / total' while a filter is active and the plain count again after clearing it", async () => {
    await renderToolbar();
    const search = screen.getByRole("searchbox", { name: "Search tasks" });
    await userEvent.type(search, "retry");
    expect(await screen.findByText("2 / 3 tasks")).toBeInTheDocument();
    expect(screen.queryByText("3 tasks")).not.toBeInTheDocument();

    await userEvent.clear(search);
    expect(await screen.findByText("3 tasks")).toBeInTheDocument();
    expect(screen.queryByText("2 / 3 tasks")).not.toBeInTheDocument();
  });

  it("keeps the count in the toolbar in list view", async () => {
    await renderToolbar();
    await userEvent.click(screen.getByRole("tab", { name: /List/ }));
    const count = screen.getByText("3 tasks");
    expect(count.closest(".db-toolbar-main")).not.toBeNull();
  });
});
