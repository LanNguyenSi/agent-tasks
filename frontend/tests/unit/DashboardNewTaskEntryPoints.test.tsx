/** @vitest-environment jsdom */
/**
 * Project board page (app/projects/[id]/board, formerly /dashboard) --
 * bootstrap and generic "New Task" entry points.
 *
 * Bootstrap contract: the project comes from the route param, not from a
 * team, so a user without any team still gets the board (no /onboarding
 * redirect); `?taskId=` opens that task's modal; the board records itself
 * as the last board for the legacy /dashboard redirect; the 15 s task poll
 * stops on unmount.
 *
 * Entry-point contract (2026-08-20 operator decision, supersedes D19):
 *   - the toolbar "+ New Task" button opens NewTaskModal with Backlog
 *     preselected;
 *   - the "C" keyboard shortcut does the same;
 *   - both route through the single shared DEFAULT_CREATE_STATUS constant
 *     (lib/status.ts), not a hardcoded "open".
 *
 * Full-page render (src/lib/api mocked wholesale via vi.mock, matching the
 * pattern in SettingsPage.tokenRename.test.tsx / NewTaskFlow.test.tsx):
 * the toolbar button and the "C" shortcut both live inline in
 * the board page and drive its own `newTaskInitialStatus` state, so a
 * component-level test can't observe the actual wiring.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiRequestError, type User, type Team, type Project, type Task } from "../../src/lib/api";

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
import DashboardRedirectPage from "../../src/app/dashboard/page";
import { ToastProvider } from "../../src/components/ui/Toast";
import {
  getCurrentUser,
  getTeams,
  getProject,
  getTasks,
  getTask,
  getEffectiveWorkflow,
} from "../../src/lib/api";

const mockGetCurrentUser = vi.mocked(getCurrentUser);
const mockGetTeams = vi.mocked(getTeams);
const mockGetProject = vi.mocked(getProject);
const mockGetTasks = vi.mocked(getTasks);
const mockGetTask = vi.mocked(getTask);
const mockGetEffectiveWorkflow = vi.mocked(getEffectiveWorkflow);

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

const TEAM: Team = {
  id: "t-1",
  name: "Team Alpha",
  slug: "team-alpha",
  role: "ADMIN",
  createdAt: new Date(0).toISOString(),
};

const PROJECT: Project = {
  id: "p-1",
  teamId: "t-1",
  name: "Project One",
  slug: "project-one",
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
  createdAt: new Date(0).toISOString(),
  accessRole: "ADMIN",
};

function renderBoard() {
  return render(
    <ToastProvider>
      <ProjectBoardPage />
    </ToastProvider>,
  );
}

async function renderDashboardReady() {
  renderBoard();
  // Wait for bootstrap to finish and the toolbar's "+ New Task" button to
  // become enabled (gated on a selected project).
  await waitFor(() => expect(screen.getByRole("button", { name: /new task/i })).toBeEnabled());
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(USER);
  mockGetTeams.mockResolvedValue([TEAM]);
  mockGetProject.mockResolvedValue(PROJECT);
  // One task, so the board shows its columns: a project with no tasks shows
  // the first-run empty state instead.
  mockGetTasks.mockResolvedValue([TASK]);
  window.localStorage.clear();
  window.history.replaceState({}, "", "/projects/p-1/board");
  // jsdom does not implement scrollIntoView; the Select listbox calls it.
  Element.prototype.scrollIntoView = vi.fn();
});

describe("dashboard New Task entry points default to Backlog", () => {
  it("toolbar '+ New Task' opens the modal with Backlog preselected", async () => {
    await renderDashboardReady();
    await userEvent.click(screen.getByRole("button", { name: /new task/i }));

    const statusCombobox = await screen.findByRole("combobox", { name: "Status" });
    expect(statusCombobox).toHaveTextContent("Backlog");
  });

  it("the 'C' keyboard shortcut opens the modal with Backlog preselected", async () => {
    await renderDashboardReady();
    await userEvent.keyboard("c");

    const statusCombobox = await screen.findByRole("combobox", { name: "Status" });
    expect(statusCombobox).toHaveTextContent("Backlog");
  });
});

describe("dashboard board column + buttons preselect their own column (column gating, operator decision 2026-08-20)", () => {
  it("the Backlog column's + opens the modal with Backlog preselected", async () => {
    await renderDashboardReady();
    await userEvent.click(await screen.findByRole("button", { name: "Add task to Backlog" }));

    const statusCombobox = await screen.findByRole("combobox", { name: "Status" });
    expect(statusCombobox).toHaveTextContent("Backlog");
  });

  it("the Open column's + opens the modal with Open preselected", async () => {
    await renderDashboardReady();
    await userEvent.click(await screen.findByRole("button", { name: "Add task to Open" }));

    const statusCombobox = await screen.findByRole("combobox", { name: "Status" });
    expect(statusCombobox).toHaveTextContent("Open");
  });

  it("does not render a + button on In Progress, Review, or Done columns", async () => {
    await renderDashboardReady();
    const board = await screen.findByLabelText("Board");
    expect(within(board).queryByRole("button", { name: "Add task to In Progress" })).not.toBeInTheDocument();
    expect(within(board).queryByRole("button", { name: "Add task to Review" })).not.toBeInTheDocument();
    expect(within(board).queryByRole("button", { name: "Add task to Done" })).not.toBeInTheDocument();
  });
});

const TASK: Task = {
  id: "k-1",
  projectId: "p-1",
  title: "Deep-linked task",
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
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  attachments: [],
  artifacts: [],
  comments: [],
  blockedBy: [],
  blocks: [],
};

describe("board bootstrap from the route's project", () => {
  it("renders for a user with no team and does not redirect to /onboarding", async () => {
    mockGetTeams.mockResolvedValue([]);
    await renderDashboardReady();

    expect(mockGetProject).toHaveBeenCalledWith("p-1");
    expect(mockGetTasks).toHaveBeenCalledWith("p-1");
    expect(routerMocks.replace).not.toHaveBeenCalled();
    // No team to name, so no team crumb; the project name is the hub band's.
    expect(screen.queryByText("Team Alpha")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
  });

  it("renders no title, team crumb or project switch of its own: the hub band owns them", async () => {
    await renderDashboardReady();

    expect(screen.queryByText("Team Alpha")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
    expect(screen.queryByText("Project One")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /switch project/i })).not.toBeInTheDocument();
  });

  it("sends an unauthenticated visitor to /auth", async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    renderBoard();

    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/auth"));
    expect(mockGetProject).not.toHaveBeenCalled();
  });

  it("does not look up teams (the crumb is the hub band's), so a failing lookup cannot matter", async () => {
    mockGetTeams.mockRejectedValue(new Error("teams down"));
    await renderDashboardReady();

    expect(mockGetTeams).not.toHaveBeenCalled();
    expect(screen.queryByText("Team Alpha")).not.toBeInTheDocument();
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(screen.queryByText("Could not load tasks")).not.toBeInTheDocument();
  });

  it("sends a user whose project is gone (404) to the Projects page and forgets it", async () => {
    window.localStorage.setItem("dashboard:lastProject:t-1", "p-1");
    window.localStorage.setItem("dashboard:lastProject:t-2", "p-1");
    window.localStorage.setItem("dashboard:lastProject:t-3", "p-other");
    // Same value under a key that is not a last-board entry: left alone.
    window.localStorage.setItem("agent-tasks:lastTeamId", "p-1");
    mockGetProject.mockRejectedValue(new ApiRequestError("not_found", "Not found", 404));
    renderBoard();

    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/projects"));
    expect(routerMocks.replace).toHaveBeenCalledTimes(1);
    expect(mockGetTasks).not.toHaveBeenCalled();
    expect(screen.queryByText("Could not load tasks")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("dashboard:lastProject:t-1")).toBeNull();
    expect(window.localStorage.getItem("dashboard:lastProject:t-2")).toBeNull();
    expect(window.localStorage.getItem("dashboard:lastProject:t-3")).toBe("p-other");
    expect(window.localStorage.getItem("agent-tasks:lastTeamId")).toBe("p-1");
  });

  it("sends a user without access (403) to the Projects page and forgets the project", async () => {
    window.localStorage.setItem("dashboard:lastProject:t-1", "p-1");
    mockGetProject.mockRejectedValue(new ApiRequestError("forbidden", "Access denied", 403));
    renderBoard();

    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/projects"));
    expect(mockGetTasks).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("dashboard:lastProject:t-1")).toBeNull();
  });

  it("shows the boot error with Retry, no redirect and the stored board kept, on a server error", async () => {
    window.localStorage.setItem("dashboard:lastProject:t-1", "p-1");
    mockGetProject.mockRejectedValue(new ApiRequestError("internal", "Server exploded", 500));
    renderBoard();

    expect(await screen.findByText("Could not load tasks")).toBeInTheDocument();
    expect(screen.getByText("Server exploded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("dashboard:lastProject:t-1")).toBe("p-1");
  });

  it("shows the boot error, no redirect, on a network failure", async () => {
    mockGetProject.mockRejectedValue(new TypeError("Failed to fetch"));
    renderBoard();

    expect(await screen.findByText("Could not load tasks")).toBeInTheDocument();
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });

  it("opens the task modal for ?taskId= when the task is in the project", async () => {
    mockGetTasks.mockResolvedValue([TASK]);
    mockGetTask.mockResolvedValue(TASK);
    window.history.replaceState({}, "", "/projects/p-1/board?taskId=k-1");
    renderBoard();

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(mockGetTask).toHaveBeenCalledWith("k-1");
    expect(window.location.search).toBe("?taskId=k-1");
  });

  it("ignores a ?taskId= that is not in the project", async () => {
    mockGetTasks.mockResolvedValue([TASK]);
    window.history.replaceState({}, "", "/projects/p-1/board?taskId=other");
    await renderDashboardReady();

    expect(mockGetTask).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("records itself as the team's last board, which a bare /dashboard resumes", async () => {
    await renderDashboardReady();
    expect(window.localStorage.getItem("dashboard:lastProject:t-1")).toBe("p-1");

    window.history.replaceState({}, "", "/dashboard");
    render(<DashboardRedirectPage />);
    await waitFor(() =>
      expect(routerMocks.replace).toHaveBeenCalledWith("/projects/p-1/board"),
    );
  });
});

describe("task modal and the URL", () => {
  // The router mock does not touch the address bar; make replace do what the
  // real router does so the effect's own reads of window.location see it.
  beforeEach(() => {
    routerMocks.replace.mockImplementation((url: string) => {
      window.history.replaceState({}, "", url);
    });
    mockGetTasks.mockResolvedValue([TASK]);
    mockGetTask.mockResolvedValue(TASK);
  });

  async function openCard() {
    await userEvent.click(await screen.findByRole("button", { name: /Deep-linked task/ }));
    await screen.findByRole("dialog");
  }

  it("adds ?taskId=<id> when a card opens, with router.replace", async () => {
    await renderDashboardReady();
    await openCard();
    await waitFor(() =>
      expect(routerMocks.replace).toHaveBeenCalledWith("/projects/p-1/board?taskId=k-1", {
        scroll: false,
      }),
    );
    expect(routerMocks.push).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?taskId=k-1");
  });

  it("removes taskId when the modal closes and keeps other query parameters and the hash", async () => {
    window.history.replaceState({}, "", "/projects/p-1/board?view=x#db-col-open");
    await renderDashboardReady();
    await openCard();
    await waitFor(() => expect(window.location.search).toBe("?view=x&taskId=k-1"));
    expect(window.location.hash).toBe("#db-col-open");

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(window.location.search).toBe("?view=x"));
    expect(window.location.hash).toBe("#db-col-open");
  });

  it("arriving with ?taskId= and closing leaves no taskId, and a reload does not reopen the modal", async () => {
    window.history.replaceState({}, "", "/projects/p-1/board?taskId=k-1");
    const first = renderBoard();
    await screen.findByRole("dialog");
    expect(routerMocks.replace).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(window.location.pathname).toBe("/projects/p-1/board");

    first.unmount();
    mockGetTask.mockClear();
    await renderDashboardReady();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockGetTask).not.toHaveBeenCalled();
  });

  describe("a boot that does not succeed leaves its own navigation alone", () => {
    // With ?taskId= still in the address bar and no task open, the URL sync
    // would replace the URL with the bare board path and win over the boot's
    // redirect. It must not run after a redirect or a boot error. The real
    // router changes the address bar after the call returns, so these cases
    // leave the URL as it was (the mock above would rewrite it at once and
    // hide the race).
    beforeEach(() => {
      routerMocks.replace.mockImplementation(() => {});
    });

    async function settled() {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
    }

    it("signed out with ?taskId=: the only navigation is /auth", async () => {
      window.history.replaceState({}, "", "/projects/p-1/board?taskId=k-1");
      mockGetCurrentUser.mockResolvedValue(null);
      renderBoard();
      await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/auth"));
      await settled();
      expect(routerMocks.replace.mock.calls).toEqual([["/auth"]]);
      expect(routerMocks.replace.mock.lastCall?.[0]).toBe("/auth");
    });

    it.each([
      ["a missing project (404)", new ApiRequestError("not_found", "Not found", 404)],
      ["a project without access (403)", new ApiRequestError("forbidden", "Access denied", 403)],
    ])("%s with ?taskId=: the only navigation is the Projects page", async (_label, err) => {
      window.history.replaceState({}, "", "/projects/p-1/board?taskId=k-1");
      mockGetProject.mockRejectedValue(err);
      renderBoard();
      await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/projects"));
      await settled();
      expect(routerMocks.replace.mock.calls).toEqual([["/projects"]]);
    });

    it("a boot error with ?taskId=: no navigation at all, the URL is kept", async () => {
      window.history.replaceState({}, "", "/projects/p-1/board?taskId=k-1");
      mockGetProject.mockRejectedValue(new ApiRequestError("internal", "Server exploded", 500));
      renderBoard();
      expect(await screen.findByText("Could not load tasks")).toBeInTheDocument();
      await settled();
      expect(routerMocks.replace).not.toHaveBeenCalled();
      expect(window.location.search).toBe("?taskId=k-1");
    });
  });

  it("drops a ?taskId= that is not in the project from the URL", async () => {
    window.history.replaceState({}, "", "/projects/p-1/board?taskId=other");
    await renderDashboardReady();
    await waitFor(() => expect(window.location.search).toBe(""));
  });
});

describe("board task poll", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refetches tasks every 15 s and stops when the board unmounts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = renderBoard();
    await waitFor(() => expect(screen.getByRole("button", { name: /new task/i })).toBeEnabled());
    expect(mockGetTasks).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mockGetTasks).toHaveBeenCalledTimes(2);

    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    expect(mockGetTasks).toHaveBeenCalledTimes(2);
  });
});

describe("board admin workflow edges", () => {
  async function settle() {
    await act(async () => {
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    mockGetEffectiveWorkflow.mockResolvedValue({
      definition: { transitions: [] },
    } as unknown as Awaited<ReturnType<typeof getEffectiveWorkflow>>);
  });

  it.each(["ADMIN", "PROJECT_ADMIN"])("loads the effective workflow for a %s", async (role) => {
    mockGetProject.mockResolvedValue({ ...PROJECT, accessRole: role });
    await renderDashboardReady();
    await settle();

    expect(mockGetEffectiveWorkflow).toHaveBeenCalledWith("p-1");
  });

  it.each(["HUMAN_MEMBER", "REVIEWER", "PROJECT_CONTRIBUTOR", "PROJECT_VIEWER", undefined])(
    "does not load the effective workflow for role %s",
    async (role) => {
      mockGetProject.mockResolvedValue({ ...PROJECT, accessRole: role });
      await renderDashboardReady();
      await settle();

      expect(mockGetEffectiveWorkflow).not.toHaveBeenCalled();
    },
  );

  // The board threads the project's accessRole into TaskDetail as
  // isProjectAdmin; the modal's status-override control is the visible
  // result (TaskDetail.variant.test.tsx covers the component side).
  describe("task modal admin override", () => {
    async function openModal(role: string) {
      mockGetEffectiveWorkflow.mockResolvedValue({
        definition: { transitions: [{ from: "open", to: "in_progress" }] },
      } as unknown as Awaited<ReturnType<typeof getEffectiveWorkflow>>);
      mockGetProject.mockResolvedValue({ ...PROJECT, accessRole: role });
      mockGetTasks.mockResolvedValue([TASK]);
      mockGetTask.mockResolvedValue(TASK);
      window.history.replaceState({}, "", "/projects/p-1/board?taskId=k-1");
      renderBoard();
      await screen.findByRole("dialog");
    }

    it.each(["ADMIN", "PROJECT_ADMIN"])("offers the status-override control in the menu to a %s", async (role) => {
      await openModal(role);
      await userEvent.click(await screen.findByRole("button", { name: "More actions" }));
      await userEvent.click(await screen.findByRole("button", { name: "Change status…" }));
      expect(
        await screen.findByRole("combobox", { name: "Change task status (admin override)" }),
      ).toBeInTheDocument();
    });

    it.each(["HUMAN_MEMBER", "PROJECT_CONTRIBUTOR", "PROJECT_VIEWER"])(
      "does not show the status-override control to a %s",
      async (role) => {
        await openModal(role);
        await userEvent.click(await screen.findByRole("button", { name: "More actions" }));
        expect(
          await screen.findByRole("button", { name: /Change status \(admins only\)/ }),
        ).toBeDisabled();
        expect(
          screen.queryByRole("combobox", { name: "Change task status (admin override)" }),
        ).toBeNull();
      },
    );
  });
});
