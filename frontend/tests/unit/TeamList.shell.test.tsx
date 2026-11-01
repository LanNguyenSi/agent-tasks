/** @vitest-environment jsdom */
/**
 * The shell owns one team list: AppChrome loads it once and both the header
 * and the team-scoped pages read it (lib/teamList). The tests run the real
 * AppChrome with a page below it on one in-memory history
 * (tests/setup/fakeNavigation.ts).
 *
 * When `?teamId` names a team the list lacks (a membership change since it
 * loaded), the provider reloads the list once for that id, whoever asked
 * (header, page, or both); header and page then show the same team. If the id
 * is still missing afterwards, or the reload fails, both show the same
 * fallback (the remembered team, else the first one) and nothing loops.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent, waitFor } from "@testing-library/react";
import { waitForCall } from "./helpers/waitForCall";
import type { Task, Team, TeamTasksProject, User } from "../../src/lib/api";

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
  getProjects: vi.fn(),
  getTasks: vi.fn(),
  getWorkflows: vi.fn().mockResolvedValue([]),
  getAgentTokens: vi.fn(),
  getAvailableScopes: vi.fn(),
  createTeam: vi.fn(),
  logout: vi.fn(),
}));

import AppChrome from "../../src/components/AppChrome";
import AppHeader from "../../src/components/AppHeader";
import HomeDashboardPage from "../../src/app/home/page";
import ProjectsPage from "../../src/app/projects/page";
import TasksPage from "../../src/app/tasks/page";
import TeamSettingsPage from "../../src/app/settings/team/page";
import { TeamListProvider, useTeamList } from "../../src/lib/teamList";
import type { ReactElement } from "react";
import { usePathname } from "next/navigation";
import { nav, router } from "../setup/fakeNavigation";
import {
  createTeam,
  getAgentTokens,
  getAvailableScopes,
  getCurrentUser,
  getProjects,
  getTasks,
  getTeams,
  getTeamTasks,
} from "../../src/lib/api";

vi.mock("../../src/components/tasks/NewTaskFlow", () => ({ default: () => null }));

Element.prototype.scrollIntoView = vi.fn();
class IntersectionObserverStub {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
}
(global as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
  IntersectionObserverStub;

function team(id: string, name: string): Team {
  return { id, name, slug: id, role: "ADMIN", createdAt: "2026-01-01T00:00:00Z" };
}
const A = team("t1", "Alpha Team");
const B = team("t2", "Beta Team");
const X = team("t9", "Xray Team");

const COUNTS = { open: 0, review: 0, done: 0, priority: 0, mine: 0, total: 0 };
const PROJECT = { id: "p1", name: "Proj", slug: "proj", accessSource: "team" } as TeamTasksProject;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The team the header shows (switcher label, or the single-team label). */
function headerTeam(): string {
  const trigger = screen.queryByRole("button", { name: /Switch team/ });
  if (trigger) {
    return /current team (.+)$/.exec(trigger.getAttribute("aria-label") ?? "")?.[1] ?? "";
  }
  return document.querySelector(".app-team-label")?.textContent?.replace(/^Team: /, "") ?? "";
}

