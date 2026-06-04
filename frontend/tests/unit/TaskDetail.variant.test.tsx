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
import { updateTask } from "../../src/lib/api";
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

  it("merges existing templateData on save so producer fields are not dropped", async () => {
    const user = userEvent.setup();
    const updatedTask = makeTask({
      templateData: {
        goal: "Tighten matcher",
        taskType: "bugfix",
        producerField: "keep-me",
      } as unknown as Task["templateData"],
    });
    vi.mocked(updateTask).mockResolvedValue(updatedTask);

    render(
      <TaskDetail
        task={updatedTask}
        {...baseProps}
        templateFields={{ goal: true }}
      />,
    );

    await user.keyboard("e");
    const goalInput = screen.getByLabelText("Goal");
    await user.clear(goalInput);
    await user.type(goalInput, "Tighten matcher and logging");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        templateData: expect.objectContaining({
          goal: "Tighten matcher and logging",
          taskType: "bugfix",
          producerField: "keep-me",
        }),
      }),
    );
  });
});
