/** @vitest-environment jsdom */
/**
 * /tasks page -- keyboard focus when a row action drops its row
 * (row-action focus recovery, src/app/tasks/page.tsx + the row menu in
 * _components/columns.tsx).
 *
 * The row menu returns focus to its trigger when an item runs. When the
 * refreshed list drops the actioned row (e.g. Promote while the Backlog chip
 * filters), that trigger unmounts, so the page hands focus over instead of
 * letting it fall to the document body:
 *   - row gone, rows left      -> the next row's trigger (the one occupying
 *                                 the removed row's slot), or the previous
 *                                 row's trigger when it was the last row;
 *   - row gone, table now empty -> the results region (.tasks-table-region);
 *   - row still in the refreshed list -> focus stays on its own trigger.
 * The fake API drops the row from every list response after its PATCH, which
 * is what a filtered refresh does in the app.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Task, User, Team, TeamTasksProject } from "../../src/lib/api";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/tasks",
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams("status=backlog"),
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  getTeamTasks: vi.fn(),
  updateTask: vi.fn(),
}));

vi.mock("../../src/components/tasks/NewTaskFlow", () => ({ default: () => null }));

import TasksPageRaw from "../../src/app/tasks/page";
import { withTeamList } from "./helpers/withTeamList";
const TasksPage = withTeamList(TasksPageRaw);
import { getCurrentUser, getTeams, getTeamTasks, updateTask } from "../../src/lib/api";

const mockGetCurrentUser = vi.mocked(getCurrentUser);
const mockGetTeams = vi.mocked(getTeams);
const mockGetTeamTasks = vi.mocked(getTeamTasks);
const mockUpdateTask = vi.mocked(updateTask);

const USER: User = {
  id: "u-1",
  login: "lan",
  name: "Lan",
  avatarUrl: null,
  email: null,
  githubConnected: false,
  allowAgentPrCreate: false,
  allowAgentPrMerge: false,
  allowAgentPrComment: false,
};
const TEAM: Team = { id: "team-1", name: "Pandora", slug: "pandora", role: "ADMIN", createdAt: "2026-01-01T00:00:00Z" };
const PROJECT: TeamTasksProject = { id: "proj-1", name: "Agent Tasks", slug: "agent-tasks", accessSource: "team" };

function makeTask(over: Partial<Task> & { id: string; title: string }): Task {
  return {
    projectId: "proj-1",
    status: "backlog",
    description: null,
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

function listResponse(tasks: Task[]) {
  return {
    tasks,
    projects: [PROJECT],
    counts: { open: 0, review: 0, done: 0, priority: 0, mine: 0, total: tasks.length },
    filteredTotal: tasks.length,
  };
}

function trigger(title: string): HTMLElement {
  return screen.getByRole("button", { name: `Actions for ${title}` });
}

/** Open a row's "..." menu and run one item (the panel renders in a portal).
 *  The first trigger lookup also waits for the initial list to render. */
async function runRowAction(title: string, item: string): Promise<void> {
  await userEvent.click(await screen.findByRole("button", { name: `Actions for ${title}` }));
  await userEvent.click(await screen.findByRole("menuitem", { name: item }));
}

/** Let the recovery's macrotask (and any later fetch commit) pass. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(USER);
  mockGetTeams.mockResolvedValue([TEAM]);
});

afterEach(cleanup);

describe("/tasks row action dropping its row: focus recovery", () => {
  it("focuses the next row's trigger when the actioned row leaves the list", async () => {
    const a = makeTask({ id: "t-a", title: "Row A" });
    const b = makeTask({ id: "t-b", title: "Row B" });
    const c = makeTask({ id: "t-c", title: "Row C" });
    mockGetTeamTasks
      .mockResolvedValueOnce(listResponse([a, b, c]))
      .mockResolvedValue(listResponse([b, c]));
    mockUpdateTask.mockResolvedValue({ ...a, status: "open" });

    render(<TasksPage />);
    await runRowAction("Row A", "Promote");

    await waitFor(() => expect(trigger("Row B")).toHaveFocus());
    // Still there after the recovery window: the next row, not a later one.
    await settle();
    expect(trigger("Row B")).toHaveFocus();
    expect(trigger("Row C")).not.toHaveFocus();
  });

  it("focuses the previous row's trigger when the last row leaves the list", async () => {
    const a = makeTask({ id: "t-a", title: "Row A" });
    const b = makeTask({ id: "t-b", title: "Row B" });
    const c = makeTask({ id: "t-c", title: "Row C" });
    mockGetTeamTasks
      .mockResolvedValueOnce(listResponse([a, b, c]))
      .mockResolvedValue(listResponse([a, b]));
    mockUpdateTask.mockResolvedValue({ ...c, status: "open" });

    render(<TasksPage />);
    await runRowAction("Row C", "Promote");

    await waitFor(() => expect(trigger("Row B")).toHaveFocus());
    await settle();
    expect(trigger("Row B")).toHaveFocus();
  });

  it("focuses the results region when the actioned row was the only row", async () => {
    const a = makeTask({ id: "t-a", title: "Row A" });
    mockGetTeamTasks
      .mockResolvedValueOnce(listResponse([a]))
      .mockResolvedValue(listResponse([]));
    mockUpdateTask.mockResolvedValue({ ...a, status: "open" });

    render(<TasksPage />);
    await runRowAction("Row A", "Promote");

    await waitFor(() => expect(document.querySelector(".tasks-table-region")).toHaveFocus());
  });

  it("keeps focus on its own trigger when the row stays in the refreshed list", async () => {
    const a = makeTask({ id: "t-a", title: "Row A" });
    const b = makeTask({ id: "t-b", title: "Row B" });
    mockGetTeamTasks.mockResolvedValue(listResponse([a, b]));
    mockUpdateTask.mockResolvedValue({ ...a, status: "open" });

    render(<TasksPage />);
    await runRowAction("Row A", "Promote");

    // The action completed and the list refreshed (the row is still there,
    // now open), and focus never left the row's own trigger.
    await waitFor(() => expect(mockUpdateTask).toHaveBeenCalledWith("t-a", { status: "open" }));
    expect(mockGetTeamTasks.mock.calls.length).toBeGreaterThanOrEqual(2);
    await settle();
    expect(trigger("Row A")).toHaveFocus();
  });
});
