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
import type { Project } from "../../src/lib/api";

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

vi.mock("../../src/lib/api", () => ({ getProject: vi.fn() }));

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
  it("sends an inaccessible project to the Projects page", async () => {
    mockGetProject.mockRejectedValue(new Error("Access denied"));
    renderLayout("board");
    await waitFor(() => expect(nav.router.replace).toHaveBeenCalledWith("/teams"));
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
