/** @vitest-environment jsdom */
/**
 * /tasks page -- the custom-filter state (src/app/tasks/page.tsx).
 *
 * The view is a custom filter when the effective status/priority chips or
 * the mine flag differ from the active scope tab's preset (SCOPE_PRESETS).
 * Then: no scope tab is selected, the H1 reads "Tasks · custom filter", and
 * the tab row offers "Reset", which goes back to the ACTIVE tab's preset.
 * The state is derived from the URL, so it round-trips (a reload or a shared
 * link shows the same state); an explicit chip set equal to the preset is
 * NOT custom (that is the tab itself, written shortly after a chip toggle).
 *
 * Also pinned here: the separate header "Mine" toggle is gone (the My Tasks
 * tab is its replacement), while the `mine` URL parameter keeps working
 * (bookmarks, the Home "My Tasks" link) as one of the custom-filter inputs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
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

vi.mock("../../src/components/tasks/NewTaskFlow", () => ({ default: () => null }));

import TasksPage from "../../src/app/tasks/page";
import { getCurrentUser, getTeams, getTeamTasks } from "../../src/lib/api";

const USER: User = { id: "u-1", login: "lan" } as User;
const TEAM: Team = { id: "team-1", name: "Pandora", slug: "pandora", role: "ADMIN", createdAt: "2026-01-01T00:00:00Z" };
const PROJECT: TeamTasksProject = { id: "proj-1", name: "Agent Tasks", slug: "agent-tasks", accessSource: "team" };

const TASK = {
  id: "task-1",
  projectId: "proj-1",
  title: "A task",
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

function listResponse() {
  return {
    tasks: [TASK],
    projects: [PROJECT],
    counts: { open: 1, review: 0, done: 0, priority: 0, mine: 0, total: 1 },
    filteredTotal: 1,
  };
}

async function renderAt(search: string) {
  nav.search = search;
  render(<TasksPage />);
  await screen.findByRole("heading", { level: 1 });
}

/** The URL of the most recent router.replace (the page writes ?teamId= in
once the current team resolves, so the asserted action is never calls[0]). */
function lastReplace(): URLSearchParams {
  const calls = routerMocks.replace.mock.calls;
  const href = String(calls[calls.length - 1]![0]);
  return new URLSearchParams(href.split("?")[1] ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  nav.search = "";
  vi.mocked(getCurrentUser).mockResolvedValue(USER);
  vi.mocked(getTeams).mockResolvedValue([TEAM]);
  vi.mocked(getTeamTasks).mockResolvedValue(listResponse() as never);
});
afterEach(cleanup);

