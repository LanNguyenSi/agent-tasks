/** @vitest-environment jsdom */
/**
 * /projects "N active tasks": counted with the shared active definition, the
 * workflow-derived one Home's "Your projects" strip uses (a state of the
 * task's own workflow that is neither terminal nor review-like, never
 * backlog or abandoned), so a project shows the same number on both pages.
 * A project whose workflow list cannot be read (403 or any other failure)
 * falls back to the built-in open + in_progress. Mock/render pattern mirrors
 * ProjectsPage.currentTeam.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act, fireEvent } from "@testing-library/react";
import { waitForCall } from "./helpers/waitForCall";
import type { Project, Task, Team, User, Workflow } from "../../src/lib/api";

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
  getTasks: vi.fn(),
  getWorkflows: vi.fn(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  syncTeamFromGitHub: vi.fn(),
  logout: vi.fn(),
}));

import ProjectsPageRaw from "../../src/app/projects/page";
import { withTeamList } from "./helpers/withTeamList";
const ProjectsPage = withTeamList(ProjectsPageRaw);
import { nav } from "../setup/fakeNavigation";
import { getCurrentUser, getTeams, getProjects, getTasks, getWorkflows } from "../../src/lib/api";

const TEAM = {
  id: "t1",
  name: "Team One",
  slug: "team-one",
  role: "ADMIN",
  createdAt: "2026-01-01T00:00:00Z",
} as Team;

const PROJECT = {
  id: "proj-1",
  teamId: "t1",
  name: "Agent Tasks",
  slug: "agent-tasks",
  description: null,
  githubRepo: null,
} as unknown as Project;

function tasksWith(statuses: string[]): Task[] {
  return statuses.map((status, i) => ({ id: `t${i}`, projectId: "proj-1", status }) as Task);
}

/** A stored default workflow row for proj-1 with the given states and edges. */
function workflow(states: [string, boolean][], edges: [string, string][], id = "wf-1"): Workflow {
  return {
    id,
    projectId: "proj-1",
    name: "Flow",
    isDefault: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    definition: {
      initialState: "open",
      states: states.map(([name, terminal]) => ({ name, label: name, terminal })),
      transitions: edges.map(([from, to]) => ({ from, to })),
    },
  } as unknown as Workflow;
}

// open -> plan -> build -> qa -> shipped, qa review-like, shipped terminal:
// active states open, plan, build.
const RELEASE_FLOW = () =>
  workflow(
    [["open", false], ["plan", false], ["build", false], ["qa", false], ["shipped", true]],
    [["open", "plan"], ["plan", "build"], ["build", "qa"], ["qa", "shipped"], ["qa", "build"]],
    "wf-release",
  );