/** Let pending promise callbacks and effects run. */
async function settleAll() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  nav.reset("/home");
  vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", login: "lan", avatarUrl: null } as User);
  vi.mocked(getAgentTokens).mockResolvedValue([]);
  vi.mocked(getAvailableScopes).mockResolvedValue([]);
  vi.mocked(getProjects).mockResolvedValue([]);
  vi.mocked(getTasks).mockResolvedValue([]);
  vi.mocked(getTeamTasks).mockImplementation(
    async () =>
      ({ tasks: [] as Task[], projects: [PROJECT], counts: COUNTS, filteredTotal: 0 }) as never,
  );
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("one team list for the header and the page", () => {
  it("loads the teams once per shell mount; header and page show the same team", async () => {
    vi.mocked(getTeams).mockResolvedValue([A, B]);
    nav.reset("/home?teamId=t2");
    render(<AppChrome><HomeDashboardPage /></AppChrome>);

    expect(await screen.findByRole("heading", { name: "Beta Team" })).toBeInTheDocument();
    await settleAll();

    expect(getTeams).toHaveBeenCalledTimes(1);
    expect(headerTeam()).toBe("Beta Team");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("a bare URL gets the resolved team written, still from one request", async () => {
    vi.mocked(getTeams).mockResolvedValue([A, B]);
    render(<AppChrome><HomeDashboardPage /></AppChrome>);

    expect(await screen.findByRole("heading", { name: "Alpha Team" })).toBeInTheDocument();
    await settleAll();

    expect(nav.url).toBe("/home?teamId=t1");
    expect(getTeams).toHaveBeenCalledTimes(1);
    expect(headerTeam()).toBe("Alpha Team");
  });

  it("a team the list lacks: one refresh, then header and page show the team the URL names", async () => {
    const second = deferred<Team[]>();
    vi.mocked(getTeams).mockResolvedValueOnce([A, B]).mockReturnValueOnce(second.promise);
    nav.reset("/home?teamId=t9");
    render(<AppChrome><HomeDashboardPage /></AppChrome>);

    // Until the refresh answers, the URL is left alone (the fallback the page
    // resolves is not written over the team the refresh may bring).
    await waitFor(() => expect(getTeams).toHaveBeenCalledTimes(2));
    await settleAll();
    expect(nav.url).toBe("/home?teamId=t9");
    expect(router.replace).not.toHaveBeenCalled();

    await act(async () => {
      second.resolve([A, B, X]);
    });

    expect(await screen.findByRole("heading", { name: "Xray Team" })).toBeInTheDocument();
    await settleAll();
    expect(headerTeam()).toBe("Xray Team");
    expect(nav.url).toBe("/home?teamId=t9");
    expect(router.replace).not.toHaveBeenCalled();
    // Header and page both asked for t9; the provider reloaded once.
    expect(getTeams).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem("agent-tasks:lastTeamId")).toBe("t9");
  });

  it("the same works on /tasks (the page loads the team's list)", async () => {
    vi.mocked(getTeams).mockResolvedValueOnce([A, B]).mockResolvedValue([A, B, X]);
    nav.reset("/tasks?teamId=t9");
    render(<AppChrome><TasksPage /></AppChrome>);

    await waitFor(() => expect(getTeamTasks).toHaveBeenCalledWith("t9", expect.anything()));
    await waitFor(() => expect(headerTeam()).toBe("Xray Team"));
    expect(getTeams).toHaveBeenCalledTimes(2);
    expect(nav.url).toBe("/tasks?teamId=t9");
  });

  it.each([
    ["the remembered team", "t2", "Beta Team", "t2"],
    ["the first team when none is remembered", null, "Alpha Team", "t1"],
  ])(
    "a team still missing after the refresh: header and page both show %s, no further request",
    async (_label, remembered, name, id) => {
      if (remembered) window.localStorage.setItem("agent-tasks:lastTeamId", remembered);
      vi.mocked(getTeams).mockResolvedValue([A, B]);
      nav.reset("/home?teamId=ghost");
      render(<AppChrome><HomeDashboardPage /></AppChrome>);

      expect(await screen.findByRole("heading", { name })).toBeInTheDocument();
      await waitFor(() => expect(nav.url).toBe(`/home?teamId=${id}`));
      await settleAll();

      expect(headerTeam()).toBe(name);
      // The first lookup plus one refresh for "ghost"; nothing after that.
      expect(getTeams).toHaveBeenCalledTimes(2);
    },
  );

  it("a failed refresh keeps the old list, shows the same fallback in both, and does not retry", async () => {
    vi.mocked(getTeams).mockResolvedValueOnce([A, B]).mockRejectedValue(new Error("down"));
    nav.reset("/home?teamId=t9");
    render(<AppChrome><HomeDashboardPage /></AppChrome>);

    expect(await screen.findByRole("heading", { name: "Alpha Team" })).toBeInTheDocument();
    await waitFor(() => expect(nav.url).toBe("/home?teamId=t1"));
    await settleAll();

    expect(headerTeam()).toBe("Alpha Team");
    expect(screen.getByRole("button", { name: /Switch team/ })).toBeInTheDocument();
    expect(getTeams).toHaveBeenCalledTimes(2);
  });

  it("a team that is on the list is never refreshed for", async () => {
    vi.mocked(getTeams).mockResolvedValue([A, B]);
    nav.reset("/home?teamId=t1");
    render(<AppChrome><HomeDashboardPage /></AppChrome>);
    await screen.findByRole("heading", { name: "Alpha Team" });

    act(() => nav.push("/home?teamId=t2"));
    await screen.findByRole("heading", { name: "Beta Team" });
    await settleAll();

    expect(getTeams).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["/home", HomeDashboardPage],
    ["/projects", ProjectsPage],
    ["/tasks", TasksPage],
  ])(
    "%s waits for the shell's list: no zero-team lookup and no onboarding redirect while it loads",
    async (path, Page) => {
      const first = deferred<Team[]>();
      vi.mocked(getTeams).mockReturnValue(first.promise);
      nav.reset(path);
      render(<AppChrome><Page /></AppChrome>);

      // The user is known long before the list answers.
      await waitFor(() => expect(getCurrentUser).toHaveBeenCalled());
      await settleAll();
      expect(getProjects).not.toHaveBeenCalled();
      expect(router.replace).not.toHaveBeenCalled();

      await act(async () => {
        first.resolve([A, B]);
      });
      await waitFor(() => expect(nav.url).toBe(`${path}?teamId=t1`));
      expect(getProjects).not.toHaveBeenCalledWith();
      expect(router.replace).not.toHaveBeenCalledWith("/onboarding");
    },
  );

  it("/settings/team keeps its loading frame until the shell's list answers", async () => {
    const first = deferred<Team[]>();
    vi.mocked(getTeams).mockReturnValue(first.promise);
    nav.reset("/settings/team");
    render(<AppChrome><TeamSettingsPage /></AppChrome>);

    await waitFor(() => expect(getCurrentUser).toHaveBeenCalled());
    await settleAll();
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
    expect(document.getElementById("api-tokens")).toBeNull();

    await act(async () => {
      first.resolve([A, B]);
    });
    await waitFor(() => expect(document.getElementById("api-tokens")).not.toBeNull());
    expect(getAgentTokens).toHaveBeenCalledWith("t1");
  });

  it("a failed first lookup is the /tasks boot error and leaves the header without teams", async () => {
    vi.mocked(getTeams).mockRejectedValue(new Error("teams are down"));
    nav.reset("/tasks");
    render(<AppChrome><TasksPage /></AppChrome>);

    expect(await screen.findByText("teams are down")).toBeInTheDocument();
    expect(document.querySelector(".app-team-label, .app-team-trigger")).toBeNull();
    expect(getTeams).toHaveBeenCalledTimes(1);
  });
});

/** The page for the current path, under one mounted shell (a navigation swaps the page, not the shell). */
const PAGES: Record<string, () => ReactElement> = {
  "/home": () => <HomeDashboardPage />,
  "/projects": () => <ProjectsPage />,
  "/tasks": () => <TasksPage />,
  "/settings/team": () => <TeamSettingsPage />,
};
function Routes() {
  const Page = PAGES[usePathname() ?? "/home"];
  return Page ? <Page /> : null;
}

describe("a failed first lookup is retried by the next team-scoped page", () => {
  it("home fails to load the list; navigating to /tasks retries once and the page renders", async () => {
    vi.mocked(getTeams).mockRejectedValueOnce(new Error("teams are down")).mockResolvedValue([A, B]);
    nav.reset("/home");
    render(<AppChrome><Routes /></AppChrome>);
    await settleAll();
    // /home keeps its loading frame, nothing was retried yet.
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
    expect(getTeams).toHaveBeenCalledTimes(1);

    act(() => nav.push("/tasks"));
    await waitFor(() => expect(getTeamTasks).toHaveBeenCalled());
    await waitFor(() => expect(nav.url).toBe("/tasks?teamId=t1"));
    expect(screen.queryByText("teams are down")).not.toBeInTheDocument();
    expect(headerTeam()).toBe("Alpha Team");
    expect(getTeams).toHaveBeenCalledTimes(2);
  });

  it.each(["/projects", "/tasks", "/settings/team", "/home"])(
    "%s mounted after a failed lookup recovers the list",
    async (path) => {
      vi.mocked(getTeams).mockRejectedValueOnce(new Error("down")).mockResolvedValue([A, B]);
      // Start on a page that does not read the list through the retry (a path
      // with no page), so the first lookup fails with nobody to retry it.
      nav.reset("/elsewhere");
      render(<AppChrome><Routes /></AppChrome>);
      await settleAll();
      expect(getTeams).toHaveBeenCalledTimes(1);

      act(() => nav.push(path));
      await waitFor(() => expect(nav.url).toBe(`${path}?teamId=t1`));
      await settleAll();
      expect(getTeams).toHaveBeenCalledTimes(2);
      expect(headerTeam()).toBe("Alpha Team");
      expect(screen.getByRole("main")).not.toHaveAttribute("aria-busy", "true");
    },
  );

  it("a persistent failure costs one retry per page mount and never loops", async () => {
    vi.mocked(getTeams).mockRejectedValue(new Error("teams are down"));
    nav.reset("/home");
    render(<AppChrome><Routes /></AppChrome>);
    await settleAll();
    expect(getTeams).toHaveBeenCalledTimes(1);

    act(() => nav.push("/tasks"));
    expect(await screen.findByText("teams are down")).toBeInTheDocument();
    await settleAll();
    await settleAll();
    expect(getTeams).toHaveBeenCalledTimes(2);

    act(() => nav.push("/projects"));
    await settleAll();
    await settleAll();
    expect(getTeams).toHaveBeenCalledTimes(3);
    expect(getTeamTasks).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("no session: a failed list is not retried by the page", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    vi.mocked(getTeams).mockRejectedValueOnce(new Error("down")).mockResolvedValue([A, B]);
    nav.reset("/elsewhere");
    render(<AppChrome><Routes /></AppChrome>);
    await settleAll();

    nav.deferNavigations();
    act(() => nav.push("/tasks"));
    await act(async () => nav.settle());
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/auth"));
    await settleAll();
    expect(getTeams).toHaveBeenCalledTimes(1);
    expect((await waitForCall(router.replace)).map((c) => c[0])).toEqual(["/auth"]);
  });

  it("a page that mounts while the first lookup is still in flight does not retry", async () => {
    const first = deferred<Team[]>();
    vi.mocked(getTeams).mockReturnValueOnce(first.promise);
    nav.reset("/tasks");
    render(<AppChrome><Routes /></AppChrome>);
    await waitFor(() => expect(getCurrentUser).toHaveBeenCalled());
    await settleAll();
    expect(getTeams).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve([A, B]);
    });
    await waitFor(() => expect(getTeamTasks).toHaveBeenCalled());
    expect(getTeams).toHaveBeenCalledTimes(1);
  });

  it("a list that loaded is not retried when a page mounts", async () => {
    vi.mocked(getTeams).mockResolvedValue([A, B]);
    nav.reset("/home");
    render(<AppChrome><Routes /></AppChrome>);
    await screen.findByRole("heading", { name: "Alpha Team" });
    act(() => nav.push("/projects?teamId=t1"));
    await settleAll();
    expect(getTeams).toHaveBeenCalledTimes(1);
  });
});

