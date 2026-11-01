/** @vitest-environment jsdom */
/**
 * A non-header link (the /tasks boot-error "Projects" link) and the URL
 * rewrite the target page would otherwise make.
 *
 * A team-scoped page whose URL names no team writes the team it resolved
 * into the URL with `router.replace` once its team list arrives (useCurrent-
 * Team in lib/teamSwitch.ts). In the app router a navigation stays pending
 * until the target has loaded and a newer navigation discards it, so that
 * write made while a click is still in flight cancels the click. A link that
 * already carries `?teamId=` leaves the target nothing to write.
 *
 * This runs the tasks page and the projects page on one in-memory history in
 * deferred mode (tests/setup/fakeNavigation.ts). The boot-error link is a
 * plain anchor (a `Button href`), so a click handler mirrors what the nav
 * does with it: an in-app href becomes `router.push(href)` (the same stand-in
 * `FakeLink` provides for `next/link`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEffect, type ReactNode } from "react";
import { render, screen, cleanup, fireEvent, act, waitFor, within } from "@testing-library/react";
import type { Project, Team, User } from "../../src/lib/api";

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
  getWorkflows: vi.fn().mockResolvedValue([]),
  getTeamTasks: vi.fn(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  syncTeamFromGitHub: vi.fn(),
  updateTask: vi.fn(),
  logout: vi.fn(),
}));

vi.mock("../../src/components/tasks/NewTaskFlow", () => ({ default: () => null }));

import TasksPageRaw from "../../src/app/tasks/page";
import { withTeamList } from "./helpers/withTeamList";
const TasksPage = withTeamList(TasksPageRaw);
import ProjectsPageRaw from "../../src/app/projects/page";
const ProjectsPage = withTeamList(ProjectsPageRaw);
import AppHeader from "../../src/components/AppHeader";
import { nav, router, usePathname } from "../setup/fakeNavigation";
import {
  getCurrentUser,
  getProjects,
  getTasks,
  getTeams,
  getTeamTasks,
} from "../../src/lib/api";

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

/** Renders the page of the current path, like the app router's outlet. */
function Outlet() {
  const pathname = usePathname();
  if (pathname === "/tasks") return <TasksPage />;
  if (pathname === "/projects") return <ProjectsPage />;
  return null;
}

/** A click on an in-app anchor navigates to its href, as the nav does. */
function AnchorNavigates({ children }: { children: ReactNode }) {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented) return; // a Link (FakeLink) already routed it
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!href.startsWith("/") || href.startsWith("//") || href.startsWith("#")) return;
      event.preventDefault();
      router.push(href);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  return <>{children}</>;
}

function renderApp() {
  // The header shows no team: the shell's one list failed, which is what put
  // /tasks into its boot error (the header and the pages read the same list).
  return render(
    <AnchorNavigates>
      <AppHeader user={{ login: "lan", avatarUrl: null }} teams={null} />
      <Outlet />
    </AnchorNavigates>,
  );
}

function bootErrorProjectsLink(): HTMLElement {
  return within(screen.getByRole("main")).getByRole("link", { name: "Projects" });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", login: "lan" } as User);
  // The failed lookup that puts /tasks in its boot error; every lookup after
  // it (the Projects page's own shell mount) succeeds.
  vi.mocked(getTeams)
    .mockRejectedValueOnce(new Error("teams unavailable"))
    .mockResolvedValue(TEAMS);
  vi.mocked(getProjects).mockImplementation(async (teamId?: string) =>
    teamId ? [project(teamId)] : [],
  );
  vi.mocked(getTasks).mockResolvedValue([]);
  vi.mocked(getTeamTasks).mockResolvedValue({
    tasks: [],
    projects: [],
    counts: { open: 0, review: 0, done: 0, priority: 0, mine: 0, total: 0 },
    filteredTotal: 0,
  } as never);
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("the boot-error Projects link in deferred navigation", () => {
  it("from /tasks?teamId=t1 it lands on /projects?teamId=t1 and the page writes no URL", async () => {
    nav.reset("/tasks?teamId=t1");
    nav.deferNavigations();
    renderApp();

    await screen.findByText("Failed to load");
    fireEvent.click(bootErrorProjectsLink());
    // The click is pending and it already carries the team.
    expect(nav.pending).toBe("/projects?teamId=t1");
    act(() => nav.settle());

    // The Projects page loads with its teams under that team ...
    await waitFor(() => expect(getProjects).toHaveBeenCalledWith("t1"));
    // ... and writes nothing into its own URL: no rewrite, nothing that
    // could have discarded the click on its way in.
    expect(nav.url).toBe("/projects?teamId=t1");
    expect(nav.pending).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
    expect(nav.entries).toEqual(["/tasks?teamId=t1", "/projects?teamId=t1"]);
  });

  it("contrast: from a bare /tasks it lands bare and the page writes the team it resolved", async () => {
    nav.reset("/tasks");
    nav.deferNavigations();
    renderApp();

    await screen.findByText("Failed to load");
    fireEvent.click(bootErrorProjectsLink());
    expect(nav.pending).toBe("/projects");
    act(() => nav.settle());

    // Without a team in the URL the rewrite happens: this is the window the
    // carrying links close.
    await waitFor(() => expect(nav.pending).toBe("/projects?teamId=t1"));
    act(() => nav.settle());
    expect(nav.url).toBe("/projects?teamId=t1");
    expect(router.replace).toHaveBeenCalledWith("/projects?teamId=t1", { scroll: false });
  });
});
