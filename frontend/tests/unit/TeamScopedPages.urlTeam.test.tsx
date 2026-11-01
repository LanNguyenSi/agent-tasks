/** @vitest-environment jsdom */
/**
 * The four team-scoped pages (/home, /projects, /tasks, /settings/team) make
 * the URL name their team: on a URL without a valid `?teamId` they resolve
 * the team (remembered team, then the first) and write it with
 * `router.replace` (same path, other query parameters kept, no new history
 * entry). From then on the header and the page read the same `?teamId`, so a
 * later write of the remembered team (another tab) can move neither of them,
 * and a header pick of any other team switches both.
 *
 * Header and page are rendered together on one in-memory history
 * (tests/setup/fakeNavigation.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import type { AgentToken, Project, Task, Team, User } from "../../src/lib/api";

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
  getWorkflows: vi.fn().mockResolvedValue([]),
  getTeamTasks: vi.fn(),
  getAgentTokens: vi.fn(),
  getAvailableScopes: vi.fn(),
  createAgentToken: vi.fn(),
  revokeAgentToken: vi.fn(),
  renameAgentToken: vi.fn(),
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
import TeamSettingsPageRaw from "../../src/app/settings/team/page";
const TeamSettingsPage = withTeamList(TeamSettingsPageRaw);
import AppHeader from "../../src/components/AppHeader";
import AppChrome from "../../src/components/AppChrome";
import { nav, router } from "../setup/fakeNavigation";
import {
  getAgentTokens,
  getAvailableScopes,
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
const NAME: Record<string, string> = { t1: "Alpha", t2: "Beta" };

function task(teamId: string): Task {
  return {
    id: `task-${teamId}`, projectId: `proj-${teamId}`, title: `${NAME[teamId]} marker`,
    description: null, status: "open", priority: "MEDIUM", templateData: null,
    claimedByUserId: null, claimedByAgentId: null, claimedAt: null, dueAt: null,
    branchName: null, prUrl: null, prNumber: null, result: null, externalRef: null,
    labels: [], createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z",
    attachments: [],
  } as Task;
}
function project(teamId: string): Project {
  return {
    id: `proj-${teamId}`, teamId, name: `${NAME[teamId]} marker`, slug: `proj-${teamId}`,
    description: null, githubRepo: null, githubSyncAt: null, taskTemplate: null,
    confidenceThreshold: 60, requireDistinctReviewer: false, soloMode: true,
    governanceMode: "AUTONOMOUS", notificationWebhookUrl: null,
    hasNotificationWebhookSecret: false, createdAt: "2026-01-01T00:00:00Z",
  } as Project;
}
function token(teamId: string): AgentToken {
  return {
    id: `tok-${teamId}`, name: `${NAME[teamId]} marker`, scopes: ["tasks:read"],
    expiresAt: null, lastUsedAt: null, createdAt: "2026-08-01T00:00:00Z",
  };
}

/** Each page with the path it lives on. Every page shows "<Team> marker". */
const PAGES: { path: string; Page: ComponentType }[] = [
  { path: "/home", Page: HomeDashboardPage },
  { path: "/projects", Page: ProjectsPage },
  { path: "/tasks", Page: TasksPage },
  { path: "/settings/team", Page: TeamSettingsPage },
];

function renderBoth(Page: ComponentType) {
  return render(
    <>
      <AppHeader user={{ login: "lan", avatarUrl: null }} teams={TEAMS} />
      <Page />
    </>,
  );
}

function headerTeam(): string {
  const label = screen.getByRole("button", { name: /Switch team/ }).getAttribute("aria-label");
  return /current team (.+)$/.exec(label ?? "")?.[1] ?? "";
}

