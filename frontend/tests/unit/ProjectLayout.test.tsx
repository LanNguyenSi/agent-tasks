/** @vitest-environment jsdom */
/**
 * Project hub layout (app/projects/[id]/layout.tsx): an inaccessible
 * project falls back to the Projects page (never to the bare /dashboard,
 * which resumes the last board and could loop back to the same project),
 * and the board tab renders outside the 1200px content container that
 * the other tabs sit in.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiRequestError, type Project } from "../../src/lib/api";

const nav = vi.hoisted(() => ({
  router: { replace: vi.fn(), push: vi.fn() },
  segment: "board" as string | null,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => nav.router,
  useParams: () => ({ id: "p-1" }),
  usePathname: () => (nav.segment ? `/projects/p-1/${nav.segment}` : "/projects/p-1"),
  useSelectedLayoutSegment: () => nav.segment,
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return { ...actual, getProject: vi.fn() };
});

import ProjectLayout from "../../src/app/projects/[id]/layout";
import { getProject } from "../../src/lib/api";

const mockGetProject = vi.mocked(getProject);

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
  mockGetProject.mockResolvedValue({ id: "p-1", teamId: "t-1", name: "Project One", slug: "one" } as Project);
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

  it.each([
    ["a 500", new ApiRequestError("internal", "Server exploded", 500)],
    ["a 401", new ApiRequestError("unauthorized", "Not signed in", 401)],
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
    expect(screen.getByText("Server exploded").closest(".proj-hub-content")).not.toBeNull();

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

  it("renders the board outside the hub content container", async () => {
    renderLayout("board");
    expect(await screen.findByRole("heading", { level: 1, name: "Project One" })).toBeInTheDocument();
    expect(screen.getByText("tab body").closest(".proj-hub-content")).toBeNull();
  });

  it("keeps the other tabs inside the hub content container", async () => {
    renderLayout("members");
    expect(await screen.findByRole("heading", { level: 1, name: "Project One" })).toBeInTheDocument();
    expect(screen.getByText("tab body").closest(".proj-hub-content")).not.toBeNull();
  });
});
