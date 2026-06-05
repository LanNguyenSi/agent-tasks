/** @vitest-environment jsdom */
/**
 * TaskDetail initialEditing: opening via the create-confidence panel's "Edit
 * task" lands directly in edit mode (editors visible, seeded from the task), so
 * the user can fill the missing fields. A normal open stays in view mode.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

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
  } as Task;
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

describe("TaskDetail — initialEditing", () => {
  it("opens directly in edit mode when initialEditing is set", () => {
    render(<TaskDetail task={makeTask()} {...baseProps} initialEditing />);
    // Edit mode: the title is an editable input seeded from the task, and the
    // edit toolbar's Cancel is present; the view-mode Edit button is gone.
    expect(screen.getByDisplayValue("Fix the thing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("stays in view mode by default (no initialEditing)", () => {
    render(<TaskDetail task={makeTask()} {...baseProps} />);
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Fix the thing")).not.toBeInTheDocument();
  });
});
