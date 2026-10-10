/** @vitest-environment jsdom */
/**
 * TaskMetaSidebar -- self-service Release visibility per workflow state.
 *
 * POST /tasks/:id/release answers 409 bad_state in any review state of the
 * task's effective workflow, so the button on the caller's own claim is
 * disabled with a reason there, enabled elsewhere, and absent when done.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import TaskMetaSidebar from "../../src/components/task-detail/TaskMetaSidebar";
import type { Task, User, WorkflowDefinition } from "../../src/lib/api";

const me = { id: "u-1", login: "lan" } as User;

function makeTask(status: string): Task {
  return {
    id: "t-1",
    projectId: "p-1",
    title: "A task",
    description: null,
    status,
    priority: "MEDIUM",
    labels: [],
    templateData: null,
    dueAt: null,
    branchName: null,
    prUrl: null,
    prNumber: null,
    claimedByUserId: "u-1",
    claimedByAgentId: null,
    claimedByUser: { id: "u-1", login: "lan", name: "Lan", avatarUrl: null },
    claimedByAgent: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
  } as unknown as Task;
}

// Custom workflow whose review-like state is "qa" (not the literal "review").
const customWorkflow: WorkflowDefinition = {
  initialState: "todo",
  states: [
    { name: "todo", label: "Todo", terminal: false },
    { name: "doing", label: "Doing", terminal: false },
    { name: "qa", label: "QA", terminal: false },
    { name: "review", label: "Review", terminal: false },
    { name: "shipped", label: "Shipped", terminal: true },
  ],
  transitions: [
    { from: "todo", to: "doing" },
    { from: "todo", to: "review" },
    { from: "doing", to: "qa" },
    { from: "qa", to: "shipped" },
    { from: "review", to: "shipped" },
  ],
} as WorkflowDefinition;

function renderSidebar(status: string, workflowDefinition?: WorkflowDefinition | null) {
  render(
    <TaskMetaSidebar
      task={makeTask(status)}
      user={me}
      confidenceScore={null}
      onRelease={vi.fn()}
      claimBusy={false}
      isProjectAdmin={false}
      onAdminRelease={vi.fn().mockResolvedValue(true)}
      adminReleaseBusy={false}
      onClaimReassigned={vi.fn()}
      workflowDefinition={workflowDefinition}
    />,
  );
}

describe("TaskMetaSidebar self-service Release per state", () => {
  it("is enabled for in_progress (default workflow, no definition loaded)", () => {
    renderSidebar("in_progress");
    expect(screen.getByRole("button", { name: "Release" })).toBeEnabled();
  });

  it("is disabled with a reason in review when no definition is loaded", () => {
    renderSidebar("review");
    const btn = screen.getByRole("button", { name: "Release" });
    expect(btn).toBeDisabled();
    expect(btn.getAttribute("title")).toMatch(/in review/);
  });

  it("is absent for a done task", () => {
    renderSidebar("done");
    expect(screen.queryByRole("button", { name: "Release" })).not.toBeInTheDocument();
  });

  it("follows the custom workflow: its review-like state disables Release", () => {
    renderSidebar("qa", customWorkflow);
    expect(screen.getByRole("button", { name: "Release" })).toBeDisabled();
  });

  it("follows the custom workflow: a work state stays enabled", () => {
    renderSidebar("doing", customWorkflow);
    expect(screen.getByRole("button", { name: "Release" })).toBeEnabled();
  });

  it("follows the custom workflow: a state named review that is a direct target of the initial state is not review-like", () => {
    renderSidebar("review", customWorkflow);
    expect(screen.getByRole("button", { name: "Release" })).toBeEnabled();
  });
});
