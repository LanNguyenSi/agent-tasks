/** @vitest-environment jsdom */
/**
 * A header nav click made while the current page still loads its teams lands
 * on the clicked section.
 *
 * In the app router a navigation stays pending until the new route has
 * loaded, and a newer navigation dispatched before then discards it. A
 * team-scoped page whose URL names no team writes its resolved team into the
 * URL with `router.replace` once its teams arrive (useCurrentTeam); if that
 * write lands while the user's click is pending, it cancels the click. The
 * header's nav and brand links carry the team the header shows, so a page
 * reached through them already names its team and never writes the URL.
 *
 * The header, a route outlet and the pages run on one in-memory history in
 * deferred mode (tests/setup/fakeNavigation.ts): `router.push` and
 * `router.replace` stay pending until `nav.settle()`, and only the newest
 * pending navigation is applied. `next/link` is a stand-in whose click is a
 * `router.push(href)`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import type { Project, Task, Team, User } from "../../src/lib/api";

vi.mock("next/navigation", async () => {
  const m = await import("../setup/fakeNavigation");
  return {
    usePathname: m.usePathname,
    useRouter: m.useRouter,
    useSearchParams: m.useSearchParams,
  };
});
vi.mock("next/link", async () => ({
  default: (await import("../setup/fakeNavigation")).FakeLink,
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  getProjects: vi.fn(),
  getTasks: vi.fn(),
  getTeamTasks: vi.fn(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  syncTeamFromGitHub: vi.fn(),
  updateTask: vi.fn(),
  logout: vi.fn(),
}));

vi.mock("../../src/components/tasks/NewTaskFlow", () => ({ default: () => null }));

import HomeDashboardPageRaw from "../../src/app/home/page";
import { withTeamList } from "./helpers/withTeamList";
const HomeDashboardPage = withTeamList(HomeDashboardPageRaw);
import ProjectsPageRaw from "../../src/app/projects/page";
const ProjectsPage = withTeamList(ProjectsPageRaw);
import TasksPageRaw from "../../src/app/tasks/page";
const TasksPage = withTeamList(TasksPageRaw);
import AppHeader from "../../src/components/AppHeader";
import { nav, router, usePathname } from "../setup/fakeNavigation";
import { getCurrentUser, getProjects, getTasks, getTeams, getTeamTasks } from "../../src/lib/api";

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
const TEAMS = [team("t1", "Alpha"), team("t2", "Beta")];

function project(teamId: string): Project {
  return {
    id: `proj-${teamId}`, teamId, name: `Project ${teamId}`, slug: `proj-${teamId}`,
    description: null, githubRepo: null, githubSyncAt: null, taskTemplate: null,
    confidenceThreshold: 60, requireDistinctReviewer: false, soloMode: true,
    governanceMode: "AUTONOMOUS", notificationWebhookUrl: null,
    hasNotificationWebhookSecret: false, createdAt: "2026-01-01T00:00:00Z",
  } as Project;
}
function task(teamId: string): Task {
  return {
    id: `task-${teamId}`, projectId: `proj-${teamId}`, title: `Task ${teamId}`,
    description: null, status: "open", priority: "MEDIUM", templateData: null,
    claimedByUserId: null, claimedByAgentId: null, claimedAt: null, dueAt: null,
    branchName: null, prUrl: null, prNumber: null, result: null, externalRef: null,
    labels: [], createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z",
    attachments: [],
  } as Task;
}

/** Renders the page of the current path, like the app router's outlet. */
function Outlet() {
  const pathname = usePathname();
  if (pathname === "/home") return <HomeDashboardPage />;
  if (pathname === "/projects") return <ProjectsPage />;
  if (pathname === "/tasks") return <TasksPage />;
  return null;
}

function renderApp(teams: Team[] | null = TEAMS) {
  return render(
    <>
      <AppHeader user={{ login: "lan", avatarUrl: null }} teams={teams} />
      <Outlet />
    </>,
  );
}

/** A header link: a nav item by name, or the brand. */
function headerLink(name: string): HTMLElement {
  if (name === "brand") return screen.getByRole("link", { name: "agent-tasks" });
  return screen.getByRole("link", { name });
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let pageTeams: ReturnType<typeof deferred<Team[]>>;

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  pageTeams = deferred<Team[]>();
  vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", login: "lan" } as User);
  // Every page's team lookup waits until the test releases it.
  vi.mocked(getTeams).mockImplementation(() => pageTeams.promise);
  vi.mocked(getProjects).mockImplementation(async (teamId?: string) =>
    teamId ? [project(teamId)] : [],
  );
  vi.mocked(getTasks).mockResolvedValue([]);
  vi.mocked(getTeamTasks).mockImplementation(async (teamId: string) => ({
    tasks: [task(teamId)],
    projects: [{ id: `proj-${teamId}`, name: "Proj", slug: "proj", accessSource: "team" }],
    counts: { open: 1, review: 0, done: 0, priority: 0, mine: 0, total: 1 },
    filteredTotal: 1,
  }) as unknown as Awaited<ReturnType<typeof getTeamTasks>>);
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("header nav click while the page loads its teams", () => {
  it.each([
    ["Tasks", "/tasks", "Projects", "/projects"],
    ["Projects", "/projects", "Tasks", "/tasks"],
    ["Home", "/home", "Tasks", "/tasks"],
    ["Tasks", "/tasks", "brand", "/home"],
  ])(
    "on %s (%s), a click on %s (%s) before that page's teams arrive lands on the clicked section",
    async (first, firstPath, second, secondPath) => {
      // The header shows Beta (remembered) on a page outside the sections.
      window.localStorage.setItem("agent-tasks:lastTeamId", "t2");
      nav.reset("/settings");
      nav.deferNavigations();
      renderApp();

      fireEvent.click(headerLink(first));
      act(() => nav.settle());
      expect(nav.url).toBe(`${firstPath}?teamId=t2`);
      await waitFor(() => expect(getTeams).toHaveBeenCalled());

      // The click on the other section is still pending ...
      fireEvent.click(headerLink(second));
      expect(nav.pending).toBe(`${secondPath}?teamId=t2`);
      // ... when the first page's teams arrive.
      await act(async () => {
        pageTeams.resolve(TEAMS);
      });
      act(() => nav.settle());

      expect(nav.url).toBe(`${secondPath}?teamId=t2`);
      expect(router.replace).not.toHaveBeenCalled();
    },
  );

  it("a direct entry on a bare URL still gets its team written into the URL", async () => {
    nav.reset("/tasks");
    nav.deferNavigations();
    renderApp();
    await waitFor(() => expect(getTeams).toHaveBeenCalled());

    await act(async () => {
      pageTeams.resolve(TEAMS);
    });
    expect(nav.pending).toBe("/tasks?teamId=t1");
    act(() => nav.settle());

    expect(nav.url).toBe("/tasks?teamId=t1");
    expect(nav.entries).toEqual(["/tasks?teamId=t1"]);
  });

  it("with the header's team list unknown the links stay bare and the page writes its team", async () => {
    nav.reset("/settings");
    nav.deferNavigations();
    renderApp(null);

    fireEvent.click(headerLink("Tasks"));
    act(() => nav.settle());
    expect(nav.url).toBe("/tasks");
    await act(async () => {
      pageTeams.resolve(TEAMS);
    });
    act(() => nav.settle());

    expect(nav.url).toBe("/tasks?teamId=t1");
    expect(router.replace).toHaveBeenCalledWith("/tasks?teamId=t1", { scroll: false });
  });
});
