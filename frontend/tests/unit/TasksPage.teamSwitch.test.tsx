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
import { render, screen, cleanup, waitFor, fireEvent, act, within } from "@testing-library/react";
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

// Stand-in for the create flow: while open it lists the projects it offers.
vi.mock("../../src/components/tasks/NewTaskFlow", () => ({
  default: ({ open, projects }: { open: boolean; projects: { id: string; name: string }[] }) =>
    open ? (
      <ul aria-label="New task projects">
        {projects.map((p) => (
          <li key={p.id}>{p.name}</li>
        ))}
      </ul>
    ) : null,
}));

import TasksPage from "../../src/app/tasks/page";
import AppHeader from "../../src/components/AppHeader";
import { nav } from "../setup/fakeNavigation";
import { getCurrentUser, getTeams, getTeamTasks, updateTask } from "../../src/lib/api";

const TEAMS = [
  { id: "t1", name: "Team One", slug: "one", role: "ADMIN", createdAt: "x" },
  { id: "t2", name: "Team Two", slug: "two", role: "MEMBER", createdAt: "x" },
] as Team[];

type TeamTasksResult = Awaited<ReturnType<typeof getTeamTasks>>;
const COUNTS = { open: 1, review: 0, done: 0, priority: 0, mine: 0, total: 1 };

function result(title: string, projectName = "Proj"): TeamTasksResult {
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
    projects: [{ id: "p-1", name: projectName, slug: "proj", accessSource: "team" }],
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
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The project names the open create flow offers. */
function offeredProjects(): string[] {
  return within(screen.getByRole("list", { name: "New task projects" }))
    .queryAllByRole("listitem")
    .map((li) => li.textContent ?? "");
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

describe("/tasks: nothing of the team that was left shows under the new team", () => {
  beforeEach(() => {
    vi.mocked(getTeamTasks).mockImplementation(async (teamId: string) =>
      teamId === "t2"
        ? result("Beta only task", "Beta project")
        : result("Alpha only task", "Alpha project"),
    );
  });

  it("while the new team's list is pending: no old rows, the loading state, and New task offers no old project", async () => {
    nav.reset("/tasks?teamId=t1");
    renderBoth();
    await screen.findAllByText("Alpha only task");
    const pendingB = deferred<TeamTasksResult>();
    vi.mocked(getTeamTasks).mockImplementation((teamId: string) =>
      teamId === "t2" ? pendingB.promise : Promise.resolve(result("Alpha only task", "Alpha project")),
    );

    pick("Team Two");
    await waitFor(() => expect(getTeamTasks).toHaveBeenLastCalledWith("t2", expect.anything()));

    expect(screen.queryByText("Alpha only task")).not.toBeInTheDocument();
    expect(screen.getAllByText("Loading tasks").length).toBeGreaterThan(0);
    expect(screen.queryByRole("option", { name: "Alpha project" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /New task/ }));
    expect(offeredProjects()).toEqual([]);

    await act(async () => {
      pendingB.resolve(result("Beta only task", "Beta project"));
    });
    expect((await screen.findAllByText("Beta only task")).length).toBeGreaterThan(0);
    expect(offeredProjects()).toEqual(["Beta project"]);
  });

  it("a rejected load of the new team shows its error, not the old team's rows or projects", async () => {
    nav.reset("/tasks?teamId=t1");
    renderBoth();
    await screen.findAllByText("Alpha only task");
    vi.mocked(getTeamTasks).mockImplementation((teamId: string) =>
      teamId === "t2"
        ? Promise.reject(new Error("team two is down"))
        : Promise.resolve(result("Alpha only task", "Alpha project")),
    );

    pick("Team Two");

    expect(await screen.findByText("team two is down")).toBeInTheDocument();
    expect(screen.queryByText("Alpha only task")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading tasks")).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Alpha project" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /New task/ }));
    expect(offeredProjects()).toEqual([]);
    expect(headerTeam()).toBe("Team Two");
  });

  it("the old team's load error does not show under the new team, also while its list is pending", async () => {
    nav.reset("/tasks?teamId=t1");
    const pendingB = deferred<TeamTasksResult>();
    vi.mocked(getTeamTasks).mockImplementation((teamId: string) =>
      teamId === "t1" ? Promise.reject(new Error("team one is down")) : pendingB.promise,
    );
    renderBoth();
    expect(await screen.findByText("team one is down")).toBeInTheDocument();

    pick("Team Two");
    await waitFor(() => expect(getTeamTasks).toHaveBeenLastCalledWith("t2", expect.anything()));

    expect(screen.queryByText("team one is down")).not.toBeInTheDocument();
    expect(screen.getAllByText("Loading tasks").length).toBeGreaterThan(0);
    await act(async () => {
      pendingB.resolve(result("Beta only task", "Beta project"));
    });
    expect((await screen.findAllByText("Beta only task")).length).toBeGreaterThan(0);
    expect(screen.queryByText("team one is down")).not.toBeInTheDocument();
  });

  it("a team change closes an open New task flow", async () => {
    nav.reset("/tasks?teamId=t1");
    renderBoth();
    await screen.findAllByText("Alpha only task");
    fireEvent.click(screen.getByRole("button", { name: /New task/ }));
    expect(offeredProjects()).toEqual(["Alpha project"]);

    pick("Team Two");

    expect(screen.queryByRole("list", { name: "New task projects" })).not.toBeInTheDocument();
  });

  it("a team change closes a pending discard confirmation of the old team's task", async () => {
    const backlog = result("Alpha backlog task", "Alpha project");
    backlog.tasks[0] = { ...backlog.tasks[0]!, status: "backlog" } as Task;
    vi.mocked(getTeamTasks).mockImplementation(async (teamId: string) =>
      teamId === "t2" ? result("Beta only task", "Beta project") : backlog,
    );
    nav.reset("/tasks?teamId=t1");
    renderBoth();
    await screen.findAllByText("Alpha backlog task");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByRole("dialog", { name: "Discard task?" })).toBeInTheDocument();

    act(() => nav.push("/tasks?teamId=t2"));

    await screen.findAllByText("Beta only task");
    expect(screen.queryByRole("dialog", { name: "Discard task?" })).not.toBeInTheDocument();
  });

  it("a row action that fails after a switch reports nothing under the new team", async () => {
    nav.reset("/tasks?teamId=t1");
    renderBoth();
    await screen.findAllByText("Alpha only task");
    const demote = deferred<never>();
    vi.mocked(updateTask).mockReturnValue(demote.promise);

    fireEvent.click(screen.getByRole("button", { name: "Move to backlog" }));
    await waitFor(() => expect(updateTask).toHaveBeenCalled());
    pick("Team Two");
    await screen.findAllByText("Beta only task");
    await act(async () => {
      demote.reject(new Error("demote failed late"));
    });

    expect(screen.queryByText("Action failed")).not.toBeInTheDocument();
    expect(screen.queryByText("demote failed late")).not.toBeInTheDocument();
  });
});
