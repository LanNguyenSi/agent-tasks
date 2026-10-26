/** @vitest-environment jsdom */
/**
 * /tasks follows the current team of the URL, the same team the header
 * switcher shows. The page and AppHeader are rendered together on one
 * in-memory history (tests/setup/fakeNavigation.ts): a header pick pushes
 * `/tasks?teamId=<id>`, `nav.back()` / `nav.forward()` stand in for the
 * browser buttons. The page has no team select of its own. Mock pattern
 * mirrors TasksPage.zeroTeam.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";
import type { Task, Team, User } from "../../src/lib/api";

vi.mock("next/navigation", async () => {
  const m = await import("../setup/fakeNavigation");
  return {
    usePathname: m.usePathname,
    useRouter: m.useRouter,
    useSearchParams: m.useSearchParams,
  };
});

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  getProjects: vi.fn(),
  getTeamTasks: vi.fn(),
  updateTask: vi.fn(),
  logout: vi.fn(),
}));

vi.mock("../../src/components/tasks/NewTaskFlow", () => ({ default: () => null }));

import TasksPage from "../../src/app/tasks/page";
import AppHeader from "../../src/components/AppHeader";
import { nav } from "../setup/fakeNavigation";
import { getCurrentUser, getTeams, getTeamTasks } from "../../src/lib/api";

const TEAMS = [
  { id: "t1", name: "Team One", slug: "one", role: "ADMIN", createdAt: "x" },
  { id: "t2", name: "Team Two", slug: "two", role: "MEMBER", createdAt: "x" },
] as Team[];

type TeamTasksResult = Awaited<ReturnType<typeof getTeamTasks>>;
const COUNTS = { open: 1, review: 0, done: 0, priority: 0, mine: 0, total: 1 };

function result(title: string): TeamTasksResult {
  const t = {
    id: `id-${title}`,
    projectId: "p-1",
    title,
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    attachments: [],
  } as Task;
  return {
    tasks: [t],
    projects: [{ id: "p-1", name: "Proj", slug: "proj", accessSource: "team" }],
    counts: COUNTS,
    filteredTotal: 1,
  } as unknown as TeamTasksResult;
}

function renderBoth() {
  return render(
    <>
      <AppHeader user={{ login: "lan", avatarUrl: null }} teams={TEAMS} />
      <TasksPage />
    </>,
  );
}

/** Pick a team in the header switcher, the way a user would. */
function pick(name: string) {
  fireEvent.click(screen.getByRole("button", { name: /Switch team/ }));
  fireEvent.click(screen.getByRole("menuitemradio", { name }));
}

function headerTeam(): string {
  const label = screen.getByRole("button", { name: /Switch team/ }).getAttribute("aria-label");
  return /current team (.+)$/.exec(label ?? "")?.[1] ?? "";
}

/** A promise the test settles by hand, to control response order. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  nav.reset("/tasks");
  window.localStorage.clear();
  vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", login: "lan" } as User);
  vi.mocked(getTeams).mockResolvedValue(TEAMS);
  vi.mocked(getTeamTasks).mockImplementation(async (teamId: string) =>
    result(teamId === "t2" ? "Beta only task" : "Alpha only task"),
  );
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("/tasks — header team switch", () => {
  it("has no in-page team select (the header switcher owns switching)", async () => {
    render(<TasksPage />);
    await waitFor(() => expect(getTeamTasks).toHaveBeenCalled());
    expect(screen.queryByRole("combobox", { name: "Switch team" })).not.toBeInTheDocument();
  });

  it("loads the other team's tasks when the URL changes to ?teamId=<other>", async () => {
    render(<TasksPage />);
    await waitFor(() => expect(getTeamTasks).toHaveBeenCalledWith("t1", expect.anything()));

    act(() => nav.push("/tasks?teamId=t2"));

    await waitFor(() => expect(getTeamTasks).toHaveBeenCalledWith("t2", expect.anything()));
    expect(window.localStorage.getItem("agent-tasks:lastTeamId")).toBe("t2");
  });

  it("a fast B then A switch ends on A, and B's late response is ignored", async () => {
    renderBoth();
    expect((await screen.findAllByText("Alpha only task")).length).toBeGreaterThan(0);
    const lateB = deferred<TeamTasksResult>();
    vi.mocked(getTeamTasks).mockImplementation((teamId: string) =>
      teamId === "t2" ? lateB.promise : Promise.resolve(result("Alpha only task")),
    );

    pick("Team Two");
    await waitFor(() => expect(getTeamTasks).toHaveBeenCalledWith("t2", expect.anything()));
    pick("Team One");
    await waitFor(() => expect(getTeamTasks).toHaveBeenLastCalledWith("t1", expect.anything()));
    await act(async () => {
      lateB.resolve(result("Beta only task"));
    });

    expect(screen.queryByText("Beta only task")).not.toBeInTheDocument();
    expect((await screen.findAllByText("Alpha only task")).length).toBeGreaterThan(0);
    expect(headerTeam()).toBe("Team One");
  });

  it("browser back and forward move the page and the header together", async () => {
    nav.reset("/tasks?teamId=t1");
    renderBoth();
    await screen.findAllByText("Alpha only task");
    pick("Team Two");
    expect((await screen.findAllByText("Beta only task")).length).toBeGreaterThan(0);
    expect(headerTeam()).toBe("Team Two");

    act(() => nav.back());
    expect((await screen.findAllByText("Alpha only task")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Beta only task")).not.toBeInTheDocument();
    expect(headerTeam()).toBe("Team One");

    act(() => nav.forward());
    expect((await screen.findAllByText("Beta only task")).length).toBeGreaterThan(0);
    expect(headerTeam()).toBe("Team Two");
  });
});
