/** @vitest-environment jsdom */
/**
 * TaskDetailModal Escape orchestration — the integration the Modal
 * primitive's unit tests can't cover. TaskDetailModal owns its own
 * document-level Escape handler AND wraps Modal (with closeOnEscape
 * false), so the risk is a double-fire. These tests pin: Escape on a
 * non-editing modal closes it exactly once; pressing it while editing
 * cancels the edit instead of closing.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../src/lib/api", () => ({
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  claimTask: vi.fn(),
  releaseTask: vi.fn(),
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

function renderModal(onClose: () => void) {
  return render(
    <TaskDetail
      task={makeTask()}
      tasks={[makeTask()]}
      user={null}
      templateFields={null}
      confidenceThreshold={60}
      onUpdate={() => {}}
      onDelete={() => {}}
      onClose={onClose}
      onError={() => {}}
    />,
  );
}

describe("TaskDetailModal — Escape orchestration", () => {
  it("closes exactly once on Escape when not editing (no double-fire with Modal)", async () => {
    const onClose = vi.fn();
    renderModal(onClose);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("cancels editing instead of closing when Escape is pressed mid-edit", async () => {
    const onClose = vi.fn();
    renderModal(onClose);
    // Enter edit mode via the 'e' shortcut (no input focused yet).
    await userEvent.keyboard("e");
    expect(await screen.findByText(/Save/i)).toBeInTheDocument();
    // Escape with no unsaved changes exits edit mode without closing.
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });
});