/** The page shows `name`'s data and none of the other team's. */
async function pageShows(name: string) {
  expect((await screen.findAllByText(`${name} marker`)).length).toBeGreaterThan(0);
  const other = name === "Alpha" ? "Beta" : "Alpha";
  expect(screen.queryByText(`${other} marker`)).not.toBeInTheDocument();
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", login: "lan" } as User);
  vi.mocked(getTeams).mockResolvedValue(TEAMS);
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
  vi.mocked(getAgentTokens).mockImplementation(async (teamId: string) => [token(teamId)]);
  vi.mocked(getAvailableScopes).mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe.each(PAGES)("$path without ?teamId", ({ path, Page }) => {
  it("writes the resolved team into the URL with replace, keeping the other parameters", async () => {
    window.localStorage.setItem("agent-tasks:lastTeamId", "t2");
    nav.reset("/start");
    nav.push(`${path}?from=nav&x=1`);
    renderBoth(Page);

    await waitFor(() => expect(nav.url).toBe(`${path}?from=nav&x=1&teamId=t2`));
    expect(router.replace).toHaveBeenCalledWith(`${path}?from=nav&x=1&teamId=t2`, {
      scroll: false,
    });
    expect(router.push).not.toHaveBeenCalled();
    // The entry was replaced, not added: one back leaves the page.
    expect(nav.entries).toEqual(["/start", `${path}?from=nav&x=1&teamId=t2`]);
    expect(nav.index).toBe(1);
    await pageShows("Beta");
    expect(headerTeam()).toBe("Beta");
    // The written team is not counted as the user's choice, but it is the
    // remembered one anyway here.
    expect(window.localStorage.getItem("agent-tasks:lastTeamId")).toBe("t2");
  });

  it("replaces an unknown ?teamId with the resolved team", async () => {
    nav.reset(`${path}?teamId=ghost`);
    renderBoth(Page);

    await waitFor(() => expect(nav.url).toBe(`${path}?teamId=t1`));
    expect(nav.entries).toHaveLength(1);
    await pageShows("Alpha");
    expect(headerTeam()).toBe("Alpha");
  });

  it("leaves a valid ?teamId alone", async () => {
    nav.reset(`${path}?teamId=t2`);
    renderBoth(Page);

    await pageShows("Beta");
    expect(router.replace).not.toHaveBeenCalled();
    expect(nav.url).toBe(`${path}?teamId=t2`);
  });

  it("after a later write of the remembered team (another tab), header and page agree and a pick of the other team switches both", async () => {
    nav.reset(path);
    renderBoth(Page);
    await waitFor(() => expect(nav.url).toBe(`${path}?teamId=t1`));
    await pageShows("Alpha");

    // Another tab remembers Beta. Opening the menu re-renders the header.
    window.localStorage.setItem("agent-tasks:lastTeamId", "t2");
    fireEvent.click(screen.getByRole("button", { name: /Switch team/ }));
    expect(headerTeam()).toBe("Alpha");
    expect(screen.getByRole("menuitemradio", { name: "Alpha" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // Picking Beta (the remembered team, not the URL's) is a real switch.
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Beta" }));
    await pageShows("Beta");
    expect(headerTeam()).toBe("Beta");
    expect(nav.url).toBe(`${path}?teamId=t2`);
  });
});

/** The pages as the shell mounts them: AppChrome owns the team list. */
const RAW_PAGES: { path: string; Page: ComponentType }[] = [
  { path: "/home", Page: HomeDashboardPageRaw },
  { path: "/projects", Page: ProjectsPageRaw },
  { path: "/tasks", Page: TasksPageRaw },
  { path: "/settings/team", Page: TeamSettingsPageRaw },
];

describe.each(RAW_PAGES)("$path with a team list older than the URL", ({ path, Page }) => {
  const GAMMA = team("t3", "Gamma");

  beforeEach(() => {
    NAME.t3 = "Gamma";
  });

  it("reloads the shared list once; header and page show the team the URL names", async () => {
    vi.mocked(getTeams).mockReset();
    vi.mocked(getTeams).mockResolvedValueOnce(TEAMS).mockResolvedValue([...TEAMS, GAMMA]);
    nav.reset(`${path}?teamId=t3`);
    render(<AppChrome><Page /></AppChrome>);

    await pageShows("Gamma");
    await waitFor(() => expect(headerTeam()).toBe("Gamma"));
    expect(nav.url).toBe(`${path}?teamId=t3`);
    expect(router.replace).not.toHaveBeenCalled();
    expect(getTeams).toHaveBeenCalledTimes(2);
  });

  it("still missing after the reload: header and page show the same fallback, the remembered team", async () => {
    window.localStorage.setItem("agent-tasks:lastTeamId", "t2");
    nav.reset(`${path}?teamId=t3`);
    render(<AppChrome><Page /></AppChrome>);

    await waitFor(() => expect(nav.url).toBe(`${path}?teamId=t2`));
    await pageShows("Beta");
    expect(headerTeam()).toBe("Beta");
    expect(getTeams).toHaveBeenCalledTimes(2);
  });
});

describe("/settings/team URL write", () => {
  it("keeps the hash of the URL it replaces", async () => {
    window.location.hash = "#sso";
    nav.reset("/settings/team");
    renderBoth(TeamSettingsPage);

    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/settings/team?teamId=t1#sso", {
        scroll: false,
      }),
    );
  });
});
