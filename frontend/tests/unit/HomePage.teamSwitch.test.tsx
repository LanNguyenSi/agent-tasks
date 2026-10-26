/** @vitest-environment jsdom */
/**
 * /home follows the current team of the URL, the same team the header
 * switcher shows. The page and AppHeader are rendered together on one
 * in-memory history (tests/setup/fakeNavigation.ts): a header pick pushes a
 * URL, `nav.back()` / `nav.forward()` stand in for the browser buttons. The
 * page reloads the tasks of the resolved team, shows its name, drops the old
 * team's tasks while loading, and ignores a response of a team that is no
 * longer current. Mock pattern mirrors HomePage.scopeOrder.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent, waitFor } from "@testing-library/react";
import type { User, Team, Task, TeamTasksProject } from "../../src/lib/api";

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
  logout: vi.fn(),
}));

import HomeDashboardPage from "../../src/app/home/page";
import AppHeader from "../../src/components/AppHeader";
import { nav } from "../setup/fakeNavigation";
import { getCurrentUser, getTeams, getTeamTasks } from "../../src/lib/api";

const TEAMS = [
  { id: "team-1", name: "Alpha Team", slug: "alpha", role: "ADMIN", createdAt: "2026-01-01T00:00:00Z" },
  { id: "team-2", name: "Beta Team", slug: "beta", role: "MEMBER", createdAt: "2026-01-01T00:00:00Z" },
] as Team[];

function task(id: string, title: string): Task {
  return {
    id, projectId: "proj-1", title, description: null, status: "open", priority: "MEDIUM",
    templateData: null, claimedByUserId: null, claimedByAgentId: null, claimedAt: null, dueAt: null,
    branchName: null, prUrl: null, prNumber: null, result: null, externalRef: null, labels: [],
    createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", attachments: [],
  } as Task;
}

const PROJECT = { id: "proj-1", name: "Proj", slug: "proj", accessSource: "team" } as TeamTasksProject;
const COUNTS = { open: 1, review: 0, done: 0, priority: 0, mine: 0, total: 1 };

function renderBoth() {
  return render(
    <>
      <AppHeader user={{ login: "lan", avatarUrl: null }} teams={TEAMS} />
      <HomeDashboardPage />
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

type TeamTasksResult = Awaited<ReturnType<typeof getTeamTasks>>;
function result(title: string, id: string): TeamTasksResult {
  return { tasks: [task(id, title)], projects: [PROJECT], counts: COUNTS };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  nav.reset("/home");
  vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", login: "lan" } as User);
  vi.mocked(getTeams).mockResolvedValue(TEAMS);
  vi.mocked(getTeamTasks).mockImplementation(async (teamId: string) =>
    teamId === "team-2" ? result("Beta only task", "b") : result("Alpha only task", "a"),
  );
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("/home: current team follows the URL", () => {
  it("re-resolves the team and loads its tasks when the header switches", async () => {
    renderBoth();
    expect(await screen.findByRole("heading", { name: "Alpha Team" })).toBeInTheDocument();
    expect(await screen.findAllByText("Alpha only task")).not.toHaveLength(0);

    pick("Beta Team");

    expect(await screen.findByRole("heading", { name: "Beta Team" })).toBeInTheDocument();
    expect(await screen.findAllByText("Beta only task")).not.toHaveLength(0);
    expect(vi.mocked(getTeamTasks)).toHaveBeenLastCalledWith("team-2");
    // The old team's tasks do not linger next to the new team's heading.
    expect(screen.queryByText("Alpha only task")).not.toBeInTheDocument();
    expect(headerTeam()).toBe("Beta Team");
  });

  it("shows the loading state, not the old team's tasks, until the new team's tasks arrive", async () => {
    renderBoth();
    await screen.findAllByText("Alpha only task");
    const slowB = deferred<TeamTasksResult>();
    vi.mocked(getTeamTasks).mockImplementation(() => slowB.promise);

    pick("Beta Team");

    expect(await screen.findByRole("heading", { name: "Beta Team" })).toBeInTheDocument();
    expect(screen.queryByText("Alpha only task")).not.toBeInTheDocument();
    expect(document.querySelector(".home-widgets-grid")).toBeNull();

    await act(async () => {
      slowB.resolve(result("Beta only task", "b"));
    });
    expect(await screen.findAllByText("Beta only task")).not.toHaveLength(0);
  });

  it("a fast B then A switch ends on A, and B's late response is ignored", async () => {
    renderBoth();
    await screen.findAllByText("Alpha only task");
    const lateB = deferred<TeamTasksResult>();
    vi.mocked(getTeamTasks).mockImplementation((teamId: string) =>
      teamId === "team-2" ? lateB.promise : Promise.resolve(result("Alpha only task", "a")),
    );

    pick("Beta Team");
    await waitFor(() => expect(getTeamTasks).toHaveBeenCalledWith("team-2"));
    pick("Alpha Team");
    expect(await screen.findAllByText("Alpha only task")).not.toHaveLength(0);
    await act(async () => {
      lateB.resolve(result("Beta only task", "b"));
    });

    expect(screen.queryByText("Beta only task")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Alpha Team" })).toBeInTheDocument();
    expect(headerTeam()).toBe("Alpha Team");
  });

  it("a late failure of the team that was left does not mark the current team's data stale", async () => {
    renderBoth();
    await screen.findAllByText("Alpha only task");
    let rejectB: (e: unknown) => void = () => {};
    vi.mocked(getTeamTasks).mockImplementation((teamId: string) =>
      teamId === "team-2"
        ? new Promise((_, reject) => { rejectB = reject; })
        : Promise.resolve(result("Alpha only task", "a")),
    );

    pick("Beta Team");
    await waitFor(() => expect(getTeamTasks).toHaveBeenCalledWith("team-2"));
    pick("Alpha Team");
    await screen.findAllByText("Alpha only task");
    await act(async () => {
      rejectB(new Error("late failure"));
    });

    expect(screen.queryByText("Couldn't load your tasks")).not.toBeInTheDocument();
    expect(document.querySelector(".home-stale-slot--hidden")).not.toBeNull();
    expect(screen.getAllByText("Alpha only task")).not.toHaveLength(0);
  });

  it("browser back and forward move the page and the header together", async () => {
    nav.reset("/home?teamId=team-1");
    renderBoth();
    await screen.findAllByText("Alpha only task");
    pick("Beta Team");
    expect(await screen.findAllByText("Beta only task")).not.toHaveLength(0);

    act(() => nav.back());
    expect(await screen.findByRole("heading", { name: "Alpha Team" })).toBeInTheDocument();
    expect(await screen.findAllByText("Alpha only task")).not.toHaveLength(0);
    expect(headerTeam()).toBe("Alpha Team");

    act(() => nav.forward());
    expect(await screen.findByRole("heading", { name: "Beta Team" })).toBeInTheDocument();
    expect(await screen.findAllByText("Beta only task")).not.toHaveLength(0);
    expect(headerTeam()).toBe("Beta Team");
  });

  it("a URL without ?teamId resolves the remembered team and writes it, for page and header alike", async () => {
    renderBoth();
    await screen.findAllByText("Alpha only task");
    pick("Beta Team");
    await screen.findAllByText("Beta only task");

    // The Home nav link: no ?teamId. Both fall to the remembered team (the
    // pick), not teams[0], and the page writes it into the URL.
    act(() => nav.push("/home"));

    expect(await screen.findByRole("heading", { name: "Beta Team" })).toBeInTheDocument();
    expect(headerTeam()).toBe("Beta Team");
    expect(nav.url).toBe("/home?teamId=team-2");
  });

  it("back to the first entry shows the team written into its URL on arrival", async () => {
    renderBoth();
    await screen.findAllByText("Alpha only task");
    expect(nav.url).toBe("/home?teamId=team-1");
    pick("Beta Team");
    await screen.findAllByText("Beta only task");

    act(() => nav.back());

    expect(await screen.findByRole("heading", { name: "Alpha Team" })).toBeInTheDocument();
    expect(await screen.findAllByText("Alpha only task")).not.toHaveLength(0);
    expect(headerTeam()).toBe("Alpha Team");
  });

  it("a switch that happens before the first load finished still lands on the picked team", async () => {
    const slowFirst = deferred<TeamTasksResult>();
    vi.mocked(getTeamTasks).mockImplementation((teamId: string) =>
      teamId === "team-1" ? slowFirst.promise : Promise.resolve(result("Beta only task", "b")),
    );
    renderBoth();
    await waitFor(() => expect(getTeamTasks).toHaveBeenCalledWith("team-1"));

    pick("Beta Team");
    expect(await screen.findAllByText("Beta only task")).not.toHaveLength(0);
    await act(async () => {
      slowFirst.resolve(result("Alpha only task", "a"));
    });

    expect(screen.queryByText("Alpha only task")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Beta Team" })).toBeInTheDocument();
    expect(headerTeam()).toBe("Beta Team");
  });

  it("a URL naming the team already shown, or an unknown team, loads nothing new", async () => {
    renderBoth();
    await screen.findAllByText("Alpha only task");
    const calls = vi.mocked(getTeamTasks).mock.calls.length;

    act(() => nav.push("/home?teamId=team-1"));
    act(() => nav.push("/home?teamId=ghost"));

    expect(screen.getByRole("heading", { name: "Alpha Team" })).toBeInTheDocument();
    expect(screen.getAllByText("Alpha only task")).not.toHaveLength(0);
    expect(vi.mocked(getTeamTasks).mock.calls).toHaveLength(calls);
  });
});
