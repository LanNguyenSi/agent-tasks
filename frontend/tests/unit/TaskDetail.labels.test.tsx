/** @vitest-environment jsdom */
/**
 * TaskDetail must wire TaskMetaSidebar's onUpdateLabels to the real
 * updateTask PATCH call (handleUpdateLabels), with isProjectWrite gating
 * whether the editor renders at all. Guards the WIRING (TaskMetaSidebar's
 * own add/remove behavior is covered in TaskMetaSidebar.test.tsx) -- a
 * regression here would mean the editor calls nothing, or a non-write
 * viewer sees it anyway.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const updateTaskMock = vi.fn();

vi.mock("../../src/lib/api", () => ({
  updateTask: (...args: unknown[]) => updateTaskMock(...args),
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
  adminReleaseClaim: vi.fn(),
  uploadTaskAttachmentFile: vi.fn(),
  deleteTaskAttachment: vi.fn(),
  listTaskArtifacts: vi.fn(),
  getTaskArtifact: vi.fn(),
  deleteTaskArtifact: vi.fn(),
  ApiRequestError: class ApiRequestError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  rawAttachmentUrl: (taskId: string, attId: string) =>
    `http://api.test/api/tasks/${taskId}/attachments/${attId}/raw`,
}));

import TaskDetail from "../../src/components/TaskDetail";
import type { Task, User } from "../../src/lib/api";

afterEach(() => {
  cleanup();
  updateTaskMock.mockReset();
});

const VIEWER: User = {
  id: "user-1",
  login: "viewer",
  name: "Viewer",
  avatarUrl: null,
  email: null,
  githubConnected: false,
  allowAgentPrCreate: false,
  allowAgentPrMerge: false,
  allowAgentPrComment: false,
};

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
    labels: ["frontend"],
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
  user: VIEWER,
  templateFields: null,
  confidenceThreshold: 60,
  enforcementMode: null,
  onUpdate: () => {},
  onDelete: () => {},
  onClose: () => {},
  onError: () => {},
};

describe("TaskDetail labels editor wiring", () => {
  it("a write-capable human adding a label calls updateTask(id, { labels }) via handleUpdateLabels", async () => {
    updateTaskMock.mockResolvedValue({ ...makeTask(), labels: ["frontend", "needs-operator"] });

    render(<TaskDetail task={makeTask()} {...baseProps} isProjectWrite={true} />);

    const input = screen.getByLabelText("Add label");
    await userEvent.type(input, "needs-operator");
    await userEvent.click(screen.getByRole("button", { name: /^Add/ }));

    expect(updateTaskMock).toHaveBeenCalledWith("task-1", { labels: ["frontend", "needs-operator"] });
  });

  it("a non-write viewer sees no label editor (no Add label input)", () => {
    render(<TaskDetail task={makeTask()} {...baseProps} isProjectWrite={false} />);
    expect(screen.queryByLabelText("Add label")).not.toBeInTheDocument();
  });

  // Guards handleUpdateLabels's own success/failure signal (distinct from
  // TaskMetaSidebar's local `if (ok)` guard, covered in
  // TaskMetaSidebar.test.tsx): a rejected updateTask must make
  // handleUpdateLabels resolve false, not true, or the typed draft would
  // be cleared even though the save failed.
  it("keeps the typed draft when the real updateTask call rejects", async () => {
    updateTaskMock.mockRejectedValue(new Error("network error"));
    const onError = vi.fn();

    render(<TaskDetail task={makeTask()} {...baseProps} isProjectWrite={true} onError={onError} />);

    const input = screen.getByLabelText("Add label") as HTMLInputElement;
    await userEvent.type(input, "needs-operator");
    await userEvent.click(screen.getByRole("button", { name: /^Add/ }));

    expect(updateTaskMock).toHaveBeenCalledWith("task-1", { labels: ["frontend", "needs-operator"] });
    expect(onError).toHaveBeenCalled();
    expect(input.value).toBe("needs-operator");
  });
});
