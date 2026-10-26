/** @vitest-environment jsdom */
/**
 * /tasks page frame: in every state (loading skeleton, boot error, no team,
 * loaded list) the page renders exactly one <main> whose content slot is the
 * wide, flush variant, so the header band, scope tabs and table share the
 * page's left edge and the table is not held to a 1200px column.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { Project, Team, User } from "../../src/lib/api";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/tasks",
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  getProjects: vi.fn(),
  getTeamTasks: vi.fn(),
  updateTask: vi.fn(),
}));

vi.mock("../../src/components/tasks/NewTaskFlow", () => ({ default: () => null }));

import TasksPage from "../../src/app/tasks/page";
import { getCurrentUser, getProjects, getTeams, getTeamTasks } from "../../src/lib/api";

const USER = { id: "u-1", login: "lan" } as User;
const TEAM = { id: "t1", name: "Pandora", slug: "pandora", role: "ADMIN", createdAt: "x" } as Team;
const SHARED = { id: "p3", name: "Shared Project" } as Project;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue(USER);
  vi.mocked(getTeams).mockResolvedValue([TEAM]);
  vi.mocked(getProjects).mockResolvedValue([]);
  vi.mocked(getTeamTasks).mockResolvedValue({
    tasks: [],
    projects: [],
    counts: { open: 0, review: 0, done: 0, priority: 0, mine: 0, total: 0 },
    filteredTotal: 0,
  } as never);
});
afterEach(cleanup);

/** The one <main>, and its content slot must be wide + flush (not the 1200px default). */
function expectWideFlushFrame(): HTMLElement {
  const mains = screen.getAllByRole("main");
  expect(mains).toHaveLength(1);
  const main = mains[0]!;
  const slots = main.querySelectorAll(":scope > .pshell-content");
  expect(slots).toHaveLength(1);
  const slot = slots[0]!;
  expect(slot).toHaveClass("pshell-content--wide", "pshell-content--flush");
  expect(slot).not.toHaveClass("pshell-content--default");
  expect(slot).not.toHaveClass("pshell-content--narrow");
  return main;
}

describe("/tasks page frame", () => {
  it("loading skeleton: one busy <main> with the wide, flush slot", () => {
    vi.mocked(getCurrentUser).mockReturnValue(new Promise(() => {}));
    render(<TasksPage />);
    const main = expectWideFlushFrame();
    expect(main).toHaveAttribute("aria-busy", "true");
  });

  it("boot error: one <main> with the wide, flush slot", async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new Error("boom"));
    render(<TasksPage />);
    expect(await screen.findByText("boom")).toBeInTheDocument();
    const main = expectWideFlushFrame();
    expect(main).not.toHaveAttribute("aria-busy");
  });

  it("no team: one <main> with the wide, flush slot", async () => {
    vi.mocked(getTeams).mockResolvedValue([]);
    vi.mocked(getProjects).mockResolvedValue([SHARED]);
    render(<TasksPage />);
    expect(await screen.findByText("Cross-project tasks need a team.")).toBeInTheDocument();
    expectWideFlushFrame();
  });

  it("loaded list: one <main> with the wide, flush slot holding the header and tabs", async () => {
    render(<TasksPage />);
    const heading = await screen.findByRole("heading", { level: 1 });
    const main = expectWideFlushFrame();
    expect(main).toContainElement(heading);
    expect(main).not.toHaveAttribute("aria-busy");
  });
});
