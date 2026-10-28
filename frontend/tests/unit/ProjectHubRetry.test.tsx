/** @vitest-environment jsdom */
/**
 * Retry on a failed project load in the project hub layout
 * (app/projects/[id]/_components/ProjectHubLayout.tsx), non-board tabs:
 * the error branch (banner and Retry button) stays rendered while the retry
 * is in flight (the child tab never mounts and unmounts under a failing
 * reload), Retry is unavailable while retrying (aria-disabled with a busy
 * label, clicks ignored) and keeps the focus the click placed on it, and a
 * second failure shows the banner again with Retry enabled. A retry that
 * answers 401/403/404 redirects as the first load does. The board tab has
 * its own load and Retry (board/page.tsx) and is out of scope here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiRequestError, type Project, type Team } from "../../src/lib/api";

const nav = vi.hoisted(() => ({
  router: { replace: vi.fn(), push: vi.fn() },
  segment: "members" as string | null,
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

function proj(): Project {
  return { id: "p-1", teamId: "t-1", name: "Project One", slug: "one" } as Project;
}

function team(id: string): Team {
  return { id, name: `Team ${id}`, slug: id, role: "ADMIN", createdAt: "2026-01-01T00:00:00.000Z" };
}

function deferred() {
  let resolve!: (value: Project) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Project>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function renderFailingFirstLoad() {
  const first = deferred();
  mockGetProject.mockReturnValueOnce(first.promise);
  nav.segment = "members";
  render(
    <ProjectLayout>
      <p>tab body</p>
    </ProjectLayout>,
  );
  await act(async () => {
    first.reject(new ApiRequestError("internal", "Server exploded", 500));
  });
  expect(await screen.findByText("Server exploded")).toBeInTheDocument();
}

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  window.history.replaceState({}, "", "/projects/p-1/members");
  mockGetProject.mockResolvedValue(proj());
  mockGetTeams.mockResolvedValue([team("t-1")]);
  mockGetProjects.mockResolvedValue([]);
});

describe("hub Retry on a failed project load", () => {
  it("keeps the banner up, hides the tab and disables Retry while the retry is in flight, then recovers", async () => {
    await renderFailingFirstLoad();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();

    const second = deferred();
    mockGetProject.mockReturnValueOnce(second.promise);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    // In flight: the same error branch, no child tab, Retry busy and focused.
    expect(screen.getByText("Could not load project")).toBeInTheDocument();
    expect(screen.getByText("Server exploded")).toBeInTheDocument();
    expect(screen.queryByText("tab body")).not.toBeInTheDocument();
    const busy = screen.getByRole("button", { name: "Retrying" });
    expect(busy).toHaveAttribute("aria-disabled", "true");
    expect(busy).toHaveFocus();
    // A click while busy starts no further request.
    await userEvent.click(busy);
    expect(mockGetProject).toHaveBeenCalledTimes(2);

    // Second failure: the banner stays, the button becomes Retry again and
    // is available.
    await act(async () => {
      second.reject(new ApiRequestError("internal", "Still broken", 500));
    });
    expect(await screen.findByText("Still broken")).toBeInTheDocument();
    expect(screen.getByText("Could not load project")).toBeInTheDocument();
    expect(screen.queryByText("tab body")).not.toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry).not.toHaveAttribute("aria-disabled");
    expect(retry).toHaveFocus();

    // Success: the tab renders and the banner is gone.
    const third = deferred();
    mockGetProject.mockReturnValueOnce(third.promise);
    await userEvent.click(retry);
    expect(screen.getByText("Could not load project")).toBeInTheDocument();
    expect(screen.queryByText("tab body")).not.toBeInTheDocument();
    await act(async () => {
      third.resolve(proj());
    });
    expect(await screen.findByText("tab body")).toBeInTheDocument();
    expect(screen.queryByText("Could not load project")).not.toBeInTheDocument();
    expect(mockGetProject).toHaveBeenCalledTimes(3);
  });

  it.each([
    [401, "unauthorized", "/auth?redirect=%2Fprojects%2Fp-1%2Fmembers"],
    [403, "forbidden", "/projects"],
    [404, "not_found", "/projects"],
  ])("sends a retry that answers %i to %s", async (status, code, expected) => {
    await renderFailingFirstLoad();
    const second = deferred();
    mockGetProject.mockReturnValueOnce(second.promise);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {
      second.reject(new ApiRequestError(code, "nope", status));
    });
    await waitFor(() => expect(nav.router.replace).toHaveBeenCalledWith(expected));
    expect(nav.router.replace).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("tab body")).not.toBeInTheDocument();
  });
});
