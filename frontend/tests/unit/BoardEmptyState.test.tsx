/** @vitest-environment jsdom */
/**
 * Board page first-run state and skip link: a project with no tasks at all
 * shows one empty state (New task, Import, Connect an agent) instead of five
 * "No tasks" boxes, in the board and the list view; a project that has tasks
 * keeps its columns even when the filters hide every one of them. The "Skip
 * to board" link is the first thing on the page and points at the board.
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
      "/settings/team#api-tokens",
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

describe("skip link", () => {
  it("is the first link of the page content and points at the board", async () => {
    await renderPage([task("a-1", "Alpha retry", "open")]);
    const skip = screen.getByRole("link", { name: "Skip to board" });
    expect(skip).toHaveAttribute("href", "#db-board");
    const shell = skip.closest(".db-shell") as HTMLElement;
    expect(shell.querySelector("a, button, input")).toBe(skip);
    expect(document.getElementById("db-board")).toBe(screen.getByRole("group", { name: "Board" }));
  });

  it("targets the empty state when the project has no tasks", async () => {
    await renderPage([]);
    const skip = screen.getByRole("link", { name: "Skip to board" });
    const target = document.getElementById(skip.getAttribute("href")!.slice(1));
    expect(target).not.toBeNull();
    expect(target).toContainElement(screen.getByText("No tasks yet"));
  });

  it("is not offered in the list view, which has no board to skip to", async () => {
    await renderPage([task("a-1", "Alpha retry", "open")]);
    await userEvent.click(screen.getByRole("tab", { name: /List/ }));
    expect(screen.queryByRole("link", { name: "Skip to board" })).not.toBeInTheDocument();
  });
});