beforeEach(() => {
  vi.clearAllMocks();
  nav.reset("/projects");
  window.localStorage.clear();
  vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", login: "lan" } as User);
  vi.mocked(getTeams).mockResolvedValue([TEAM]);
  vi.mocked(getProjects).mockResolvedValue([PROJECT]);
  vi.mocked(getWorkflows).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("/projects: heading", () => {
  it("is the one H1 'Projects' with the team name in the band summary, not an H2", async () => {
    vi.mocked(getTasks).mockResolvedValue([]);
    render(<ProjectsPage />);
    expect(await screen.findByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole("heading", { level: 2, name: TEAM.name })).toBeNull();
    await waitFor(() =>
      expect(document.querySelector(".page-header-summary")).toHaveTextContent(`${TEAM.name} · 1 project`),
    );
  });
});

describe("/projects: active task count", () => {
  it("counts open and in_progress only", async () => {
    vi.mocked(getTasks).mockResolvedValue(
      tasksWith(["open", "open", "in_progress", "review", "backlog", "done", "abandoned"]),
    );

    render(<ProjectsPage />);

    await waitFor(() => expect(getTasks).toHaveBeenCalledWith("proj-1"));
    expect(await screen.findByText("3 active tasks")).toBeInTheDocument();
  });

  it("shows no count for a project whose tasks are all review, backlog or finished", async () => {
    vi.mocked(getTasks).mockResolvedValue(tasksWith(["review", "backlog", "done"]));

    render(<ProjectsPage />);

    await waitFor(() => expect(getTasks).toHaveBeenCalledWith("proj-1"));
    expect(await screen.findByText("Agent Tasks")).toBeInTheDocument();
    // Let the count request settle before asserting that nothing shows.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/active task/)).toBeNull();
  });

  it("counts the active states of a custom workflow (the same number Home's strip shows)", async () => {
    vi.mocked(getWorkflows).mockResolvedValue([RELEASE_FLOW()]);
    vi.mocked(getTasks).mockResolvedValue(
      tasksWith([
        "open",
        "plan",
        "plan",
        "build",
        "build",
        "build",
        "qa",
        "shipped",
        "shipped",
        "backlog",
        "abandoned",
      ]),
    );

    render(<ProjectsPage />);

    await waitFor(() => expect(getWorkflows).toHaveBeenCalledWith("proj-1"));
    // open + 2 plan + 3 build are the workflow's active states; qa is
    // review-like, shipped terminal, backlog/abandoned never count.
    expect(await screen.findByText("6 active tasks")).toBeInTheDocument();
  });

  it("is unchanged for a four-state (built-in) workflow: open + in_progress", async () => {
    vi.mocked(getWorkflows).mockResolvedValue([
      workflow(
        [["open", false], ["in_progress", false], ["review", false], ["done", true]],
        [["open", "in_progress"], ["in_progress", "review"], ["review", "done"]],
      ),
    ]);
    vi.mocked(getTasks).mockResolvedValue(
      tasksWith(["open", "in_progress", "in_progress", "review", "done", "backlog"]),
    );

    render(<ProjectsPage />);

    expect(await screen.findByText("3 active tasks")).toBeInTheDocument();
  });

  it("falls back to open + in_progress when the workflow list answers 403", async () => {
    vi.mocked(getWorkflows).mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));
    vi.mocked(getTasks).mockResolvedValue(tasksWith(["open", "in_progress", "plan", "build", "shipped"]));

    render(<ProjectsPage />);

    // Unreadable workflows read as the built-in workflow, not as "no project".
    expect(await screen.findByText("2 active tasks")).toBeInTheDocument();
  });

  it("falls back to open + in_progress when the workflow request rejects for another reason", async () => {
    vi.mocked(getWorkflows).mockRejectedValue(new Error("network down"));
    vi.mocked(getTasks).mockResolvedValue(tasksWith(["open", "plan", "build", "shipped"]));

    render(<ProjectsPage />);

    expect(await screen.findByText("1 active task")).toBeInTheDocument();
  });
});

/**
 * The poll reuses the workflow rows it already read (loadMissingProjectWorkflows
 * in home/projectWorkflows.ts, the same cache Home and /tasks use): each
 * project's workflow list is asked once per team, a 403 is remembered instead
 * of retried every cycle, any other failure is retried on the next poll, a
 * project added to the list is fetched, and a team switch drops the cache.
 * getTasks still runs per project on every 15 s beat.
 */