describe("without a session the pages resolve no team and request nothing", () => {
  it.each(["/home", "/projects", "/tasks", "/settings/team"])(
    "%s with a non-empty team list: only the /auth redirect",
    async (path) => {
      vi.mocked(getCurrentUser).mockResolvedValue(null);
      vi.mocked(getTeams).mockResolvedValue([A, B]);
      nav.reset(path);
      // The /auth redirect stays pending, as in the app router where the
      // page is still mounted until the navigation lands.
      nav.deferNavigations();
      render(<AppChrome><Routes /></AppChrome>);

      await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/auth"));
      await settleAll();
      await settleAll();

      expect(getTeams).toHaveBeenCalledTimes(1);
      expect((await waitForCall(router.replace)).map((c) => c[0])).toEqual(["/auth"]);
      expect(getTeamTasks).not.toHaveBeenCalled();
      expect(getProjects).not.toHaveBeenCalled();
      expect(getTasks).not.toHaveBeenCalled();
      expect(getAgentTokens).not.toHaveBeenCalled();
    },
  );

  it.each(["/home", "/projects", "/tasks", "/settings/team"])(
    "%s with a ?teamId the list lacks and no session: no refresh, nothing written",
    async (path) => {
      vi.mocked(getCurrentUser).mockResolvedValue(null);
      vi.mocked(getTeams).mockResolvedValue([A, B]);
      nav.reset(`${path}?teamId=t9`);
      nav.deferNavigations();
      // The provider alone: the header asks for a missing id on its own,
      // this test is about the page.
      render(<TeamListProvider enabled><Routes /></TeamListProvider>);

      await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/auth"));
      await settleAll();
      await settleAll();

      expect(getTeams).toHaveBeenCalledTimes(1);
      expect((await waitForCall(router.replace)).map((c) => c[0])).toEqual(["/auth"]);
      expect(getTeamTasks).not.toHaveBeenCalled();
      expect(getAgentTokens).not.toHaveBeenCalled();
    },
  );
});

