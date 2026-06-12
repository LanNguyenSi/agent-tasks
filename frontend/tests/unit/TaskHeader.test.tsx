/** @vitest-environment jsdom */
/**
 * TaskHeader -- gated workflow transition buttons.
 *
 * Contract under test (human-only UI lifecycle):
 *   - open + unclaimed: a single enabled "Start".
 *   - in_progress claimed by the current user WITHOUT branch/PR: both
 *     "Move to Review" and "Mark done" render disabled with an actionable
 *     hint pointing at the edit form.
 *   - same but WITH branch + PR URL + PR number: both buttons enabled and
 *     clicking fires the matching advance action. prNumber matters: the
 *     backend prPresent gate requires it, so prUrl alone must not enable.
 *   - in_progress claimed by someone else: no transition buttons.
 *   - review: the "Jump to review" affordance.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import TaskHeader from "../../src/components/task-detail/TaskHeader";
import type { Task, User } from "../../src/lib/api";

const me = { id: "u-1", login: "lan" } as User;

function makeTask(over: Partial<Task>): Task {
  return {
    id: "t-1",
    projectId: "p-1",
    title: "A task",
    description: null,
    status: "open",
    priority: "MEDIUM",
    labels: [],
    templateData: null,
    dueAt: null,
    branchName: null,
    prUrl: null,
    prNumber: null,
    claimedByUserId: null,
    claimedByAgentId: null,
    claimedByUser: null,
    claimedByAgent: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
    ...over,
  } as Task;
}

function renderHeader(task: Task, onAdvance = vi.fn()) {
  render(
    <TaskHeader
      task={task}
      user={me}
      variant="modal"
      isEditing={false}
      advanceBusy={false}
      onStartEditing={vi.fn()}
      onAdvance={onAdvance}
      onDeleteRequest={vi.fn()}
      onScrollToReview={vi.fn()}
    />,
  );
  return onAdvance;
}

describe("TaskHeader transitions", () => {
  it("open + unclaimed shows a single enabled Start", () => {
    renderHeader(makeTask({ status: "open" }));
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Move to Review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark done" })).not.toBeInTheDocument();
  });

  it("in_progress claimed by me without artifacts shows both actions disabled with a hint", () => {
    renderHeader(makeTask({ status: "in_progress", claimedByUserId: "u-1" }));
    expect(screen.getByRole("button", { name: "Move to Review" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Mark done" })).toBeDisabled();
    expect(screen.getByText("Record branch and PR URL via Edit first")).toBeInTheDocument();
  });

  it("prUrl without prNumber does not enable the gated actions", () => {
    renderHeader(
      makeTask({
        status: "in_progress",
        claimedByUserId: "u-1",
        branchName: "fix/x",
        prUrl: "https://example.com/some-pr",
        prNumber: null,
      }),
    );
    expect(screen.getByRole("button", { name: "Mark done" })).toBeDisabled();
  });

  it("with branch + PR recorded, both actions enable and fire the right advance", async () => {
    const onAdvance = renderHeader(
      makeTask({
        status: "in_progress",
        claimedByUserId: "u-1",
        branchName: "fix/x",
        prUrl: "https://github.com/o/r/pull/9",
        prNumber: 9,
      }),
    );
    const review = screen.getByRole("button", { name: "Move to Review" });
    const done = screen.getByRole("button", { name: "Mark done" });
    expect(review).toBeEnabled();
    expect(done).toBeEnabled();
    expect(screen.queryByText("Record branch and PR URL via Edit first")).not.toBeInTheDocument();

    await userEvent.click(done);
    expect(onAdvance).toHaveBeenLastCalledWith("mark_done");
    await userEvent.click(review);
    expect(onAdvance).toHaveBeenLastCalledWith("submit_review");
  });

  it("in_progress claimed by someone else shows no transition buttons", () => {
    renderHeader(makeTask({ status: "in_progress", claimedByUserId: "u-2" }));
    expect(screen.queryByRole("button", { name: "Move to Review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark done" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
  });

  it("review state shows the jump affordance", () => {
    renderHeader(makeTask({ status: "review", claimedByUserId: "u-1" }));
    expect(screen.getByRole("button", { name: "Jump to review" })).toBeInTheDocument();
  });
});