describe("/projects: workflow cache across polls", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const PROJECT2 = {
    ...PROJECT,
    id: "proj-2",
    name: "Second Project",
    slug: "second",
  } as unknown as Project;

  const TEAM2: Team = { ...TEAM, id: "t2", name: "Team Two", slug: "team-two" };

  function forbiddenError(): Error & { status: number } {
    return Object.assign(new Error("forbidden"), { status: 403 });
  }

  it("asks each project's workflow once while getTasks keeps polling every 15 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(getProjects).mockResolvedValue([PROJECT, PROJECT2]);
    vi.mocked(getTasks).mockResolvedValue([]);

    render(<ProjectsPage />);

    await waitFor(() => expect(getTasks).toHaveBeenCalledTimes(2));
    expect(getWorkflows).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    await waitFor(() => expect(getTasks).toHaveBeenCalledTimes(4));
    expect(getWorkflows).toHaveBeenCalledTimes(2);
  });

  it("does not ask a project that answered 403 again on the next poll", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(getProjects).mockResolvedValue([PROJECT, PROJECT2]);
    vi.mocked(getTasks).mockResolvedValue([]);
    vi.mocked(getWorkflows).mockImplementation((id: string) =>
      id === PROJECT2.id ? Promise.reject(forbiddenError()) : Promise.resolve([]),
    );

    render(<ProjectsPage />);

    await waitFor(() => expect(getTasks).toHaveBeenCalledTimes(2));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    await waitFor(() => expect(getTasks).toHaveBeenCalledTimes(4));
    const calls = await waitForCall(vi.mocked(getWorkflows));
    expect(calls.filter((c) => c[0] === PROJECT2.id)).toHaveLength(1);
    expect(calls.filter((c) => c[0] === PROJECT.id)).toHaveLength(1);
  });

  it("retries a workflow that failed for another reason on the next poll", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(getProjects).mockResolvedValue([PROJECT, PROJECT2]);
    vi.mocked(getTasks).mockResolvedValue([]);
    vi.mocked(getWorkflows).mockImplementation((id: string) =>
      id === PROJECT2.id
        ? Promise.reject(Object.assign(new Error("server exploded"), { status: 500 }))
        : Promise.resolve([]),
    );

    render(<ProjectsPage />);

    await waitFor(() => expect(getTasks).toHaveBeenCalledTimes(2));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    await waitFor(() => expect(getTasks).toHaveBeenCalledTimes(4));
    const calls = await waitForCall(vi.mocked(getWorkflows), { times: 3 });
    expect(calls.filter((c) => c[0] === PROJECT2.id)).toHaveLength(2);
    expect(calls.filter((c) => c[0] === PROJECT.id)).toHaveLength(1);
  });

  it("fetches the workflow of a project added to the list", async () => {
    const { createProject } = await import("../../src/lib/api");
    vi.mocked(getTasks).mockResolvedValue([]);
    vi.mocked(createProject).mockResolvedValue(PROJECT2 as Awaited<ReturnType<typeof createProject>>);

    render(<ProjectsPage />);

    await waitFor(() => expect(getWorkflows).toHaveBeenCalledWith(PROJECT.id));

    fireEvent.click(screen.getAllByRole("button", { name: /New Project/ })[0]!);
    fireEvent.change(screen.getByPlaceholderText("My Project"), { target: { value: "Second" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(getWorkflows).toHaveBeenCalledWith(PROJECT2.id));
  });

  it("asks again for a project the cache held when the team comes back", async () => {
    vi.mocked(getTeams).mockResolvedValue([TEAM, TEAM2]);
    vi.mocked(getProjects).mockImplementation((teamId?: string) =>
      Promise.resolve(teamId === "t2" ? [PROJECT2] : [PROJECT]),
    );
    vi.mocked(getTasks).mockResolvedValue([]);

    render(<ProjectsPage />);

    await waitFor(() => expect(getWorkflows).toHaveBeenCalledWith(PROJECT.id));
    act(() => nav.push("/projects?teamId=t2"));
    await waitFor(() => expect(getWorkflows).toHaveBeenCalledWith(PROJECT2.id));

    act(() => nav.push("/projects?teamId=t1"));

    // The cache of the team that was left is gone: proj-1 is read a second
    // time, proj-2 is not asked again while away.
    const calls = await waitForCall(vi.mocked(getWorkflows), { times: 3 });
    expect(calls.filter((c) => c[0] === PROJECT.id)).toHaveLength(2);
    expect(calls.filter((c) => c[0] === PROJECT2.id)).toHaveLength(1);
  });

  it("asks again for a project that answered 403 once the team comes back", async () => {
    vi.mocked(getTeams).mockResolvedValue([TEAM, TEAM2]);
    vi.mocked(getProjects).mockImplementation((teamId?: string) =>
      Promise.resolve(teamId === "t2" ? [PROJECT2] : [PROJECT]),
    );
    vi.mocked(getTasks).mockResolvedValue([]);
    vi.mocked(getWorkflows).mockImplementation((id: string) =>
      id === PROJECT.id ? Promise.reject(forbiddenError()) : Promise.resolve([]),
    );

    render(<ProjectsPage />);

    await waitFor(() => expect(getWorkflows).toHaveBeenCalledWith(PROJECT.id));
    act(() => nav.push("/projects?teamId=t2"));
    await waitFor(() => expect(getWorkflows).toHaveBeenCalledWith(PROJECT2.id));

    act(() => nav.push("/projects?teamId=t1"));

    // The 403 set of the team that was left is gone too: proj-1 is asked a
    // second time although it answered 403 before.
    const calls = await waitForCall(vi.mocked(getWorkflows), { times: 3 });
    expect(calls.filter((c) => c[0] === PROJECT.id)).toHaveLength(2);
  });
});
