/** @vitest-environment jsdom */
/**
 * TaskMetaSidebar -- self-service Release visibility per workflow state.
 *
 * POST /tasks/:id/release answers 409 bad_state in any review state of the
 * task's effective workflow. The server computes that per task
 * (`inReviewState`, pinned workflow included), so the button on the caller's
 * own claim is disabled with a reason when the flag is set, enabled when it
 * is not, and absent when done.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import TaskMetaSidebar from "../../src/components/task-detail/TaskMetaSidebar";
import type { Task, User } from "../../src/lib/api";

const me = { id: "u-1", login: "lan" } as User;

function makeTask(status: string, inReviewState?: boolean): Task {
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
    ...(inReviewState === undefined ? {} : { inReviewState }),
  } as unknown as Task;
}

function renderSidebar(status: string, inReviewState?: boolean) {
  render(
    <TaskMetaSidebar
      task={makeTask(status, inReviewState)}
      user={me}
      confidenceScore={null}
      onRelease={vi.fn()}
      claimBusy={false}
      isProjectAdmin={false}
      onAdminRelease={vi.fn().mockResolvedValue(true)}
      adminReleaseBusy={false}
      onClaimReassigned={vi.fn()}
    />,
  );
}

describe("TaskMetaSidebar self-service Release per state", () => {
  it("is enabled for in_progress without the flag", () => {
    renderSidebar("in_progress");
    expect(screen.getByRole("button", { name: "Release" })).toBeEnabled();
  });

  it("is disabled with a reason in review when the payload carries no flag", () => {
    renderSidebar("review");
    const btn = screen.getByRole("button", { name: "Release" });
    expect(btn).toBeDisabled();
    expect(btn.getAttribute("title")).toMatch(/in review/);
  });

  it("is absent for a done task", () => {
    renderSidebar("done", false);
    expect(screen.queryByRole("button", { name: "Release" })).not.toBeInTheDocument();
  });

  it("pinned workflow: a custom review-like state with the flag set disables Release", () => {
    renderSidebar("qa", true);
    const btn = screen.getByRole("button", { name: "Release" });
    expect(btn).toBeDisabled();
    expect(btn.getAttribute("title")).toMatch(/in review/);
  });

  it("pinned workflow: a task literally named review but with the flag unset keeps Release enabled", () => {
    renderSidebar("review", false);
    expect(screen.getByRole("button", { name: "Release" })).toBeEnabled();
  });

  it("pinned workflow: a work state with the flag unset stays enabled", () => {
    renderSidebar("doing", false);
    expect(screen.getByRole("button", { name: "Release" })).toBeEnabled();
  });
});
