/** @vitest-environment jsdom */
/**
 * /tasks/[id] page -- where "close" and "delete" lead. The /tasks list puts
 * its own URL on each task link as `from`; the page returns there when the
 * value passes safeBackHref and falls back to the board otherwise (direct
 * visit, the board modal's "open as full page" link, a crafted or repeated
 * `from`). TaskDetail is stubbed to expose the two callbacks and the back URL
 * the page hands it; the breadcrumb itself is covered in TaskHeader.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Task, User, Team, Project } from "../../src/lib/api";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
  useParams: () => ({ id: "task-1" }),
  usePathname: () => "/tasks/task-1",
  useSearchParams: () => new URLSearchParams(nav.search),
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
  default: (props: { backHref?: string | null; onClose: () => void; onDelete: () => void }) => (
    <div>
      <span data-testid="back-href">{props.backHref ?? "none"}</span>
      <button type="button" onClick={props.onClose}>
        Close
      </button>
      <button type="button" onClick={props.onDelete}>
        Delete
      </button>
    </div>
  ),
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

const BOARD = "/projects/proj-1/board";

beforeEach(() => {
  vi.clearAllMocks();
  nav.search = "";
  vi.mocked(getCurrentUser).mockResolvedValue(USER);
  vi.mocked(getTask).mockResolvedValue(TASK);
  vi.mocked(getProject).mockResolvedValue(PROJECT);
  vi.mocked(getTasks).mockResolvedValue([TASK]);
  vi.mocked(getTeams).mockResolvedValue([TEAM]);
  vi.mocked(getTaskConfidenceDetail).mockResolvedValue(null as never);
});

afterEach(cleanup);

async function renderPage(search: string) {
  nav.search = search;
  render(<TaskDetailPage />);
  await screen.findByRole("button", { name: "Close" });
}

describe("/tasks/[id] -- return path", () => {
  it("close with a valid from returns to the originating list view", async () => {
    await renderPage(`from=${encodeURIComponent("/tasks?scope=open&q=a%20b")}`);
    expect(screen.getByTestId("back-href")).toHaveTextContent("/tasks?scope=open&q=a%20b");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(routerMocks.push).toHaveBeenCalledWith("/tasks?scope=open&q=a%20b");
  });

  it("delete with a valid from also returns to the originating list view", async () => {
    await renderPage(`from=${encodeURIComponent("/tasks?scope=done")}`);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(routerMocks.push).toHaveBeenCalledWith("/tasks?scope=done");
  });

  it("close without a from goes to the board", async () => {
    await renderPage("");
    expect(screen.getByTestId("back-href")).toHaveTextContent("none");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(routerMocks.push).toHaveBeenCalledWith(BOARD);
  });

  it.each([
    ["protocol-relative", "//evil.com"],
    ["absolute URL", "https://evil.com"],
    ["javascript scheme", "javascript:alert(1)"],
    ["another in-app path", "/dashboard"],
    ["path traversal", "/tasks/../x"],
    ["backslash", "/\\evil"],
    ["empty", ""],
  ])("close with an invalid from (%s) goes to the board and never off-site", async (_label, from) => {
    await renderPage(`from=${encodeURIComponent(from)}`);
    expect(screen.getByTestId("back-href")).toHaveTextContent("none");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(routerMocks.push).toHaveBeenCalledTimes(1);
    expect(routerMocks.push).toHaveBeenCalledWith(BOARD);
  });

  it("a repeated from is ambiguous and falls back to the board", async () => {
    await renderPage(
      `from=${encodeURIComponent("/tasks?scope=open")}&from=${encodeURIComponent("//evil.com")}`,
    );
    expect(screen.getByTestId("back-href")).toHaveTextContent("none");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(routerMocks.push).toHaveBeenCalledWith(BOARD);
  });

  it("the old bare list query without from is ignored (board fallback)", async () => {
    await renderPage("scope=open&q=x");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(routerMocks.push).toHaveBeenCalledWith(BOARD));
  });
});