describe("who asks for a refresh", () => {
  it("a page asks on its own, without a header", async () => {
    vi.mocked(getTeams).mockResolvedValueOnce([A, B]).mockResolvedValue([A, B, X]);
    nav.reset("/home?teamId=t9");
    render(<TeamListProvider enabled><HomeDashboardPage /></TeamListProvider>);

    expect(await screen.findByRole("heading", { name: "Xray Team" })).toBeInTheDocument();
    expect(getTeams).toHaveBeenCalledTimes(2);
  });

  it("AppChrome passes the header's ask to the provider (a page with no team of its own)", async () => {
    vi.mocked(getTeams).mockResolvedValueOnce([A, B]).mockResolvedValue([A, B, X]);
    nav.reset("/home?teamId=t9");
    render(<AppChrome><p>plain page</p></AppChrome>);

    await waitFor(() => expect(headerTeam()).toBe("Xray Team"));
    expect(getTeams).toHaveBeenCalledTimes(2);
  });

  it("the header asks on its own, naming the missing id", () => {
    const onMissingTeam = vi.fn();
    nav.reset("/home?teamId=t9");
    render(<AppHeader user={{ login: "lan" }} teams={[A, B]} onMissingTeam={onMissingTeam} />);
    expect(onMissingTeam).toHaveBeenCalledTimes(1);
    expect(onMissingTeam).toHaveBeenCalledWith("t9");
  });

  it("the header asks when the known list is empty", () => {
    const onMissingTeam = vi.fn();
    nav.reset("/home?teamId=t9");
    render(<AppHeader user={{ login: "lan" }} teams={[]} onMissingTeam={onMissingTeam} />);
    expect(onMissingTeam).toHaveBeenCalledWith("t9");
  });

  it.each([
    ["a team on the list", "/home?teamId=t2", [A, B]],
    ["no team in the URL", "/home", [A, B]],
    ["an unknown list", "/home?teamId=t9", null],
  ] as const)("the header does not ask for %s", (_label, url, teams) => {
    const onMissingTeam = vi.fn();
    nav.reset(url);
    render(
      <AppHeader user={{ login: "lan" }} teams={teams ? [...teams] : null} onMissingTeam={onMissingTeam} />,
    );
    expect(onMissingTeam).not.toHaveBeenCalled();
  });
});

