/** @vitest-environment jsdom */
/**
 * /home and /projects page frame: every state renders exactly one <main>
 * through PageShell on the default column, with the page title as the only H1
 * in a PageHeader band in the header slot (like /settings and /tasks). The
 * legacy `.page-shell` class is gone, and the Home loading skeleton is the
 * same frame as the loaded page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import type { Project, Team, User } from "../../src/lib/api";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/home",
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams(""),
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
}));

import HomeDashboardPage from "../../src/app/home/page";
import ProjectsPage from "../../src/app/projects/page";
import { getCurrentUser, getProjects, getTasks, getTeams, getTeamTasks } from "../../src/lib/api";

const USER = { id: "u-1", login: "lan", githubConnected: true } as User;
const TEAM = { id: "t1", name: "Pandora", slug: "pandora", role: "ADMIN", createdAt: "x" } as Team;
const SHARED = { id: "p3", name: "Shared Project", description: null, githubRepo: null } as Project;
const OWN = {
  id: "p1",
  teamId: "t1",
  name: "Own Project",
  slug: "own-project",
  description: null,
  githubRepo: null,
  createdAt: "2026-01-01T00:00:00Z",
  githubSyncAt: null,
} as unknown as Project;

// jsdom does not implement scrollIntoView; the Select listbox calls it.
Element.prototype.scrollIntoView = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.mocked(getCurrentUser).mockResolvedValue(USER);
  vi.mocked(getTasks).mockResolvedValue([]);
  vi.mocked(getTeamTasks).mockResolvedValue({
    tasks: [],
    projects: [],
    counts: { open: 0, review: 0, done: 0, priority: 0, mine: 0, total: 0 },
  } as never);
});
afterEach(cleanup);

function setAccess(teams: Team[], shared: Project[]) {
  vi.mocked(getTeams).mockResolvedValue(teams);
  vi.mocked(getProjects).mockImplementation(async (teamId?: string) => (teamId ? [OWN] : shared));
}

/** The one <main> on the default column, with its PageHeader band as a direct child. */
function expectDefaultFrame(): { main: HTMLElement; band: HTMLElement } {
  const mains = screen.getAllByRole("main");
  expect(mains).toHaveLength(1);
  const main = mains[0]!;
  expect(main).toHaveClass("pshell", "pshell--default");
  expect(main).not.toHaveClass("pshell--wide", "page-shell");
  const slot = main.querySelector(":scope > .pshell-content");
  expect(slot).toHaveClass("pshell-content--default");
  expect(slot).not.toHaveClass("pshell-content--wide", "pshell-content--flush");
  const bands = main.querySelectorAll(":scope > .page-header");
  expect(bands).toHaveLength(1);
  expect(document.querySelector(".page-shell")).toBeNull();
  return { main, band: bands[0] as HTMLElement };
}

