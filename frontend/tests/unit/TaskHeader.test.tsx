/** @vitest-environment jsdom */
/**
 * TaskHeader -- gated workflow transition buttons + admin status override.
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
 *
 * Admin status-override contract:
 *   - non-admin: the override control renders disabled with an inline
 *     reason (never hidden).
 *   - admin: picking a target and confirming calls onOverrideStatus(target).
 *   - a "blocked" result (422 precondition_failed) renders the failing
 *     rules inline plus a force-override affordance; confirming with a
 *     forceReason retries onOverrideStatus(target, {force:true, forceReason}).
 *   - the force-confirm button stays disabled until the reason clears the
 *     10-character minimum.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import TaskHeader, { type StatusOverrideResult } from "../../src/components/task-detail/TaskHeader";
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

function renderHeader(
  task: Task,
  onAdvance = vi.fn(),
  advanceBusy = false,
  overrides: {
    isProjectAdmin?: boolean;
    statusOverrideTargets?: string[] | null;
    onOverrideStatus?: (
      target: string,
      options?: { force?: boolean; forceReason?: string },
    ) => Promise<StatusOverrideResult>;
  } = {},
) {
  render(
    <TaskHeader
      task={task}
      user={me}
      variant="modal"
      isEditing={false}
      advanceBusy={advanceBusy}
      onStartEditing={vi.fn()}
      onAdvance={onAdvance}
      onDeleteRequest={vi.fn()}
      onScrollToReview={vi.fn()}
      isProjectAdmin={overrides.isProjectAdmin ?? false}
      statusOverrideTargets={overrides.statusOverrideTargets ?? null}
      onOverrideStatus={overrides.onOverrideStatus ?? vi.fn().mockResolvedValue({ kind: "success" })}
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

  it("prUrl without prNumber does not enable the gated actions and explains why", () => {
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
    expect(screen.getByRole("button", { name: "Move to Review" })).toBeDisabled();
    expect(
      screen.getByText(/canonical github\.com\/owner\/repo\/pull\/N form/),
    ).toBeInTheDocument();
  });

  it("disables every transition while an advance is in flight", () => {
    renderHeader(
      makeTask({
        status: "in_progress",
        claimedByUserId: "u-1",
        branchName: "fix/x",
        prUrl: "https://github.com/o/r/pull/9",
        prNumber: 9,
      }),
      vi.fn(),
      true,
    );
    expect(screen.getByRole("button", { name: "Mark done" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move to Review" })).toBeDisabled();
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

describe("TaskHeader admin status override", () => {
  beforeEach(() => {
    // jsdom does not implement scrollIntoView; the Select listbox calls it
    // to keep the active option visible.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("non-admin sees the override control disabled with an inline reason", () => {
    renderHeader(makeTask({ status: "open" }), vi.fn(), false, { isProjectAdmin: false });
    expect(screen.getByRole("button", { name: "Change status" })).toBeDisabled();
    expect(
      screen.getByText("Only project admins can override task status"),
    ).toBeInTheDocument();
    // Not hidden: a non-admin still sees the control exists, just disabled.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("admin sees an enabled status picker and confirming calls onOverrideStatus with the target", async () => {
    const onOverrideStatus = vi.fn().mockResolvedValue({ kind: "success" } satisfies StatusOverrideResult);
    renderHeader(makeTask({ status: "open" }), vi.fn(), false, {
      isProjectAdmin: true,
      onOverrideStatus,
    });

    expect(screen.queryByText("Only project admins can override task status")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "Done" }));
    await userEvent.click(screen.getByRole("button", { name: "Set status" }));

    expect(onOverrideStatus).toHaveBeenCalledWith("done", undefined);
  });

  it("a 422 blocked result renders the failing rules and a force-override affordance", async () => {
    const onOverrideStatus = vi.fn().mockResolvedValue({
      kind: "blocked",
      message: "Transition blocked — PR must be present.",
      failed: [{ rule: "prPresent", message: "PR must be present." }],
      canForce: true,
    } satisfies StatusOverrideResult);
    renderHeader(makeTask({ status: "in_progress" }), vi.fn(), false, {
      isProjectAdmin: true,
      onOverrideStatus,
    });

    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "Review" }));
    await userEvent.click(screen.getByRole("button", { name: "Set status" }));

    expect(await screen.findByText("Transition blocked — PR must be present.")).toBeInTheDocument();
    expect(screen.getByText("PR must be present.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Override anyway…" })).toBeInTheDocument();
  });

  it("confirming the force form with a reason retries with force:true and the trimmed reason", async () => {
    const onOverrideStatus = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "blocked",
        message: "Transition blocked — PR must be present.",
        failed: [{ rule: "prPresent", message: "PR must be present." }],
        canForce: true,
      } satisfies StatusOverrideResult)
      .mockResolvedValueOnce({ kind: "success" } satisfies StatusOverrideResult);

    renderHeader(makeTask({ status: "in_progress" }), vi.fn(), false, {
      isProjectAdmin: true,
      onOverrideStatus,
    });

    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "Review" }));
    await userEvent.click(screen.getByRole("button", { name: "Set status" }));
    await screen.findByRole("button", { name: "Override anyway…" });

    await userEvent.click(screen.getByRole("button", { name: "Override anyway…" }));

    const confirmButton = screen.getByRole("button", { name: "Confirm override" });
    expect(confirmButton).toBeDisabled();

    const textarea = screen.getByLabelText("Reason for override");
    await userEvent.type(textarea, "short"); // 5 chars, below the 10-char minimum
    expect(confirmButton).toBeDisabled();

    await userEvent.type(textarea, " enough now");
    expect(confirmButton).toBeEnabled();

    await userEvent.click(confirmButton);

    expect(onOverrideStatus).toHaveBeenLastCalledWith("review", {
      force: true,
      forceReason: "short enough now",
    });
  });

  it("constrains the dropdown to the effective-workflow outgoing edges", async () => {
    // in_progress → only review + done are defined edges; open must NOT be
    // offered (picking it would 400 on a non-edge — the dead end this avoids).
    renderHeader(makeTask({ status: "in_progress" }), vi.fn(), false, {
      isProjectAdmin: true,
      statusOverrideTargets: ["review", "done"],
    });
    await userEvent.click(screen.getByRole("combobox"));
    expect(screen.getByRole("option", { name: "Review" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Done" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Open" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "In Progress" })).not.toBeInTheDocument();
  });

  it("renders a note instead of an empty dropdown when the state has no outgoing edges", () => {
    renderHeader(makeTask({ status: "done" }), vi.fn(), false, {
      isProjectAdmin: true,
      statusOverrideTargets: [],
    });
    expect(
      screen.getByText("No status changes are defined from this state in the workflow."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set status" })).not.toBeInTheDocument();
  });

  it("a non-forceable blocked result (e.g. a 400 non-edge) is shown inline as 'cannot be forced', not a dead-end toast", async () => {
    const onOverrideStatus = vi.fn().mockResolvedValue({
      kind: "blocked",
      message: "Transition from 'open' to 'done' is not allowed by workflow",
      failed: [],
      canForce: false,
    } satisfies StatusOverrideResult);
    renderHeader(makeTask({ status: "open" }), vi.fn(), false, {
      isProjectAdmin: true,
      // base-4 fallback (targets null) so "Done" is offered and the handler
      // decides it is a non-edge; the result is surfaced inline.
      onOverrideStatus,
    });

    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "Done" }));
    await userEvent.click(screen.getByRole("button", { name: "Set status" }));

    expect(
      await screen.findByText("Transition from 'open' to 'done' is not allowed by workflow"),
    ).toBeInTheDocument();
    expect(screen.getByText("This transition cannot be forced.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Override anyway…" })).not.toBeInTheDocument();
  });
});
