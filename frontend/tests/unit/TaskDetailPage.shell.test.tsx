/** @vitest-environment jsdom */
/**
 * /tasks/[id] page frame: loading, error and loaded states each render
 * exactly one <main> on the default (centred 1200px) column whose content
 * slot is flush (the task detail frame, .td-page, owns the gutter), and the
 * loading/error wrappers sit inside it, so every state starts on the same x.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { Task, User, Team, Project } from "../../src/lib/api";
import { expectDocumentTitle } from "./helpers/documentTitle";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
  useParams: () => ({ id: "task-1" }),
  usePathname: () => "/tasks/task-1",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTask: vi.fn(),
  getProject: vi.fn(),
  getTasks: vi.fn(),
  getTeams: vi.fn(),
  getEffectiveWorkflow: vi.fn(),
  getTaskConfidenceDetail: vi.fn(),
  projectCanAdmin: () => false,
  isProjectWriteRole: () => false,
}));

vi.mock("../../src/components/TaskDetail", () => ({
  default: () => <div className="td-page">task body</div>,
}));

import TaskDetailPage from "../../src/app/tasks/[id]/page";
import {
  getCurrentUser,
  getTask,
  getProject,
  getTasks,
  getTeams,
  getTaskConfidenceDetail,
} from "../../src/lib/api";

const USER = { id: "u-1", login: "lan" } as User;
const TASK = { id: "task-1", projectId: "proj-1", title: "A task" } as Task;
const PROJECT = { id: "proj-1", teamId: "team-1", name: "Agent Tasks", accessRole: "MEMBER" } as unknown as Project;
const TEAM = { id: "team-1", name: "Pandora" } as Team;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue(USER);
  vi.mocked(getTask).mockResolvedValue(TASK);
  vi.mocked(getProject).mockResolvedValue(PROJECT);
  vi.mocked(getTasks).mockResolvedValue([TASK]);
  vi.mocked(getTeams).mockResolvedValue([TEAM]);
  vi.mocked(getTaskConfidenceDetail).mockResolvedValue(null as never);
});

afterEach(cleanup);

function expectDefaultFlushFrame(): HTMLElement {
  const mains = screen.getAllByRole("main");
  expect(mains).toHaveLength(1);
  const main = mains[0]!;
  expect(main).toHaveClass("pshell--default");
  expect(main).not.toHaveClass("pshell--wide");
  const slots = main.querySelectorAll(":scope > .pshell-content");
  expect(slots).toHaveLength(1);
  const slot = slots[0]!;
  expect(slot).toHaveClass("pshell-content--default", "pshell-content--flush");
  expect(slot).not.toHaveClass("pshell-content--wide");
  return main;
}

describe("/tasks/[id] page frame", () => {
  it("loading: one <main>, default + flush slot, skeleton inside the loading wrapper", () => {
    vi.mocked(getTask).mockReturnValue(new Promise(() => {}));
    const { container } = render(<TaskDetailPage />);
    const main = expectDefaultFlushFrame();
    expect(main.querySelector(".pshell-content > .td-loading-wrap .td-skeleton")).not.toBeNull();
    expect(container.querySelectorAll("main")).toHaveLength(1);
  });

  it("error: one <main>, default + flush slot, banner inside the error wrapper", async () => {
    vi.mocked(getTask).mockRejectedValue(new Error("Task not found"));
    render(<TaskDetailPage />);
    const banner = await screen.findByText("Task not found");
    const main = expectDefaultFlushFrame();
    expect(banner.closest(".pshell-content > .td-error-wrap")).not.toBeNull();
    expect(main).toContainElement(banner);
  });

  it("loaded: one <main>, default + flush slot holding the task detail frame", async () => {
    render(<TaskDetailPage />);
    const body = await screen.findByText("task body");
    const main = expectDefaultFlushFrame();
    expect(main.querySelector(".pshell-content > .td-page")).toBe(body);
  });
});

describe("/tasks/[id] document title", () => {
  it("reads 'Task - agent-tasks' while loading and '<task title> - agent-tasks' once loaded", async () => {
    render(<TaskDetailPage />);
    await expectDocumentTitle("Task - agent-tasks");
    await screen.findByText("task body");
    // The title is set by a passive effect of the commit that brought the
    // loaded task in, which can run after the DOM update findByText saw.
    await expectDocumentTitle("A task - agent-tasks");
  });
});
