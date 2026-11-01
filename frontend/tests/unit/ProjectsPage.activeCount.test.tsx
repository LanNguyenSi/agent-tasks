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
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
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
