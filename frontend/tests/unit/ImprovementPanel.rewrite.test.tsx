/** @vitest-environment jsdom */
/**
 * M4 (task fc4f2dc7): the ImprovementPanel's opt-in "Suggest improvement"
 * (LLM rewrite) button + diff modal. ADR-0011: advisory only -- nothing is
 * applied until the user reviews the before/after diff and clicks Apply.
 *
 * `suggestTaskRewrite` / `updateTask` (lib/api.ts) are mocked; no real
 * network or LLM call happens in this suite. The findings/next-actions
 * rendering itself is covered by ImprovementPanel.test.tsx -- this file is
 * scoped to the new button/modal/apply flow only.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const apiMocks = vi.hoisted(() => ({
  suggestTaskRewrite: vi.fn(),
  updateTask: vi.fn(),
}));

vi.mock("../../src/lib/api", () => ({
  suggestTaskRewrite: apiMocks.suggestTaskRewrite,
  updateTask: apiMocks.updateTask,
}));

import ImprovementPanel from "../../src/components/task-detail/ImprovementPanel";
import type { Task, TaskConfidenceDetail } from "../../src/lib/api";

afterEach(cleanup);

const emptySubscores = {
  completeness: 100,
  concreteness: 100,
  testability: 100,
  scopeClarity: 100,
  contextQuality: 100,
  structure: 100,
  ambiguityRisk: 100,
};

function makeConfidence(over: Partial<TaskConfidenceDetail> = {}): TaskConfidenceDetail {
  return {
    score: 30,
    missing: [],
    threshold: 60,
    effectiveThreshold: 60,
    thresholdSource: "global",
    blocking: false,
    subscores: emptySubscores,
    findings: [
      {
        code: "missing_description",
        severity: "blocking",
        dimension: "completeness",
        message: "Description is empty.",
      },
    ],
    ...over,
  };
}

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    projectId: "proj-1",
    title: "Fix the thing",
    description: "Old description",
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ImprovementPanel — Suggest improvement (M4 LLM rewrite)", () => {
  it("does not render the button when aiHelpersEnabled is false/omitted", () => {
    render(
      <ImprovementPanel
        confidence={makeConfidence()}
        taskId="task-1"
        description="Old description"
        onUpdate={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Suggest improvement" })).not.toBeInTheDocument();
  });

  it("renders the button when aiHelpersEnabled is true, and calls suggestTaskRewrite(taskId) on click", async () => {
    apiMocks.suggestTaskRewrite.mockResolvedValue({
      suggestion: "New description with acceptance criteria.",
      changedSignals: ["missing_description"],
    });
    render(
      <ImprovementPanel
        confidence={makeConfidence()}
        taskId="task-1"
        description="Old description"
        aiHelpersEnabled
        onUpdate={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Suggest improvement" }));

    expect(apiMocks.suggestTaskRewrite).toHaveBeenCalledWith("task-1");
    expect(await screen.findByRole("dialog", { name: "Suggested rewrite" })).toBeInTheDocument();
  });

  it("shows the before/after diff and the changed-signal codes in the modal", async () => {
    apiMocks.suggestTaskRewrite.mockResolvedValue({
      suggestion: "New description with acceptance criteria.",
      changedSignals: ["missing_description"],
    });
    render(
      <ImprovementPanel
        confidence={makeConfidence()}
        taskId="task-1"
        description="Old description"
        aiHelpersEnabled
        onUpdate={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Suggest improvement" }));
    const dialog = await screen.findByRole("dialog", { name: "Suggested rewrite" });

    expect(within(dialog).getByText("Old description")).toBeInTheDocument();
    expect(within(dialog).getByText("New description with acceptance criteria.")).toBeInTheDocument();
    expect(within(dialog).getByText("missing_description")).toBeInTheDocument();
  });

  it("Apply calls updateTask(taskId, { description: suggestion }), then onUpdate and closes the modal", async () => {
    apiMocks.suggestTaskRewrite.mockResolvedValue({
      suggestion: "New description with acceptance criteria.",
      changedSignals: ["missing_description"],
    });
    const updatedTask = makeTask({ description: "New description with acceptance criteria." });
    apiMocks.updateTask.mockResolvedValue(updatedTask);
    const onUpdate = vi.fn();

    render(
      <ImprovementPanel
        confidence={makeConfidence()}
        taskId="task-1"
        description="Old description"
        aiHelpersEnabled
        onUpdate={onUpdate}
        onError={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Suggest improvement" }));
    await screen.findByRole("dialog", { name: "Suggested rewrite" });
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(apiMocks.updateTask).toHaveBeenCalledWith("task-1", {
      description: "New description with acceptance criteria.",
    });
    expect(onUpdate).toHaveBeenCalledWith(updatedTask);
    expect(screen.queryByRole("dialog", { name: "Suggested rewrite" })).not.toBeInTheDocument();
  });

  it("Cancel closes the modal without calling updateTask", async () => {
    apiMocks.suggestTaskRewrite.mockResolvedValue({
      suggestion: "New description",
      changedSignals: [],
    });
    render(
      <ImprovementPanel
        confidence={makeConfidence()}
        taskId="task-1"
        description="Old description"
        aiHelpersEnabled
        onUpdate={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Suggest improvement" }));
    await screen.findByRole("dialog", { name: "Suggested rewrite" });
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(apiMocks.updateTask).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Suggested rewrite" })).not.toBeInTheDocument();
  });

  it("shows an inline error and no modal when suggestTaskRewrite rejects", async () => {
    apiMocks.suggestTaskRewrite.mockRejectedValue(new Error("Project has not enabled AI helpers"));
    render(
      <ImprovementPanel
        confidence={makeConfidence()}
        taskId="task-1"
        description="Old description"
        aiHelpersEnabled
        onUpdate={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Suggest improvement" }));

    expect(await screen.findByText("Project has not enabled AI helpers")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Suggested rewrite" })).not.toBeInTheDocument();
  });

  // Review round-2 finding 10 (optional): a retry after a prior failure
  // must clear the stale inline error, not stack it alongside the new
  // (successful) result.
  it("clears the inline error on a retry that succeeds", async () => {
    apiMocks.suggestTaskRewrite.mockRejectedValueOnce(new Error("Project has not enabled AI helpers"));
    render(
      <ImprovementPanel
        confidence={makeConfidence()}
        taskId="task-1"
        description="Old description"
        aiHelpersEnabled
        onUpdate={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Suggest improvement" }));
    expect(await screen.findByText("Project has not enabled AI helpers")).toBeInTheDocument();

    apiMocks.suggestTaskRewrite.mockResolvedValueOnce({
      suggestion: "New description with acceptance criteria.",
      changedSignals: ["missing_description"],
    });
    await userEvent.click(screen.getByRole("button", { name: "Suggest improvement" }));

    expect(await screen.findByRole("dialog", { name: "Suggested rewrite" })).toBeInTheDocument();
    expect(screen.queryByText("Project has not enabled AI helpers")).not.toBeInTheDocument();
  });

  // Review round-2 finding 10 (optional): a rejected Apply must surface via
  // onError, not fail silently.
  it("calls onError and keeps the modal open when Apply's updateTask rejects", async () => {
    apiMocks.suggestTaskRewrite.mockResolvedValue({
      suggestion: "New description with acceptance criteria.",
      changedSignals: ["missing_description"],
    });
    apiMocks.updateTask.mockRejectedValue(new Error("Task was claimed by someone else"));
    const onError = vi.fn();
    const onUpdate = vi.fn();

    render(
      <ImprovementPanel
        confidence={makeConfidence()}
        taskId="task-1"
        description="Old description"
        aiHelpersEnabled
        onUpdate={onUpdate}
        onError={onError}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Suggest improvement" }));
    await screen.findByRole("dialog", { name: "Suggested rewrite" });
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith("Task was claimed by someone else");
    });
    expect(onUpdate).not.toHaveBeenCalled();
    // Apply failed -- the diff is still there for the user to retry/cancel,
    // not silently dismissed.
    expect(screen.getByRole("dialog", { name: "Suggested rewrite" })).toBeInTheDocument();
  });
});
