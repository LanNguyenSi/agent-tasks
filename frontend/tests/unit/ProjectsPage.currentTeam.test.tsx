/** @vitest-environment jsdom */
/**
 * /projects page-level tests for the single current-team rule (T02):
 * the initial team resolves through lib/currentTeam (?teamId -> remembered
 * team -> teams[0]) and a valid `?teamId` is remembered. The page has no
 * team select of its own: the header switcher owns switching (AppHeader),
 * and the page re-resolves its team when the switch is announced.
 * Mock/render pattern mirrors TasksPageDemote.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent, waitFor, within } from "@testing-library/react";
import type { Project, Team, User } from "../../src/lib/api";

// The page's URL is the in-memory history of tests/setup/fakeNavigation.ts, so
// the header pick, back and forward change what the page reads, like the
// real router. `navState.search` is kept as a thin alias for the tests that
// only set the initial query.
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
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  syncTeamFromGitHub: vi.fn(),
  logout: vi.fn(),
}));

import ProjectsPage from "../../src/app/projects/page";
import AppHeader from "../../src/components/AppHeader";
import { nav } from "../setup/fakeNavigation";
import { getCurrentUser, getTeams, getProjects, getTasks } from "../../src/lib/api";

const mockGetCurrentUser = vi.mocked(getCurrentUser);
const mockGetTeams = vi.mocked(getTeams);
const mockGetProjects = vi.mocked(getProjects);
const mockGetTasks = vi.mocked(getTasks);

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

function makeTeam(over: Partial<Team> = {}): Team {
  return {
    id: "t1",
    name: "Team One",
    slug: "team-one",
    role: "ADMIN",
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const PROJECT: Project = {
  id: "proj-1",
  teamId: "t1",
  name: "Agent Tasks",
  slug: "agent-tasks",
  description: null,
  githubRepo: null,
  githubSyncAt: null,
  taskTemplate: null,
  confidenceThreshold: 60,
  requireDistinctReviewer: false,
  soloMode: true,
  governanceMode: "AUTONOMOUS",
  notificationWebhookUrl: null,
  hasNotificationWebhookSecret: false,
  createdAt: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  nav.reset("/projects");
  window.localStorage.clear();
  mockGetCurrentUser.mockResolvedValue(USER);
  mockGetTeams.mockResolvedValue([makeTeam(), makeTeam({ id: "t2", name: "Team Two", slug: "team-two" })]);
  mockGetProjects.mockResolvedValue([PROJECT]);
  mockGetTasks.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("/projects page — current-team resolution (lib/currentTeam)", () => {
  it("a remembered team beats teams[0] when the URL carries no teamId", async () => {
    window.localStorage.setItem("agent-tasks:lastTeamId", "t2");

    render(<ProjectsPage />);
    await waitFor(() => expect(mockGetProjects).toHaveBeenCalledWith("t2"));
    expect(await screen.findByRole("heading", { name: "Team Two" })).toBeInTheDocument();
  });

  it("a valid ?teamId wins over the remembered team and is remembered", async () => {
    nav.reset("/projects?teamId=t2");
    window.localStorage.setItem("agent-tasks:lastTeamId", "t1");

    render(<ProjectsPage />);
    expect(await screen.findByRole("heading", { name: "Team Two" })).toBeInTheDocument();
    await waitFor(() => expect(mockGetProjects).toHaveBeenCalledWith("t2"));
    // URL-selected team becomes the remembered one (same key as the switcher).
    expect(window.localStorage.getItem("agent-tasks:lastTeamId")).toBe("t2");
  });

  it("an invalid ?teamId falls through to the remembered team", async () => {
    nav.reset("/projects?teamId=ghost");
    window.localStorage.setItem("agent-tasks:lastTeamId", "t2");

    render(<ProjectsPage />);
    expect(await screen.findByRole("heading", { name: "Team Two" })).toBeInTheDocument();
    await waitFor(() => expect(mockGetProjects).toHaveBeenCalledWith("t2"));
  });

  it("has no in-page team select (the header switcher owns switching)", async () => {
    render(<ProjectsPage />);
    expect(await screen.findByRole("heading", { name: "Team One" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Switch team" })).not.toBeInTheDocument();
  });
});

const TEAMS = [makeTeam(), makeTeam({ id: "t2", name: "Team Two", slug: "team-two" })];

function renderBoth() {
  return render(
    <>
      <AppHeader user={{ login: "lan", avatarUrl: null }} teams={TEAMS} />
      <ProjectsPage />
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

describe("/projects page: current team follows the URL", () => {
  const T2_PROJECT: Project = { ...PROJECT, id: "proj-2", teamId: "t2", name: "Second Team Project", slug: "second" };

  beforeEach(() => {
    mockGetProjects.mockImplementation(async (teamId?: string) =>
      teamId === "t2" ? [T2_PROJECT] : [PROJECT],
    );
  });

  it("re-resolves the team and reloads its projects when the header switches", async () => {
    renderBoth();
    expect(await screen.findByRole("heading", { name: "Team One" })).toBeInTheDocument();
    await waitFor(() => expect(mockGetProjects).toHaveBeenCalledWith("t1"));

    pick("Team Two");

    expect(await screen.findByRole("heading", { name: "Team Two" })).toBeInTheDocument();
    await waitFor(() => expect(mockGetProjects).toHaveBeenCalledWith("t2"));
    expect((await screen.findAllByText("Second Team Project")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Agent Tasks")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("agent-tasks:lastTeamId")).toBe("t2");
    expect(headerTeam()).toBe("Team Two");
  });

  it("a URL naming the team already shown, or an unknown team, reloads nothing", async () => {
    renderBoth();
    expect(await screen.findByRole("heading", { name: "Team One" })).toBeInTheDocument();
    await waitFor(() => expect(mockGetProjects).toHaveBeenCalledTimes(1));

    act(() => nav.push("/projects?teamId=t1"));
    act(() => nav.push("/projects?teamId=ghost"));

    expect(screen.getByRole("heading", { name: "Team One" })).toBeInTheDocument();
    expect(mockGetProjects).toHaveBeenCalledTimes(1);
  });

  it("a fast B then A switch ends on A, and B's late response is ignored", async () => {
    renderBoth();
    expect((await screen.findAllByText("Agent Tasks")).length).toBeGreaterThan(0);
    const lateB = deferred<Project[]>();
    mockGetProjects.mockImplementation((teamId?: string) =>
      teamId === "t2" ? lateB.promise : Promise.resolve([PROJECT]),
    );

    pick("Team Two");
    await waitFor(() => expect(mockGetProjects).toHaveBeenCalledWith("t2"));
    pick("Team One");
    expect((await screen.findAllByText("Agent Tasks")).length).toBeGreaterThan(0);
    await act(async () => {
      lateB.resolve([T2_PROJECT]);
    });

    expect(screen.queryByText("Second Team Project")).not.toBeInTheDocument();
    // A's list must survive B's late answer, not just hide B's.
    expect(screen.getAllByText("Agent Tasks").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Team One" })).toBeInTheDocument();
    expect(headerTeam()).toBe("Team One");
  });

  it("a late failure of the team that was left shows no error and keeps the current list", async () => {
    renderBoth();
    await screen.findAllByText("Agent Tasks");
    const failingB = deferred<Project[]>();
    mockGetProjects.mockImplementation((teamId?: string) =>
      teamId === "t2" ? failingB.promise : Promise.resolve([PROJECT]),
    );

    pick("Team Two");
    await waitFor(() => expect(mockGetProjects).toHaveBeenCalledWith("t2"));
    pick("Team One");
    await screen.findAllByText("Agent Tasks");
    await act(async () => {
      failingB.reject(new Error("late failure"));
    });

    expect(screen.queryByText("late failure")).not.toBeInTheDocument();
    expect(screen.getAllByText("Agent Tasks").length).toBeGreaterThan(0);
  });

  it("while the new team's list loads, the old team's projects are not shown under its name", async () => {
    renderBoth();
    await screen.findAllByText("Agent Tasks");
    const slowB = deferred<Project[]>();
    mockGetProjects.mockImplementation((teamId?: string) =>
      teamId === "t2" ? slowB.promise : Promise.resolve([PROJECT]),
    );

    pick("Team Two");

    expect(await screen.findByRole("heading", { name: "Team Two" })).toBeInTheDocument();
    expect(screen.queryByText("Agent Tasks")).not.toBeInTheDocument();
    expect(screen.queryByText("No projects yet.")).not.toBeInTheDocument();
    // Nor is the old team's count (one project) carried over.
    expect(screen.getByText("0 projects")).toBeInTheDocument();
    await act(async () => {
      slowB.resolve([T2_PROJECT]);
    });
    expect((await screen.findAllByText("Second Team Project")).length).toBeGreaterThan(0);
  });

  it("browser back and forward move the page and the header together", async () => {
    nav.reset("/projects?teamId=t1");
    renderBoth();
    await screen.findAllByText("Agent Tasks");
    pick("Team Two");
    expect((await screen.findAllByText("Second Team Project")).length).toBeGreaterThan(0);

    act(() => nav.back());
    expect(await screen.findByRole("heading", { name: "Team One" })).toBeInTheDocument();
    expect((await screen.findAllByText("Agent Tasks")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Second Team Project")).not.toBeInTheDocument();
    expect(headerTeam()).toBe("Team One");

    act(() => nav.forward());
    expect(await screen.findByRole("heading", { name: "Team Two" })).toBeInTheDocument();
    expect((await screen.findAllByText("Second Team Project")).length).toBeGreaterThan(0);
    expect(headerTeam()).toBe("Team Two");
  });

  it("a switch before the first list arrived still lands on the picked team", async () => {
    const slowFirst = deferred<Project[]>();
    mockGetProjects.mockImplementation((teamId?: string) =>
      teamId === "t1" ? slowFirst.promise : Promise.resolve([T2_PROJECT]),
    );
    renderBoth();
    await waitFor(() => expect(mockGetProjects).toHaveBeenCalledWith("t1"));

    pick("Team Two");
    expect((await screen.findAllByText("Second Team Project")).length).toBeGreaterThan(0);
    await act(async () => {
      slowFirst.resolve([PROJECT]);
    });

    expect(screen.queryByText("Agent Tasks")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Team Two" })).toBeInTheDocument();
    expect(headerTeam()).toBe("Team Two");
  });

  it("a new project goes to the team the page shows after a switch", async () => {
    const { createProject } = await import("../../src/lib/api");
    vi.mocked(createProject).mockResolvedValue({ ...T2_PROJECT, id: "proj-new", name: "Fresh", slug: "fresh" });
    renderBoth();
    await screen.findAllByText("Agent Tasks");
    pick("Team Two");
    await screen.findAllByText("Second Team Project");

    fireEvent.click(screen.getAllByRole("button", { name: /New Project/ })[0]!);
    fireEvent.change(screen.getByPlaceholderText("My Project"), { target: { value: "Fresh" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith(expect.objectContaining({ teamId: "t2" })),
    );
  });

  it("a team change closes an open New Project dialog, so nothing is created in the wrong team", async () => {
    renderBoth();
    await screen.findAllByText("Agent Tasks");
    fireEvent.click(screen.getAllByRole("button", { name: /New Project/ })[0]!);
    expect(screen.getByPlaceholderText("My Project")).toBeInTheDocument();

    act(() => nav.push("/projects?teamId=t2"));

    await screen.findAllByText("Second Team Project");
    expect(screen.queryByPlaceholderText("My Project")).not.toBeInTheDocument();
  });

  it("a GitHub sync that finishes after a switch does not reload the old team's list", async () => {
    const { syncTeamFromGitHub } = await import("../../src/lib/api");
    const sync = deferred<Awaited<ReturnType<typeof syncTeamFromGitHub>>>();
    vi.mocked(syncTeamFromGitHub).mockReturnValue(sync.promise);
    mockGetCurrentUser.mockResolvedValue({ ...USER, githubConnected: true });
    renderBoth();
    await screen.findAllByText("Agent Tasks");

    fireEvent.click(screen.getByRole("button", { name: "Sync GitHub" }));
    await waitFor(() => expect(syncTeamFromGitHub).toHaveBeenCalledWith("t1"));
    pick("Team Two");
    await screen.findAllByText("Second Team Project");
    const loadsBefore = mockGetProjects.mock.calls.length;
    await act(async () => {
      sync.resolve({ created: 0, updated: 0, pruned: 0, message: "ok" } as never);
    });

    expect(mockGetProjects.mock.calls).toHaveLength(loadsBefore);
    expect(screen.getAllByText("Second Team Project").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Loading projects")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Team Two" })).toBeInTheDocument();
    // Nor does the old team's sync outcome show up under the new team.
    expect(screen.queryByText("Already up to date")).not.toBeInTheDocument();
  });

  /** Open the delete confirmation for `name` and confirm it. */
  async function confirmDelete(name: string) {
    // With one project the view settles on its count-based default (cards)
    // right after the list arrives; open the row menu only after that, or the
    // view change unmounts it.
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Cards" })).toHaveAttribute("aria-selected", "true"),
    );
    fireEvent.click(screen.getAllByRole("button", { name: `Actions for ${name}` })[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Delete project" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete project?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete project" }));
  }

  it("a delete that finishes after a switch shows no feedback under the new team", async () => {
    const { deleteProject } = await import("../../src/lib/api");
    const del = deferred<void>();
    vi.mocked(deleteProject).mockReturnValue(del.promise);
    renderBoth();
    await screen.findAllByText("Agent Tasks");

    await confirmDelete("Agent Tasks");
    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith("proj-1"));
    act(() => nav.push("/projects?teamId=t2"));
    await screen.findAllByText("Second Team Project");
    await act(async () => {
      del.resolve();
    });

    expect(screen.getByRole("heading", { name: "Team Two" })).toBeInTheDocument();
    expect(screen.queryByText("Project deleted")).not.toBeInTheDocument();
    expect(screen.queryByText(/Project "Agent Tasks" deleted/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Second Team Project").length).toBeGreaterThan(0);
  });

  it("a delete that fails after a switch shows no error under the new team", async () => {
    const { deleteProject } = await import("../../src/lib/api");
    const del = deferred<void>();
    vi.mocked(deleteProject).mockReturnValue(del.promise);
    renderBoth();
    await screen.findAllByText("Agent Tasks");

    await confirmDelete("Agent Tasks");
    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith("proj-1"));
    act(() => nav.push("/projects?teamId=t2"));
    await screen.findAllByText("Second Team Project");
    await act(async () => {
      del.reject(new Error("delete failed late"));
    });

    expect(screen.queryByText("Delete failed")).not.toBeInTheDocument();
    expect(screen.queryByText("delete failed late")).not.toBeInTheDocument();
  });

  it.each(["resolves", "rejects"] as const)(
    "a create that %s after a switch leaves the new team's dialog and list alone",
    async (outcome) => {
      const { createProject } = await import("../../src/lib/api");
      const create = deferred<Project>();
      vi.mocked(createProject).mockReturnValueOnce(create.promise);
      renderBoth();
      await screen.findAllByText("Agent Tasks");
      fireEvent.click(screen.getAllByRole("button", { name: /New Project/ })[0]!);
      fireEvent.change(screen.getByPlaceholderText("My Project"), { target: { value: "Late" } });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      await waitFor(() =>
        expect(createProject).toHaveBeenCalledWith(expect.objectContaining({ teamId: "t1" })),
      );

      act(() => nav.push("/projects?teamId=t2"));
      await screen.findAllByText("Second Team Project");
      // The user starts a project for the new team.
      fireEvent.click(screen.getAllByRole("button", { name: /New Project/ })[0]!);
      fireEvent.change(screen.getByPlaceholderText("My Project"), { target: { value: "Mine" } });
      await act(async () => {
        if (outcome === "resolves") create.resolve({ ...PROJECT, id: "proj-late", name: "Late" });
        else create.reject(new Error("create failed late"));
      });

      expect(screen.queryByText("create failed late")).not.toBeInTheDocument();
      expect(screen.queryByText("Late")).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText("My Project")).toHaveValue("Mine");
    },
  );

  it("a GitHub sync that fails after a switch shows no error under the new team", async () => {
    const { syncTeamFromGitHub } = await import("../../src/lib/api");
    const sync = deferred<Awaited<ReturnType<typeof syncTeamFromGitHub>>>();
    vi.mocked(syncTeamFromGitHub).mockReturnValue(sync.promise);
    mockGetCurrentUser.mockResolvedValue({ ...USER, githubConnected: true });
    renderBoth();
    await screen.findAllByText("Agent Tasks");

    fireEvent.click(screen.getByRole("button", { name: "Sync GitHub" }));
    await waitFor(() => expect(syncTeamFromGitHub).toHaveBeenCalledWith("t1"));
    pick("Team Two");
    await screen.findAllByText("Second Team Project");
    await act(async () => {
      sync.reject(new Error("sync failed late"));
    });

    expect(screen.queryByText("Sync failed")).not.toBeInTheDocument();
    expect(screen.queryByText("sync failed late")).not.toBeInTheDocument();
  });

  it("a failing project list shows an error for the current team instead of spinning forever", async () => {
    mockGetProjects.mockRejectedValue(new Error("projects down"));
    renderBoth();

    expect(await screen.findByText("projects down")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Team One" })).toBeInTheDocument();
    // The list counts as loaded (empty), so the page shows its empty state
    // instead of the loading skeleton.
    expect(await screen.findByText("No projects yet.")).toBeInTheDocument();
  });
});
