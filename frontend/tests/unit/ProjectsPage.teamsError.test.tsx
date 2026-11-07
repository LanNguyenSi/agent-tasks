/** @vitest-environment jsdom */
/**
 * /projects when the shell's team list could not be loaded.
 *
 * The page used to sit in its loading frame with no message. It now shows the
 * error the way /tasks shows its boot error (an `AlertBanner` and a Retry) and
 * the Retry reloads the one list the shell owns (`refreshTeams`, one `getTeams`
 * request). While that request is in flight the loading frame is shown; a
 * success leaves the error state; a failure shows the error again and asks for
 * the list no further on its own.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import type { Project, Team, User } from "../../src/lib/api";

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
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  syncTeamFromGitHub: vi.fn(),
  logout: vi.fn(),
}));

import ProjectsPageRaw from "../../src/app/projects/page";
import { withTeamList } from "./helpers/withTeamList";
const ProjectsPage = withTeamList(ProjectsPageRaw);
import { nav } from "../setup/fakeNavigation";
import { getCurrentUser, getTeams, getProjects } from "../../src/lib/api";

const mockGetTeams = vi.mocked(getTeams);

const USER = { id: "u-1", login: "lan", avatarUrl: null, githubConnected: true } as User;
const TEAMS = [
  { id: "t1", name: "Alpha Team", slug: "alpha", role: "ADMIN", createdAt: "2026-01-01T00:00:00Z" },
] as Team[];

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
  nav.reset("/projects");
  vi.mocked(getCurrentUser).mockResolvedValue(USER);
  vi.mocked(getProjects).mockResolvedValue([] as Project[]);
});
afterEach(() => cleanup());

describe("/projects when the team list could not be loaded", () => {
  it("shows the failure with a Retry instead of staying in the loading frame", async () => {
    mockGetTeams.mockRejectedValue(new Error("teams are down"));
    render(<ProjectsPage />);

    // role="alert" (the AlertBanner's danger tone) announces the state, like
    // the existing error on /tasks.
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load teams");
    expect(screen.getByText("teams are down")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("main")).not.toHaveAttribute("aria-busy");
    expect(mockGetTeams).toHaveBeenCalledTimes(1);
  });

  it("Retry reloads the list: loading while it is in flight, the page once it succeeds", async () => {
    const reload = deferred<Team[]>();
    mockGetTeams.mockRejectedValueOnce(new Error("teams are down")).mockReturnValue(reload.promise);
    render(<ProjectsPage />);
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    // In flight: the loading frame again, and no error banner.
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mockGetTeams).toHaveBeenCalledTimes(2);

    await act(async () => {
      reload.resolve(TEAMS);
    });

    // The loaded page: its filter and actions exist again and the team is
    // named.
    expect(await screen.findByRole("searchbox", { name: "Search projects" })).toBeInTheDocument();
    expect(screen.getByText(/Alpha Team · 0 projects/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "+ New Project" })).not.toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("main")).not.toHaveAttribute("aria-busy");
  });

  it("a Retry that fails shows the error again and asks for nothing further", async () => {
    mockGetTeams.mockRejectedValue(new Error("teams are down"));
    render(<ProjectsPage />);
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load teams");
    expect(screen.getByText("teams are down")).toBeInTheDocument();
    await settleAll();
    // First lookup plus the one Retry: a failure never retries on its own.
    expect(mockGetTeams).toHaveBeenCalledTimes(2);
  });

  it("no session: no error state, only the redirect to /auth", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    mockGetTeams.mockRejectedValue(new Error("teams are down"));
    render(<ProjectsPage />);

    await settleAll();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
