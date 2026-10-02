/** @vitest-environment jsdom */
/**
 * /tasks page -- the "Move to backlog" row action end to end at page level:
 * clicking it PATCHes the task with status "backlog" and then re-fetches the
 * list (so the view reflects the new status); a rejected request (e.g. 409
 * because an agent claimed the task first) shows the "Action failed" banner
 * with the server message and does not re-fetch. The cell itself (visibility,
 * claim hint) is covered in TasksPageBacklogActions.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Task, User, Team, TeamTasksProject } from "../../src/lib/api";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  getTeamTasks: vi.fn(),
  updateTask: vi.fn(),
}));

vi.mock("../../src/components/tasks/NewTaskFlow", () => ({ default: () => null }));

import TasksPage from "../../src/app/tasks/page";
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

function makeTask(over: Partial<Task>): Task {
  return {
    id: "task-1",
    projectId: "proj-1",
    title: "Promoted by mistake",
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
    counts: { open: tasks.length, review: 0, done: 0, priority: 0, mine: 0, total: tasks.length },
    filteredTotal: tasks.length,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(USER);
  mockGetTeams.mockResolvedValue([TEAM]);
});

afterEach(cleanup);

describe("/tasks page -- Move to backlog row action", () => {
  it("clicking it PATCHes status backlog and re-fetches the list, which now shows the task as backlog", async () => {
    const open = makeTask({ id: "task-1", status: "open" });
    mockGetTeamTasks
      .mockResolvedValueOnce(listResponse([open]))
      .mockResolvedValue(listResponse([{ ...open, status: "backlog" }]));
    mockUpdateTask.mockResolvedValue({ ...open, status: "backlog" });

    render(<TasksPage />);
    const button = await screen.findByRole("button", { name: "Move to backlog" });
    expect(mockGetTeamTasks).toHaveBeenCalledTimes(1);

    await userEvent.click(button);

    await waitFor(() => expect(mockUpdateTask).toHaveBeenCalledWith("task-1", { status: "backlog" }));
    // The refreshed list replaces the open row's action with Promote/Discard.
    expect(await screen.findByRole("button", { name: "Promote" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move to backlog" })).not.toBeInTheDocument();
    expect(mockGetTeamTasks.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("a rejected request shows the server message in the Action failed banner and does not re-fetch", async () => {
    const open = makeTask({ id: "task-1", status: "open" });
    mockGetTeamTasks.mockResolvedValue(listResponse([open]));
    mockUpdateTask.mockRejectedValue(new Error("Task state changed before the request completed"));

    render(<TasksPage />);
    const button = await screen.findByRole("button", { name: "Move to backlog" });
    await userEvent.click(button);

    expect(await screen.findByText("Action failed")).toBeInTheDocument();
    expect(screen.getByText("Task state changed before the request completed")).toBeInTheDocument();
    expect(mockGetTeamTasks).toHaveBeenCalledTimes(1);
    // The row is still open and the action is available again.
    expect(screen.getByRole("button", { name: "Move to backlog" })).toBeEnabled();
  });

  it("an open row with a claim is disabled and never calls the API", async () => {
    mockGetTeamTasks.mockResolvedValue(
      listResponse([makeTask({ id: "task-1", status: "open", claimedByAgentId: "agent-1" })]),
    );

    render(<TasksPage />);
    const button = await screen.findByRole("button", { name: "Move to backlog" });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });
});
