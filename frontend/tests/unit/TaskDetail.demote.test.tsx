/** @vitest-environment jsdom */
/**
 * TaskDetail wiring for "Move to backlog" (demote): clicking the header
 * action PATCHes the task with status "backlog" (api.updateTask) and hands the
 * response to onUpdate so the view reflects it; a rejected request surfaces
 * through onError and does not call onUpdate. The button itself (visibility,
 * claim hint) is covered in TaskHeader.test.tsx.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const apiMocks = vi.hoisted(() => ({ updateTask: vi.fn() }));

vi.mock("../../src/lib/api", () => ({
  updateTask: apiMocks.updateTask,
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
  rawAttachmentUrl: (taskId: string, attId: string) =>
    `http://api.test/api/tasks/${taskId}/attachments/${attId}/raw`,
}));

import TaskDetail from "../../src/components/TaskDetail";
import type { Task, User } from "../../src/lib/api";

afterEach(cleanup);
beforeEach(() => {
  apiMocks.updateTask.mockReset();
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
    title: "Promoted by mistake",
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

function props(over: Record<string, unknown> = {}) {
  return {
    tasks: [] as Task[],
    user: VIEWER,
    templateFields: null,
    confidenceThreshold: 60,
    enforcementMode: null,
    isProjectAdmin: false,
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn(),
    ...over,
  };
}

describe("TaskDetail -- Move to backlog", () => {
  it("clicking it PATCHes status backlog and passes the updated task to onUpdate", async () => {
    const updated = makeTask({ status: "backlog" });
    apiMocks.updateTask.mockResolvedValue(updated);
    const p = props();
    render(<TaskDetail task={makeTask()} {...p} />);

    await userEvent.click(screen.getByRole("button", { name: "Move to backlog" }));

    await waitFor(() => expect(p.onUpdate).toHaveBeenCalledWith(updated));
    expect(apiMocks.updateTask).toHaveBeenCalledTimes(1);
    expect(apiMocks.updateTask).toHaveBeenCalledWith("task-1", { status: "backlog" });
    expect(p.onError).not.toHaveBeenCalled();
  });

  it("a rejected request (e.g. 409 because a claim landed first) goes to onError, not onUpdate", async () => {
    apiMocks.updateTask.mockRejectedValue(new Error("Task state changed before the request completed"));
    const p = props();
    render(<TaskDetail task={makeTask()} {...p} />);

    await userEvent.click(screen.getByRole("button", { name: "Move to backlog" }));

    await waitFor(() =>
      expect(p.onError).toHaveBeenCalledWith("Task state changed before the request completed"),
    );
    expect(p.onUpdate).not.toHaveBeenCalled();
  });

  it("a claimed open task shows the action disabled and never calls the API", async () => {
    const p = props();
    render(<TaskDetail task={makeTask({ claimedByAgentId: "agent-1" })} {...p} />);

    const button = screen.getByRole("button", { name: "Move to backlog" });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(apiMocks.updateTask).not.toHaveBeenCalled();
  });
});