describe("creating a team refreshes the shared list", () => {
  it("the header and the new team's Home see the team from one extra request", async () => {
    const C = team("t3", "Gamma Team");
    const reload = deferred<Team[]>();
    vi.mocked(getTeams).mockResolvedValueOnce([A, B]).mockReturnValueOnce(reload.promise);
    vi.mocked(createTeam).mockResolvedValue(C);
    nav.reset("/home?teamId=t1");
    render(<AppChrome><HomeDashboardPage /></AppChrome>);
    await screen.findByRole("heading", { name: "Alpha Team" });

    fireEvent.click(await screen.findByRole("button", { name: "Account menu for lan" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New team" }));
    fireEvent.change(screen.getByLabelText("Team name"), { target: { value: "Gamma Team" } });
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));

    // The Home of the new team opens only once the list has been reloaded.
    await waitFor(() => expect(getTeams).toHaveBeenCalledTimes(2));
    await settleAll();
    expect(nav.url).toBe("/home?teamId=t1");
    await act(async () => {
      reload.resolve([A, B, C]);
    });

    expect(await screen.findByRole("heading", { name: "Gamma Team" })).toBeInTheDocument();
    await settleAll();
    expect(headerTeam()).toBe("Gamma Team");
    // First lookup plus the refresh after the create: the page named the new
    // team only once the list had it, so it needed no further reload.
    expect(getTeams).toHaveBeenCalledTimes(2);
    expect(nav.url).toBe("/home?teamId=t3");
  });

  it("a failed reload still opens the new team's Home", async () => {
    const C = team("t3", "Gamma Team");
    vi.mocked(getTeams).mockResolvedValueOnce([A, B]).mockRejectedValueOnce(new Error("down"));
    vi.mocked(getTeams).mockResolvedValue([A, B, C]);
    vi.mocked(createTeam).mockResolvedValue(C);
    nav.reset("/home?teamId=t1");
    render(<AppChrome><HomeDashboardPage /></AppChrome>);
    await screen.findByRole("heading", { name: "Alpha Team" });

    fireEvent.click(await screen.findByRole("button", { name: "Account menu for lan" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New team" }));
    fireEvent.change(screen.getByLabelText("Team name"), { target: { value: "Gamma Team" } });
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));

    // The failed reload leaves the old list; the URL names the new team, so
    // the one refresh for the missing id brings it in.
    expect(await screen.findByRole("heading", { name: "Gamma Team" })).toBeInTheDocument();
    await settleAll();
    expect(nav.url).toBe("/home?teamId=t3");
    expect(getTeams).toHaveBeenCalledTimes(3);
  });
});

describe("TeamListProvider", () => {
  function Probe({ id }: { id?: string }) {
    const list = useTeamList();
    return (
      <div>
        <span data-testid="status">{list.status}</span>
        <span data-testid="count">{list.teams?.length ?? "none"}</span>
        <button type="button" onClick={() => void list.refreshTeams()}>refresh</button>
        <button
          type="button"
          onClick={() => {
            list.refreshForTeam(id ?? "x");
            list.refreshForTeam(id ?? "x");
          }}
        >
          ask twice
        </button>
      </div>
    );
  }

  it("asks for a missing id once, however often it is asked", async () => {
    vi.mocked(getTeams).mockResolvedValue([A]);
    render(<TeamListProvider enabled><Probe /></TeamListProvider>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));
    expect(getTeams).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "ask twice" }));
    await settleAll();
    fireEvent.click(screen.getByRole("button", { name: "ask twice" }));
    await settleAll();
    expect(getTeams).toHaveBeenCalledTimes(2);

    // An explicit refresh is never guarded.
    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    await settleAll();
    expect(getTeams).toHaveBeenCalledTimes(3);
  });

  it("asks again for an id that was on the list and went missing later", async () => {
    vi.mocked(getTeams).mockResolvedValueOnce([A]).mockResolvedValueOnce([A, X]).mockResolvedValue([A]);
    render(<TeamListProvider enabled><Probe id="t9" /></TeamListProvider>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));

    fireEvent.click(screen.getByRole("button", { name: "ask twice" }));
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("2"));
    expect(getTeams).toHaveBeenCalledTimes(2);

    // t9 left the list again (third lookup): a new ask is allowed.
    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
    fireEvent.click(screen.getByRole("button", { name: "ask twice" }));
    await settleAll();
    expect(getTeams).toHaveBeenCalledTimes(4);
  });

  it("does nothing while the shell is suppressed", async () => {
    render(<TeamListProvider enabled={false}><Probe /></TeamListProvider>);
    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    fireEvent.click(screen.getByRole("button", { name: "ask twice" }));
    await settleAll();
    expect(getTeams).not.toHaveBeenCalled();
    expect(screen.getByTestId("status")).toHaveTextContent("loading");
  });

  it("a failed refresh keeps the list; a failed first lookup is an error", async () => {
    vi.mocked(getTeams).mockResolvedValueOnce([A, B]).mockRejectedValueOnce(new Error("down"));
    const { unmount } = render(<TeamListProvider enabled><Probe /></TeamListProvider>);
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("2"));
    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    await settleAll();
    expect(screen.getByTestId("status")).toHaveTextContent("ready");
    expect(screen.getByTestId("count")).toHaveTextContent("2");
    unmount();

    vi.mocked(getTeams).mockRejectedValueOnce(new Error("down"));
    render(<TeamListProvider enabled><Probe /></TeamListProvider>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("error"));
    expect(screen.getByTestId("count")).toHaveTextContent("none");
  });
});
