/** @vitest-environment jsdom */
/**
 * Project hub layout (app/projects/[id]/layout.tsx): an inaccessible
 * project falls back to the Projects page (never to the bare /dashboard,
 * which resumes the last board and could loop back to the same project),
 * a 401 goes to sign-in with the current location as the way back, and the
 * board tab renders in the wide, flush content slot while the
 * other tabs sit in the centred 1200px column (the band follows the tab's
 * --page-column through the <main> variant class); every tab renders the hub band and
 * body inside exactly one <main>. The band's crumb is `Projects / <project picker>`:
 * the Projects link goes through the routes builder, the picker lists the
 * team's projects (or the shared ones for a user without a team) and keeps
 * the tab when it switches projects; the page has exactly one H1.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiRequestError, type Project, type Team } from "../../src/lib/api";
import { projectsHref } from "../../src/lib/routes";

const nav = vi.hoisted(() => ({
  router: { replace: vi.fn(), push: vi.fn() },
  segment: "board" as string | null,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => nav.router,
  useParams: () => ({ id: "p-1" }),
  usePathname: () => (nav.segment ? `/projects/p-1/${nav.segment}` : "/projects/p-1"),
  useSearchParams: () => new URLSearchParams(""),
  useSelectedLayoutSegment: () => nav.segment,
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return { ...actual, getProject: vi.fn(), getProjects: vi.fn(), getTeams: vi.fn() };
});

import ProjectLayout from "../../src/app/projects/[id]/layout";
import { getProject, getProjects, getTeams } from "../../src/lib/api";

const mockGetProject = vi.mocked(getProject);
const mockGetProjects = vi.mocked(getProjects);
const mockGetTeams = vi.mocked(getTeams);

function team(id: string): Team {
  return { id, name: `Team ${id}`, slug: id, role: "ADMIN", createdAt: "2026-01-01T00:00:00.000Z" };
}

function proj(id: string, name: string, accessSource: "team" | "project" = "team"): Project {
  return { id, teamId: "t-1", name, slug: id, accessSource } as Project;
}

function renderLayout(segment: string | null) {
  nav.segment = segment;
  render(
    <ProjectLayout>
      <p>tab body</p>
    </ProjectLayout>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/projects/p-1");
  mockGetProject.mockResolvedValue({ id: "p-1", teamId: "t-1", name: "Project One", slug: "one" } as Project);
  mockGetTeams.mockResolvedValue([team("t-1")]);
  mockGetProjects.mockResolvedValue([proj("p-1", "Project One"), proj("p-2", "Project Two")]);
});

describe("project hub layout", () => {
  it.each([
    [404, "not_found"],
    [403, "forbidden"],
  ])("sends a project that answers %i to the Projects page", async (status, code) => {
    mockGetProject.mockRejectedValue(new ApiRequestError(code, "nope", status));
    renderLayout("board");
    await waitFor(() => expect(nav.router.replace).toHaveBeenCalledWith("/projects"));
    expect(nav.router.replace).toHaveBeenCalledTimes(1);
  });

  it("sends a project that answers 401 to sign-in with the path and query as the way back", async () => {
    window.history.replaceState({}, "", "/projects/p-1/members?tab=activity");
    mockGetProject.mockRejectedValue(
      new ApiRequestError("unauthorized", "Invalid or expired token", 401),
    );
    renderLayout("members");
    await waitFor(() =>
      expect(nav.router.replace).toHaveBeenCalledWith(
        "/auth?redirect=/projects/p-1/members?tab=activity",
      ),
    );
    expect(nav.router.replace).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Could not load project")).not.toBeInTheDocument();
  });

  it.each([
    ["a 500", new ApiRequestError("internal", "Server exploded", 500)],
    ["a network failure", new TypeError("Failed to fetch")],
  ])("does not redirect on %s", async (_label, err) => {
    mockGetProject.mockRejectedValue(err);
    renderLayout("members");
    expect(await screen.findByText("Could not load project")).toBeInTheDocument();
    expect(nav.router.replace).not.toHaveBeenCalled();
  });

  it("shows a Retry on a non-board tab that reloads the project", async () => {
    mockGetProject.mockRejectedValueOnce(new ApiRequestError("internal", "Server exploded", 500));
    renderLayout("settings");
    expect(await screen.findByText("Server exploded")).toBeInTheDocument();
    expect(screen.queryByText("tab body")).not.toBeInTheDocument();
    expect(screen.getByText("Server exploded").closest(".pshell-content--default")).not.toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Project One" })).toBeInTheDocument();
    expect(screen.queryByText("Could not load project")).not.toBeInTheDocument();
    expect(screen.getByText("tab body")).toBeInTheDocument();
    expect(mockGetProject).toHaveBeenCalledTimes(2);
    expect(nav.router.replace).not.toHaveBeenCalled();
  });

  it("renders the board child instead of the hub error on a failed load", async () => {
    mockGetProject.mockRejectedValue(new ApiRequestError("internal", "Server exploded", 500));
    renderLayout("board");
    expect(await screen.findByText("tab body")).toBeInTheDocument();
    await waitFor(() => expect(mockGetProject).toHaveBeenCalled());
    expect(screen.queryByText("Could not load project")).not.toBeInTheDocument();
    expect(nav.router.replace).not.toHaveBeenCalled();
  });

  it("renders the board in the wide, flush content slot (no 1200px column)", async () => {
    renderLayout("board");
    expect(await screen.findByRole("heading", { level: 1, name: "Project One" })).toBeInTheDocument();
    const slot = screen.getByText("tab body").closest(".pshell-content");
    expect(slot).toHaveClass("pshell-content--wide", "pshell-content--flush");
    expect(slot).not.toHaveClass("pshell-content--default");
    expect(screen.getByRole("main")).toHaveClass("pshell--wide");
  });

  it("offers Skip to board first on the board tab, before the hub band, aimed at the page's board region", async () => {
    renderLayout("board");
    expect(await screen.findByRole("heading", { level: 1, name: "Project One" })).toBeInTheDocument();
    const skip = screen.getByRole("link", { name: "Skip to board" });
    expect(skip).toHaveAttribute("href", "#board-region");
    const main = skip.closest("main") as HTMLElement;
    expect(main.querySelector("a, button, input")).toBe(skip);
    expect(skip.compareDocumentPosition(screen.getByRole("navigation", { name: "Breadcrumb" }))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("offers the skip link while the project loads and after a failed load", async () => {
    mockGetProject.mockReturnValue(new Promise(() => {}));
    renderLayout("board");
    expect(screen.getByRole("link", { name: "Skip to board" })).toBeInTheDocument();
    cleanup();
    mockGetProject.mockRejectedValue(new ApiRequestError("internal", "Server exploded", 500));
    renderLayout("board");
    await waitFor(() => expect(mockGetProject).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("link", { name: "Skip to board" })).toBeInTheDocument();
  });

  it.each(["members", "workflow", "settings", null])("has no skip link on the %s tab", async (segment) => {
    renderLayout(segment);
    expect(await screen.findByRole("heading", { level: 1, name: "Project One" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Skip to board" })).not.toBeInTheDocument();
  });

  it("keeps the other tabs in the 1200px content slot", async () => {
    renderLayout("members");
    expect(await screen.findByRole("heading", { level: 1, name: "Project One" })).toBeInTheDocument();
    const slot = screen.getByText("tab body").closest(".pshell-content");
    expect(slot).toHaveClass("pshell-content--default");
    expect(slot).not.toHaveClass("pshell-content--wide", "pshell-content--flush");
    // The hub band is a direct child of <main>, so it takes the tab's column.
    const main = screen.getByRole("main");
    expect(main).toHaveClass("pshell--default");
    expect(main.querySelector(":scope > .proj-hub-header")).not.toBeNull();
    expect(main.querySelector(":scope > .proj-subnav")).not.toBeNull();
  });

  it.each(["board", "members", "workflow", "settings"])(
    "renders exactly one <main> holding the hub band and the %s body",
    async (segment) => {
      renderLayout(segment);
      await screen.findByRole("heading", { level: 1, name: "Project One" });
      const mains = screen.getAllByRole("main");
      expect(mains).toHaveLength(1);
      const main = mains[0]!;
      // The band (crumb, H1, tab row) sits inside the one main, in front of the body.
      expect(within(main).getByRole("navigation", { name: "Breadcrumb" })).toBeInTheDocument();
      expect(within(main).getByRole("heading", { level: 1, name: "Project One" })).toBeInTheDocument();
      expect(main.querySelector(".proj-hub-header")).not.toBeNull();
      expect(main.querySelector(".proj-subnav")).not.toBeNull();
      const body = within(main).getByText("tab body");
      expect(
        main.querySelector(".proj-subnav")!.compareDocumentPosition(body) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    },
  );

  it("keeps one <main> while the project loads and after a failed load", async () => {
    mockGetProject.mockReturnValueOnce(new Promise(() => {}));
    const first = render(
      <ProjectLayout>
        <p>tab body</p>
      </ProjectLayout>,
    );
    expect(screen.getAllByRole("main")).toHaveLength(1);
    first.unmount();

    mockGetProject.mockRejectedValue(new ApiRequestError("internal", "Server exploded", 500));
    renderLayout("members");
    await screen.findByText("Could not load project");
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });
});

describe("hub band crumb", () => {
  it("links Projects to the project's team through the routes builder", async () => {
    renderLayout("board");
    await screen.findByRole("heading", { level: 1, name: "Project One" });
    const crumb = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
    expect(crumb.getByRole("link", { name: "Projects" })).toHaveAttribute(
      "href",
      projectsHref({ teamId: "t-1" }),
    );
    expect(crumb.queryByText("Dashboard")).not.toBeInTheDocument();
  });

  it("links Projects to the plain Projects page while the project loads", () => {
    mockGetProject.mockReturnValue(new Promise(() => {}));
    renderLayout("board");
    const crumb = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
    expect(crumb.getByRole("link", { name: "Projects" })).toHaveAttribute("href", projectsHref());
    expect(crumb.queryByRole("button")).not.toBeInTheDocument();
  });

  it("has exactly one H1 while loading, once loaded and after a failed load", async () => {
    mockGetProject.mockReturnValueOnce(new Promise(() => {}));
    const first = render(
      <ProjectLayout>
        <p>tab body</p>
      </ProjectLayout>,
    );
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    first.unmount();

    renderLayout("members");
    await screen.findByRole("heading", { level: 1, name: "Project One" });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    cleanup();

    mockGetProject.mockRejectedValue(new ApiRequestError("internal", "Server exploded", 500));
    renderLayout("members");
    await screen.findByText("Could not load project");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });
});

describe("hub band project picker", () => {
  async function openPicker() {
    renderLayout("members");
    const trigger = await screen.findByRole("button", { name: "Switch project, current: Project One" });
    await waitFor(() => expect(mockGetProjects).toHaveBeenCalled());
    await userEvent.click(trigger);
    return trigger;
  }

  it("lists the project's team's projects, shared ones marked", async () => {
    mockGetProjects.mockResolvedValue([
      proj("p-1", "Project One"),
      proj("p-2", "Project Two"),
      proj("p-9", "Shared Nine", "project"),
    ]);
    await openPicker();
    expect(mockGetProjects).toHaveBeenCalledWith("t-1");
    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Project One", "Project Two", "Shared Nine"]);
    expect(within(items[2]!).getByRole("img", { name: /shared via project invite/ })).toBeInTheDocument();
  });

  it.each([
    ["members", "/projects/p-2/members"],
    ["board", "/projects/p-2/board"],
    ["workflow", "/projects/p-2/workflow"],
    ["settings", "/projects/p-2/settings"],
    [null, "/projects/p-2"],
  ])("opens the same tab of the chosen project (%s)", async (segment, expected) => {
    nav.segment = segment;
    render(
      <ProjectLayout>
        <p>tab body</p>
      </ProjectLayout>,
    );
    const trigger = await screen.findByRole("button", { name: "Switch project, current: Project One" });
    await waitFor(() => expect(mockGetProjects).toHaveBeenCalled());
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Project Two" }));
    expect(nav.router.push).toHaveBeenCalledTimes(1);
    expect(nav.router.push).toHaveBeenCalledWith(expected);
  });

  it("does not navigate when the current project is chosen again", async () => {
    await openPicker();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Project One" }));
    expect(nav.router.push).not.toHaveBeenCalled();
  });

  it("works from the keyboard: Enter opens the menu, ArrowDown moves, Enter chooses", async () => {
    renderLayout("members");
    const trigger = await screen.findByRole("button", { name: "Switch project, current: Project One" });
    await waitFor(() => expect(mockGetProjects).toHaveBeenCalled());
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("menuitem", { name: "Project One" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(nav.router.push).toHaveBeenCalledWith("/projects/p-2/members");
  });

  it("lists the shared projects (no teamId) for a user without a team", async () => {
    mockGetTeams.mockResolvedValue([]);
    mockGetProject.mockResolvedValue({
      ...proj("p-1", "Project One", "project"),
      teamId: "t-other",
    } as Project);
    mockGetProjects.mockResolvedValue([proj("p-1", "Project One", "project"), proj("p-3", "Project Three", "project")]);
    renderLayout("members");
    await screen.findByRole("button", { name: "Switch project, current: Project One" });
    await waitFor(() => expect(mockGetProjects).toHaveBeenCalled());
    expect(mockGetProjects.mock.calls[0]).toEqual([undefined]);
    await userEvent.click(screen.getByRole("button", { name: /Switch project/ }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Project One",
      "Project Three",
    ]);
  });

  it("lists the project's own team even when another team is the user's first", async () => {
    mockGetTeams.mockResolvedValue([team("t-7"), team("t-1")]);
    renderLayout("board");
    await waitFor(() => expect(mockGetProjects).toHaveBeenCalled());
    expect(mockGetProjects).toHaveBeenCalledWith("t-1");
  });

  it("lists the current team's projects for a shared project when the user has other teams", async () => {
    mockGetTeams.mockResolvedValue([team("t-7"), team("t-8")]);
    mockGetProject.mockResolvedValue({ ...proj("p-1", "Project One", "project"), teamId: "t-other" } as Project);
    renderLayout("board");
    await waitFor(() => expect(mockGetProjects).toHaveBeenCalled());
    expect(mockGetProjects).toHaveBeenCalledWith("t-7");
  });

  it("offers the current project when the list fails or leaves it out", async () => {
    mockGetProjects.mockRejectedValue(new Error("boom"));
    await openPicker();
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Project One"]);
  });
});