describe("/tasks custom-filter detection", () => {
  it.each([
    ["no parameters (All preset)", "", "All Tasks"],
    ["the Active preset with no overrides", "scope=open", "Active Tasks"],
    ["chips written explicitly but equal to the Active preset", "scope=open&status=open,in_progress", "Active Tasks"],
    ["the same chips in the other order", "scope=open&status=in_progress,open", "Active Tasks"],
    ["the My Tasks preset with no overrides", "scope=mine", "My Tasks"],
    ["the Priority preset with no overrides", "scope=priority", "Priority (High / Critical)"],
  ])("%s is the tab itself, not a custom filter", async (_label, search, heading) => {
    await renderAt(search);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(heading);
    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
    const selected = screen
      .getAllByRole("tab")
      .filter((t) => t.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
  });

  it.each([
    ["one status chip off the Active preset", "scope=open&status=open"],
    ["statuses the Active preset does not cover", "scope=open&status=backlog"],
    ["the cleared sentinel on a preset-backed tab", "scope=open&status=__any__"],
    ["a priority chip off the Active preset", "scope=open&priority=HIGH"],
    ["mine forced on over the All preset", "scope=all&mine=1"],
    ["mine forced off on the My Tasks tab", "scope=mine&mine=0"],
    ["a chip on the otherwise-clean All tab", "status=backlog"],
    ["a chip set equal to another tab's preset (still custom for All)", "status=open,in_progress"],
  ])("%s is a custom filter", async (_label, search) => {
    await renderAt(search);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Tasks · custom filter");
    expect(
      screen.getAllByRole("tab").every((t) => t.getAttribute("aria-selected") === "false"),
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
  });

  it("a project filter or a search alone is not a custom filter", async () => {
    await renderAt("projectId=proj-1&q=hello");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("All Tasks");
    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
  });

  it("the custom state survives a reload of the same URL (round-trip)", async () => {
    await renderAt("scope=open&status=open");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Tasks · custom filter");
    cleanup();
    await renderAt("scope=open&status=open");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Tasks · custom filter");
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
  });

  it("the tablist stays keyboard-reachable while no tab is selected", async () => {
    await renderAt("scope=open&status=open");
    const tabs = screen.getAllByRole("tab");
    expect(tabs.some((t) => t.getAttribute("tabindex") === "0")).toBe(true);
    expect(tabs.every((t) => t.getAttribute("aria-selected") === "false")).toBe(true);
  });
});

describe("/tasks custom-filter Reset", () => {
  it("keeps the active scope tab and drops only the custom overrides", async () => {
    await renderAt("scope=mine&status=backlog&priority=LOW&mine=1&projectId=proj-1");
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    const q = lastReplace();
    // Target: the active tab's preset (scope=mine stays; mine=1 is the
    // preset value again, so it is dropped from the URL too).
    expect(q.get("scope")).toBe("mine");
    expect(q.has("status")).toBe(false);
    expect(q.has("priority")).toBe(false);
    expect(q.has("mine")).toBe(false);
    // Untouched non-custom filters.
    expect(q.get("projectId")).toBe("proj-1");
  });

  it("keeps the scope and teamId parameters", async () => {
    await renderAt("scope=open&status=open&teamId=team-1&page=2");
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    const q = lastReplace();
    expect(q.get("scope")).toBe("open");
    expect(q.get("teamId")).toBe("team-1");
    expect(q.has("status")).toBe(false);
    // A filter change resets pagination.
    expect(q.has("page")).toBe(false);
  });

  it("Reset on the All tab (no scope parameter) stays on the All tab", async () => {
    await renderAt("status=backlog");
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    const q = lastReplace();
    expect(q.has("scope")).toBe(false);
    expect(q.has("status")).toBe(false);
  });

  it("picking another tab from the custom state leaves that state for the new tab's preset", async () => {
    await renderAt("scope=open&status=open");
    await userEvent.click(screen.getByRole("tab", { name: "Recently Done" }));
    const q = lastReplace();
    expect(q.get("scope")).toBe("done");
    expect(q.has("status")).toBe(false);
  });
});

describe("/tasks Mine toggle removed in favour of the My Tasks tab", () => {
  it("the header has no Mine toggle", async () => {
    await renderAt("");
    expect(screen.queryByRole("button", { name: "Mine" })).not.toBeInTheDocument();
  });

  it("the My Tasks tab links scope=mine and that scope fetches mine=true", async () => {
    await renderAt("");
    await userEvent.click(screen.getByRole("tab", { name: "My Tasks" }));
    const q = lastReplace();
    expect(q.get("scope")).toBe("mine");
  });

  it.each([
    ["absent on the All tab", "", undefined],
    ["absent on the My Tasks tab (preset mine)", "scope=mine", true],
    ["mine=1 on the All tab (old bookmark)", "mine=1", true],
    ["mine=0 on the My Tasks tab", "scope=mine&mine=0", undefined],
  ])("the fetch mine parameter for %s is %s", async (_label, search, expected) => {
    await renderAt(search);
    await waitFor(() => expect(getTeamTasks).toHaveBeenCalled());
    expect(mockFetchArgs().mine).toBe(expected);
  });
});

function mockFetchArgs(): Record<string, unknown> {
  const calls = vi.mocked(getTeamTasks).mock.calls;
  return calls[calls.length - 1]![1] as unknown as Record<string, unknown>;
}
