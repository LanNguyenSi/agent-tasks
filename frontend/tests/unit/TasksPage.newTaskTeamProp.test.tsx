/** @vitest-environment jsdom */
/**
 * The /tasks page hands its resolved team to the in-place create flow.
 *
 * NewTaskFlow's empty-state "Go to projects" link carries the `teamId` prop
 * it is given (see NewTaskFlow.test.tsx); this pins the other half of the
 * wiring: the page passes its own current team (the URL's `?teamId`), so a
 * user booting /tasks?teamId=<t> and opening the flow from the empty state
 * lands on /projects?teamId=<t> instead of a bare URL the page would
 * resolve and rewrite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { Team, User } from "../../src/lib/api";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
let query = "teamId=t2";
vi.mock("next/navigation", () => ({
  usePathname: () => "/tasks",
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams(query),
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  getProjects: vi.fn(),
  getTeamTasks: vi.fn(),
  updateTask: vi.fn(),
}));

// The flow renders as a marker holding the teamId prop it was given.
vi.mock("../../src/components/tasks/NewTaskFlow", () => ({
  default: (props: { teamId?: string | null }) => (
    <span data-testid="flow-team" data-team={props.teamId ?? "none"} />
  ),
}));

import TasksPageRaw from "../../src/app/tasks/page";
import { withTeamList } from "./helpers/withTeamList";
const TasksPage = withTeamList(TasksPageRaw);
import { getCurrentUser, getProjects, getTeams, getTeamTasks } from "../../src/lib/api";

const USER = { id: "u-1", login: "lan" } as User;
const TEAMS = [
  { id: "t1", name: "Alpha", slug: "alpha", role: "ADMIN", createdAt: "x" },
  { id: "t2", name: "Beta", slug: "beta", role: "ADMIN", createdAt: "x" },
] as Team[];

beforeEach(() => {
  vi.clearAllMocks();
  query = "teamId=t2";
  window.localStorage.clear();
  vi.mocked(getCurrentUser).mockResolvedValue(USER);
  vi.mocked(getTeams).mockResolvedValue(TEAMS);
  vi.mocked(getProjects).mockResolvedValue([]);
  vi.mocked(getTeamTasks).mockResolvedValue({
    tasks: [],
    projects: [],
    counts: { open: 0, review: 0, done: 0, priority: 0, mine: 0, total: 0 },
    filteredTotal: 0,
  } as never);
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("the create flow's team prop", () => {
  it("is the team the URL names", async () => {
    render(<TasksPage />);
    await screen.findByRole("heading", { level: 1 });
    expect(await screen.findByTestId("flow-team")).toHaveAttribute("data-team", "t2");
  });

  it("is the resolved first team on a URL that names none", async () => {
    query = "";
    render(<TasksPage />);
    await screen.findByRole("heading", { level: 1 });
    expect(await screen.findByTestId("flow-team")).toHaveAttribute("data-team", "t1");
  });
});
