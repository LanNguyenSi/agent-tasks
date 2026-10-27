/** @vitest-environment jsdom */
/**
 * /tasks page -- the links into /tasks/[id] carry the list URL as `from`, so
 * the task page can return to the same filtered view. Covers the row link and
 * the NewTaskFlow "edit task" hand-off; the reader side is covered in
 * TaskDetailPage.backNav.test.tsx and routes.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Task, User, Team, TeamTasksProject } from "../../src/lib/api";

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
  updateTask: vi.fn(),
}));

vi.mock("../../src/components/tasks/NewTaskFlow", () => ({
  default: (props: { onEditTask: (id: string) => void }) => (
    <button type="button" onClick={() => props.onEditTask("task-new")}>
      Edit created task
    </button>
  ),
}));

import TasksPageRaw from "../../src/app/tasks/page";
import { withTeamList } from "./helpers/withTeamList";
const TasksPage = withTeamList(TasksPageRaw);
import { getCurrentUser, getTeams, getTeamTasks } from "../../src/lib/api";

const USER = { id: "u-1", login: "lan" } as User;
const TEAM: Team = { id: "team-1", name: "Pandora", slug: "pandora", role: "ADMIN", createdAt: "2026-01-01T00:00:00Z" };
const PROJECT: TeamTasksProject = { id: "proj-1", name: "Agent Tasks", slug: "agent-tasks", accessSource: "team" };
const TASK = {
  id: "task-1",
  projectId: "proj-1",
  title: "Linked task",
  description: null,
  status: "open",
  priority: "MEDIUM",
  templateData: null,
  claimedByUserId: null,
  claimedByAgentId: null,
  labels: [],
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
  attachments: [],
} as unknown as Task;

beforeEach(() => {
  vi.clearAllMocks();
  nav.search = "";
  vi.mocked(getCurrentUser).mockResolvedValue(USER);
  vi.mocked(getTeams).mockResolvedValue([TEAM]);
  vi.mocked(getTeamTasks).mockResolvedValue({
    tasks: [TASK],
    projects: [PROJECT],
    counts: { open: 1, review: 0, done: 0, priority: 0, mine: 0, total: 1 },
    filteredTotal: 1,
  } as never);
});

afterEach(cleanup);

async function rowLink(): Promise<HTMLAnchorElement> {
  const cell = await screen.findByText("Linked task");
  const a = cell.closest("tr")?.querySelector<HTMLAnchorElement>("a.table-row-link");
  expect(a).toBeTruthy();
  return a!;
}

describe("/tasks page -- return link into /tasks/[id]", () => {
  it("the row link carries the full current list query as one encoded from", async () => {
    nav.search = "scope=open&q=a%20b&sort=title";
    render(<TasksPage />);
    const href = (await rowLink()).getAttribute("href")!;
    expect(href).toBe(
      "/tasks/task-1?from=" + encodeURIComponent("/tasks?scope=open&q=a+b&sort=title"),
    );
    // Not the old bare list query.
    expect(href).not.toContain("?scope=");
  });

  it("the row link uses the bare /tasks when the list has no query", async () => {
    nav.search = "";
    render(<TasksPage />);
    expect((await rowLink()).getAttribute("href")).toBe(
      "/tasks/task-1?from=" + encodeURIComponent("/tasks"),
    );
  });

  it("the NewTaskFlow edit hand-off pushes /tasks/<id> with the same from", async () => {
    nav.search = "scope=review";
    render(<TasksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit created task" }));
    expect(routerMocks.push).toHaveBeenCalledWith(
      "/tasks/task-new?from=" + encodeURIComponent("/tasks?scope=review"),
    );
  });
});
