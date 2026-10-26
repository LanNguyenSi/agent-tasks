/** @vitest-environment jsdom */
/**
 * The real /projects/[id]/board route is the hub layout wrapping the board
 * page, and both load the project. A project that answers 404/403 lands on
 * the Projects page; any other failure (500, network) must keep the user on
 * the board's own "Could not load tasks" banner with Retry, with no
 * navigation from either component.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ApiRequestError, type User, type Project } from "../../src/lib/api";

const nav = vi.hoisted(() => ({ router: { replace: vi.fn(), push: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => nav.router,
  useParams: () => ({ id: "p-1" }),
  usePathname: () => "/projects/p-1/board",
  useSelectedLayoutSegment: () => "board",
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

import ProjectLayout from "../../src/app/projects/[id]/layout";
import ProjectBoardPage from "../../src/app/projects/[id]/board/page";
import { ToastProvider } from "../../src/components/ui/Toast";
import { getCurrentUser, getTeams, getProject, getTasks } from "../../src/lib/api";

const mockGetProject = vi.mocked(getProject);

const USER = {
  id: "u-1",
  login: "lan",
  name: "Lan",
  avatarUrl: null,
  email: null,
  githubConnected: false,
  allowAgentPrCreate: false,
  allowAgentPrMerge: false,
  allowAgentPrComment: false,
} as User;

const PROJECT = {
  id: "p-1",
  teamId: "t-1",
  name: "Project One",
  slug: "project-one",
  githubRepo: null,
  governanceMode: "AUTONOMOUS",
  accessRole: "ADMIN",
} as unknown as Project;

function renderRoute() {
  return render(
    <ToastProvider>
      <ProjectLayout>
        <ProjectBoardPage />
      </ProjectLayout>
    </ToastProvider>,
  );
}

function redirectTargets(): string[] {
  return [...new Set(nav.router.replace.mock.calls.map((c) => String(c[0])))];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue(USER);
  vi.mocked(getTeams).mockResolvedValue([]);
  vi.mocked(getTasks).mockResolvedValue([]);
  window.localStorage.clear();
  window.history.replaceState({}, "", "/projects/p-1/board");
  Element.prototype.scrollIntoView = vi.fn();
});

describe("board route (hub layout + board page)", () => {
  it("loads the board for an accessible project without navigating", async () => {
    mockGetProject.mockResolvedValue(PROJECT);
    renderRoute();
    // The toolbar's button comes first; the empty board repeats it in its first-run state.
    await waitFor(() => expect(screen.getAllByRole("button", { name: /new task/i })[0]).toBeEnabled());
    expect(nav.router.replace).not.toHaveBeenCalled();
  });

  it("titles the tab '<Project> · Board - agent-tasks'", async () => {
    mockGetProject.mockResolvedValue(PROJECT);
    document.title = "stale";
    renderRoute();
    await waitFor(() => expect(document.title).toBe("Project One · Board - agent-tasks"));
  });

  it.each([
    ["a 500", new ApiRequestError("internal", "Server exploded", 500)],
    ["a 401", new ApiRequestError("unauthorized", "Not signed in", 401)],
    ["a network failure", new TypeError("Failed to fetch")],
  ])("keeps the board's error banner with Retry and does not navigate on %s", async (_label, err) => {
    mockGetProject.mockRejectedValue(err);
    renderRoute();

    expect(await screen.findByText("Could not load tasks")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    // Let the layout's own load settle too before asserting the absence.
    await waitFor(() => expect(mockGetProject.mock.calls.length).toBeGreaterThanOrEqual(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("Could not load project")).not.toBeInTheDocument();
    expect(nav.router.replace).not.toHaveBeenCalled();
  });

  it.each([
    [404, "not_found"],
    [403, "forbidden"],
  ])("sends a project that answers %i to the Projects page and nowhere else", async (status, code) => {
    mockGetProject.mockRejectedValue(new ApiRequestError(code, "nope", status));
    renderRoute();

    await waitFor(() => expect(nav.router.replace).toHaveBeenCalledWith("/projects"));
    // The layout and the board both react; both go to the same place.
    expect(redirectTargets()).toEqual(["/projects"]);
    expect(nav.router.push).not.toHaveBeenCalled();
    expect(screen.queryByText("Could not load tasks")).not.toBeInTheDocument();
  });
});