describe("/home frame", () => {
  it("loading skeleton: a busy PageShell on the default column with a skeleton band", () => {
    setAccess([TEAM], []);
    vi.mocked(getCurrentUser).mockReturnValue(new Promise(() => {}));
    render(<HomeDashboardPage />);
    const { main, band } = expectDefaultFrame();
    expect(main).toHaveAttribute("aria-busy", "true");
    expect(within(band).queryByRole("heading")).toBeNull();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("with a team: the team name is the one H1, in the band, with no filler subtitle", async () => {
    setAccess([TEAM], []);
    render(<HomeDashboardPage />);
    const h1 = await screen.findByRole("heading", { level: 1, name: "Pandora" });
    const { band } = expectDefaultFrame();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(band).toContainElement(h1);
    expect(screen.queryByText("Task overview across all your projects.")).toBeNull();
    expect(band.querySelector(".page-header-summary")).toBeNull();
    // The scope tiles stay in the content slot, not the band.
    expect(band.querySelector(".home-stat-strip")).toBeNull();
    expect(document.querySelector(".pshell-content .home-stat-strip")).not.toBeNull();
  });

  it("without a team: 'Home' H1 and the Create a team action live in the band", async () => {
    setAccess([], [SHARED]);
    render(<HomeDashboardPage />);
    const h1 = await screen.findByRole("heading", { level: 1, name: "Home" });
    const { band } = expectDefaultFrame();
    expect(band).toContainElement(h1);
    const create = screen.getByRole("link", { name: "Create a team" });
    expect(band.querySelector(".page-header-actions")).toContainElement(create);
    expect(await screen.findByRole("link", { name: /Shared Project/ })).toBeInTheDocument();
  });
});

describe("/projects frame", () => {
  it("loading: the same busy PageShell as the loaded page", () => {
    setAccess([TEAM], []);
    vi.mocked(getCurrentUser).mockReturnValue(new Promise(() => {}));
    render(<ProjectsPage />);
    const { main } = expectDefaultFrame();
    expect(main).toHaveAttribute("aria-busy", "true");
  });

  it("with a team: 'Projects' is the only heading in the band, the team sits in the summary", async () => {
    setAccess([TEAM], []);
    render(<ProjectsPage />);
    await screen.findByText("Own Project");
    const { band } = expectDefaultFrame();
    const h1 = screen.getByRole("heading", { level: 1, name: "Projects" });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(band).toContainElement(h1);
    // The team name is plain summary text, not an H2 subtitle.
    expect(screen.queryByRole("heading", { level: 2, name: "Pandora" })).toBeNull();
    expect(band.querySelector(".page-header-summary")).toHaveTextContent("Pandora · 1 projects");
    // Actions live in the band's action area.
    const actions = band.querySelector(".page-header-actions") as HTMLElement;
    expect(within(actions).getByRole("button", { name: "Sync GitHub" })).toBeInTheDocument();
    expect(within(actions).getByRole("button", { name: "+ New Project" })).toBeInTheDocument();
  });

  it("without a team: the shared count is the summary and Create a team is a band action", async () => {
    setAccess([], [SHARED]);
    render(<ProjectsPage />);
    await screen.findByRole("link", { name: /Shared Project/ });
    const { band } = expectDefaultFrame();
    expect(band).toContainElement(screen.getByRole("heading", { level: 1, name: "Projects" }));
    expect(band.querySelector(".page-header-summary")).toHaveTextContent("1 shared project");
    expect(band.querySelector(".page-header-actions")).toContainElement(
      screen.getByRole("link", { name: "Create a team" }),
    );
  });
});

describe("/projects sort control", () => {
  it("table view: only the stacked compact native select, no sort Select in the filter row", async () => {
    setAccess([TEAM], []);
    window.localStorage.setItem("agent-tasks:teams:viewMode", "table");
    render(<ProjectsPage />);
    await screen.findByText("Own Project");
    const native = document.querySelectorAll("select.table-sort-native");
    expect(native).toHaveLength(1);
    expect(native[0]!.closest(".table-compact-sort")).not.toBeNull();
    expect(document.querySelector(".teams-filter-bar .teams-sort-select")).toBeNull();
  });

  it("cards view: the shared Select sits in the filter row and no native select renders", async () => {
    setAccess([TEAM], []);
    const second = { ...OWN, id: "p2", name: "Zeta Project", slug: "zeta" } as Project;
    vi.mocked(getProjects).mockImplementation(async (teamId?: string) => (teamId ? [OWN, second] : []));
    window.localStorage.setItem("agent-tasks:teams:viewMode", "cards");
    render(<ProjectsPage />);
    await screen.findByText("Own Project");

    expect(document.querySelector("select.table-sort-native")).toBeNull();
    const trigger = document.querySelector(".teams-filter-bar .teams-sort-select button") as HTMLElement;
    expect(trigger).not.toBeNull();
    expect(trigger).toHaveAttribute("aria-label", "Sort by");
    const titles = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(titles()).toEqual(["Own Project", "Zeta Project"]);

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("option", { name: "Name: Z to A" }));
    expect(titles()).toEqual(["Zeta Project", "Own Project"]);
  });
});
