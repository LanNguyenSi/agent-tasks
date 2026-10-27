/** @vitest-environment jsdom */
/**
 * /tasks page -- keyboard focus when a row action drops its row
 * (row-action focus recovery, src/app/tasks/page.tsx + the row menu in
 * _components/columns.tsx).
 *
 * The row menu returns focus to its trigger when an item runs. When the
 * refreshed list drops the actioned row (Promote while the Backlog chip
 * filters, Move to backlog under the Open chip, Discard through the confirm
 * dialog), that trigger unmounts, so the page hands focus over instead of
 * letting it fall to the document body:
 *   - row gone, rows left      -> the next row's trigger (the one occupying
 *                                 the removed row's slot), or the previous
 *                                 row's trigger when it was the last row;
 *   - row gone, table now empty -> the results region (.tasks-table-region);
 *   - row still in the refreshed list -> focus stays on its own trigger;
 *   - focus moved elsewhere before the refresh lands -> stays where it is.
 * The hand-off runs from an effect after the commit that removed the row,
 * never from a timer scheduled next to setLoaded: a real browser fires such
 * a timer before React commits, while the actioned trigger is still mounted
 * and focused, and the "focus on the body" guard would then give up forever
 * (the "browser ordering" test pins exactly that window). A pending recovery
 * is consumed only by the action's own refresh (the fetch running under the
 * retryToken it bumped; a filter change must not consume it) and is dropped
 * when the action fails.
 * The fake API drops the row from every list response after its PATCH, which
 * is what a filtered refresh does in the app.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Task, User, Team, TeamTasksProject } from "../../src/lib/api";

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
  getTeamTasks: vi.fn(),
  updateTask: vi.fn(),
}));

// The create flow is only a retryToken bump away (onTaskCreated); capture
// its props so a test can start a refresh the way a create would, without
// mounting the flow.
const createFlow = vi.hoisted(() => ({ onTaskCreated: null as null | (() => void) }));
vi.mock("../../src/components/tasks/NewTaskFlow", () => ({
  default: (props: { onTaskCreated?: () => void }) => {
    createFlow.onTaskCreated = props.onTaskCreated ?? null;
    return null;
  },
}));

import TasksPageRaw from "../../src/app/tasks/page";
import { DEMOTE_LABEL } from "../../src/lib/backlogDemote";
import { withTeamList } from "./helpers/withTeamList";
const TasksPage = withTeamList(TasksPageRaw);
import { nav } from "../setup/fakeNavigation";
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

/** Let any queued fetch commit and its effect run. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
}

beforeEach(() => {
  vi.clearAllMocks();
  nav.reset("/tasks?status=backlog");
  createFlow.onTaskCreated = null;
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
    await screen.findByRole("button", { name: "Actions for Row A" });
    // The initial load focuses nothing: recovery only ever acts after an action.
    expect(document.activeElement).toBe(document.body);

    await runRowAction("Row A", "Promote");

    // The action completed and the list refreshed (the row is still there,
    // now open), and focus never left the row's own trigger.
    await waitFor(() => expect(mockUpdateTask).toHaveBeenCalledWith("t-a", { status: "open" }));
    expect(mockGetTeamTasks.mock.calls.length).toBeGreaterThanOrEqual(2);
    await settle();
    expect(trigger("Row A")).toHaveFocus();
  });

  it("runs the recovery from the post-commit effect, not from a fetch-scheduled timer (browser ordering)", async () => {
    const a = makeTask({ id: "t-a", title: "Row A" });
    const b = makeTask({ id: "t-b", title: "Row B" });
    let resolveList!: (value: never) => void;
    mockGetTeamTasks
      .mockResolvedValueOnce(listResponse([a, b]))
      .mockImplementationOnce(() => new Promise<never>((r) => (resolveList = r)));
    mockUpdateTask.mockResolvedValue({ ...a, status: "open" });

    render(<TasksPage />);
    await runRowAction("Row A", "Promote");
    await waitFor(() => expect(mockGetTeamTasks).toHaveBeenCalledTimes(2));
    expect(trigger("Row A")).toHaveFocus();

    // A real browser fires a setTimeout(0) scheduled next to setLoaded
    // before React commits the new list. Recreate that window: capture
    // every timer the refresh callback starts instead of scheduling it,
    // resolve the refreshed list, let the fetch callback run without
    // letting the commit be delivered, and fire the timers there. The
    // actioned trigger is still mounted and focused in that window, so a
    // timer-based recovery gives up on its "focus on the body" guard and
    // leaves focus on the body once the commit lands.
    const timers: Array<() => void> = [];
    const spy = vi.spyOn(window, "setTimeout").mockImplementation(((fn: () => void) => {
      timers.push(fn);
      return 0;
    }) as unknown as typeof window.setTimeout);
    try {
      await act(async () => {
        resolveList(listResponse([b]) as never);
        // The fetch continuation (setLoaded + anything it schedules) runs on
        // these microtask turns; the commit goes through the task queue,
        // which this synchronous stretch does not yield to.
        await Promise.resolve();
        await Promise.resolve();
        expect(trigger("Row A")).toBeInTheDocument();
        expect(document.activeElement).toBe(trigger("Row A"));
        for (const fn of timers) fn();
      });
    } finally {
      spy.mockRestore();
    }

    // The commit ran at the end of the act: the row is gone, and the effect
    // moved focus to the next row's trigger.
    await waitFor(() => expect(trigger("Row B")).toHaveFocus());
  });

  it("leaves focus where the user moved it before the refreshed list lands", async () => {
    const a = makeTask({ id: "t-a", title: "Row A" });
    const b = makeTask({ id: "t-b", title: "Row B" });
    let resolveList!: (value: never) => void;
    mockGetTeamTasks
      .mockResolvedValueOnce(listResponse([a, b]))
      .mockImplementationOnce(() => new Promise<never>((r) => (resolveList = r)));
    mockUpdateTask.mockResolvedValue({ ...a, status: "open" });

    render(<TasksPage />);
    await runRowAction("Row A", "Promote");
    await waitFor(() => expect(mockGetTeamTasks).toHaveBeenCalledTimes(2));

    // The user tabs to the search field while the refresh is in flight.
    const search = document.querySelector(".db-search-input") as HTMLElement;
    search.focus();
    await act(async () => {
      resolveList(listResponse([b]) as never);
      await Promise.resolve();
    });
    await settle();

    expect(search).toHaveFocus();
    expect(trigger("Row B")).not.toHaveFocus();
  });

  it("recovers focus after Move to backlog drops the row (Open view)", async () => {
    nav.reset("/tasks?status=open");
    const a = makeTask({ id: "t-a", title: "Row A", status: "open" });
    const b = makeTask({ id: "t-b", title: "Row B", status: "open" });
    mockGetTeamTasks
      .mockResolvedValueOnce(listResponse([a, b]))
      .mockResolvedValue(listResponse([a]));
    mockUpdateTask.mockResolvedValue({ ...b, status: "backlog" });

    render(<TasksPage />);
    await runRowAction("Row B", DEMOTE_LABEL);

    await waitFor(() => expect(mockUpdateTask).toHaveBeenCalledWith("t-b", { status: "backlog" }));
    // The demoted row was the last one: focus goes to the previous trigger.
    await waitFor(() => expect(trigger("Row A")).toHaveFocus());
  });

  it("recovers focus after Discard through the confirm dialog drops the row", async () => {
    const a = makeTask({ id: "t-a", title: "Row A" });
    const b = makeTask({ id: "t-b", title: "Row B" });
    mockGetTeamTasks
      .mockResolvedValueOnce(listResponse([a, b]))
      .mockResolvedValue(listResponse([b]));
    mockUpdateTask.mockResolvedValue({ ...a, status: "abandoned" });

    render(<TasksPage />);
    await runRowAction("Row A", "Discard");
    await userEvent.click(await screen.findByRole("button", { name: "Discard task" }));

    await waitFor(() => expect(mockUpdateTask).toHaveBeenCalledWith("t-a", { status: "abandoned" }));
    await waitFor(() => expect(trigger("Row B")).toHaveFocus());
  });

  it("a filter-change fetch that completes first does not consume the recovery", async () => {
    const a = makeTask({ id: "t-a", title: "Row A" });
    const b = makeTask({ id: "t-b", title: "Row B" });
    let resolvePatch!: (value: never) => void;
    mockGetTeamTasks
      .mockResolvedValueOnce(listResponse([a, b])) // initial load
      .mockResolvedValueOnce(listResponse([a, b])) // the filter-change fetch: Row A still there
      .mockResolvedValue(listResponse([b]));       // the action's own refresh: Row A gone
    mockUpdateTask.mockImplementation(() => new Promise<never>((r) => (resolvePatch = r)));

    render(<TasksPage />);
    await runRowAction("Row A", "Promote");
    await waitFor(() => expect(mockUpdateTask).toHaveBeenCalled());

    // A priority chip is toggled while the PATCH is in flight; its fetch
    // completes first but ran under the retryToken the action has not
    // bumped, so it is not the action's refresh and must leave the pending
    // recovery alone.
    await act(async () => {
      nav.replace("/tasks?status=backlog&priority=HIGH");
    });
    await waitFor(() => expect(mockGetTeamTasks).toHaveBeenCalledTimes(2));
    expect(trigger("Row A")).toHaveFocus();

    await act(async () => {
      resolvePatch({ ...a, status: "open" } as never);
    });
    await waitFor(() => expect(mockGetTeamTasks).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(trigger("Row B")).toHaveFocus());
  });

  // A failed action never drops its row, so it must leave no pending
  // recovery behind: a later refresh running under the token the failed
  // action bumped (here the create flow's onTaskCreated bump) must not hand
  // focus to the row that took the failed action's slot.
  async function failedActionLeavesNoRecovery(
    url: string,
    rows: () => Task[],
    action: () => Promise<void>,
  ): Promise<void> {
    nav.reset(url);
    mockGetTeamTasks
      .mockResolvedValueOnce(listResponse(rows()))
      .mockResolvedValue(listResponse(rows().slice(1)));
    mockUpdateTask.mockRejectedValue(new Error("Backend says no"));
    render(<TasksPage />);
    await screen.findByRole("button", { name: "Actions for Row A" });

    await action();

    expect(await screen.findByText("Action failed")).toBeInTheDocument();
    // Focus moves off the page, then a token-matching refresh drops Row A.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    act(() => createFlow.onTaskCreated?.());
    await waitFor(() => expect(mockGetTeamTasks).toHaveBeenCalledTimes(2));
    await settle();
    expect(screen.queryByRole("button", { name: "Actions for Row A" })).toBeNull();
    expect(document.activeElement).toBe(document.body);
  }

  it("a failed Promote leaves no pending recovery behind", async () => {
    await failedActionLeavesNoRecovery("/tasks?status=backlog", defaultRows, () =>
      runRowAction("Row A", "Promote"),
    );
  });

  it("a failed Move to backlog leaves no pending recovery behind", async () => {
    await failedActionLeavesNoRecovery(
      "/tasks?status=open",
      () => defaultRows("open"),
      () => runRowAction("Row A", DEMOTE_LABEL),
    );
  });

  it("a failed Discard leaves no pending recovery behind", async () => {
    await failedActionLeavesNoRecovery("/tasks?status=backlog", defaultRows, async () => {
      await runRowAction("Row A", "Discard");
      await userEvent.click(await screen.findByRole("button", { name: "Discard task" }));
    });
  });
});

function defaultRows(status: Task["status"] = "backlog"): Task[] {
  return [
    makeTask({ id: "t-a", title: "Row A", status }),
    makeTask({ id: "t-b", title: "Row B", status }),
  ];
}
