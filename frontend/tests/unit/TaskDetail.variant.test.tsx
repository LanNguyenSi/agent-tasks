/** @vitest-environment jsdom */
/**
 * TaskDetail variant behaviour. The same component renders inside the
 * board modal (variant="modal", default) and on the full /tasks/[id]
 * page (variant="page"). Pin the differences: the modal exposes a
 * maximize link to the page; the page renders no dialog and no maximize.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../src/lib/api", () => ({
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  claimTask: vi.fn(),
  releaseTask: vi.fn(),
  startTask: vi.fn(),
  createComment: vi.fn(),
  deleteComment: vi.fn(),
  addDependency: vi.fn(),
  removeDependency: vi.fn(),
  reviewTask: vi.fn(),
  transitionTask: vi.fn(),
}));

import TaskDetail from "../../src/components/TaskDetail";
import type { Task } from "../../src/lib/api";

afterEach(cleanup);

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    projectId: "proj-1",
    title: "Fix the thing",
    description: "Some description",
    status: "open",
    priority: "MEDIUM",
    templateData: null,
    claimedByUserId: null,
    claimedByAgentId: null,
    claimedAt: null,
    dueAt: null,
    branchName: null,
    prUrl: null,
    prNumber: null,
    result: null,
    externalRef: null,
    labels: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    attachments: [],
    artifacts: [],
    comments: [],
    blockedBy: [],
    blocks: [],
    ...over,
  };
}

const baseProps = {
  tasks: [] as Task[],
  user: null,
  templateFields: null,
  confidenceThreshold: 60,
  onUpdate: () => {},
  onDelete: () => {},
  onClose: () => {},
  onError: () => {},
};

describe("TaskDetail — variant", () => {
  it("modal variant renders a dialog with a maximize link to /tasks/[id]", () => {
    render(<TaskDetail task={makeTask({ id: "task-9" })} {...baseProps} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const maximize = screen.getByRole("link", { name: "Open as full page" });
    expect(maximize).toHaveAttribute("href", "/tasks/task-9");
  });

  it("hides the maximize link while editing so unsaved edits aren't dropped", async () => {
    render(<TaskDetail task={makeTask({ id: "task-9" })} {...baseProps} />);
    expect(screen.getByRole("link", { name: "Open as full page" })).toBeInTheDocument();
    // 'e' enters edit mode (no input focused yet).
    await userEvent.keyboard("e");
    expect(await screen.findByText(/Save/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open as full page" })).toBeNull();
  });

  it("page variant renders the detail with no dialog and no maximize link", () => {
    render(<TaskDetail variant="page" task={makeTask({ id: "task-9" })} {...baseProps} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("link", { name: "Open as full page" })).toBeNull();
    // The shared detail body still renders (the task title is shown).
    expect(screen.getByText("Fix the thing")).toBeInTheDocument();
  });

  // The admin controls must render in the MODAL variant (the operator's
  // primary surface), gated by isProjectAdmin. These assert the COMPONENT
  // contract for the modal variant; the dashboard-page threading of the prop
  // is verified by typecheck + live operator check (there is no DashboardPage
  // unit harness), so a silent revert of that threading is not caught here.
  it("modal variant shows the admin status-override control when isProjectAdmin", () => {
    render(
      <TaskDetail task={makeTask({ id: "task-9" })} {...baseProps} isProjectAdmin />,
    );
    expect(
      screen.getByRole("combobox", { name: "Change task status (admin override)" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set status" })).toBeInTheDocument();
  });

  it("modal variant shows the override disabled with a reason for a non-admin", () => {
    render(<TaskDetail task={makeTask({ id: "task-9" })} {...baseProps} isProjectAdmin={false} />);
    const btn = screen.getByRole("button", { name: "Change status" });
    expect(btn).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Set status" })).toBeNull();
  });

  it("modal variant shows the admin claim-release control on a claim held by someone else", () => {
    // The other half of the isProjectAdmin-gated capability (TaskMetaSidebar).
    render(
      <TaskDetail
        task={makeTask({
          id: "task-9",
          claimedByUserId: "u-other",
          claimedByUser: { id: "u-other", login: "other", name: "Other Person", avatarUrl: null },
        })}
        {...baseProps}
        isProjectAdmin
      />,
    );
    expect(screen.getByRole("button", { name: "Release (admin)" })).toBeEnabled();
  });
});
