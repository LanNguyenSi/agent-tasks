/** @vitest-environment jsdom */
/**
 * TaskMetaSidebar -- admin claim-release controls.
 *
 * Contract under test:
 *   - a non-admin human sees the admin release affordances DISABLED with a
 *     reason (never hidden), when a work or review claim is held by someone
 *     else.
 *   - an admin sees "Release (admin)" on a work claim held by someone else
 *     (or an agent) — not on their OWN claim, which the pre-existing
 *     self-service "Release" button already covers.
 *   - an admin sees a "Reviewer" row + "Release" control when a review
 *     claim exists (no self-service equivalent exists for review claims).
 *   - confirming either release calls onAdminRelease with the right body
 *     and the confirm dialog names the current holder.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import TaskMetaSidebar from "../../src/components/task-detail/TaskMetaSidebar";
import type { Task, User } from "../../src/lib/api";

const me = { id: "u-1", login: "lan" } as User;

function makeTask(over: Partial<Task>): Task {
  return {
    id: "t-1",
    projectId: "p-1",
    title: "A task",
    description: null,
    status: "in_progress",
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

function renderSidebar(
  task: Task,
  overrides: {
    isProjectAdmin?: boolean;
    onAdminRelease?: (opts: { releaseWorkClaim?: boolean; releaseReviewClaim?: boolean }) => Promise<boolean>;
    adminReleaseBusy?: boolean;
    canEditLabels?: boolean;
    projectLabels?: string[];
    onUpdateLabels?: (labels: string[]) => Promise<boolean>;
    labelsBusy?: boolean;
  } = {},
) {
  const onAdminRelease = overrides.onAdminRelease ?? vi.fn().mockResolvedValue(true);
  const onUpdateLabels = overrides.onUpdateLabels ?? vi.fn().mockResolvedValue(true);
  render(
    <TaskMetaSidebar
      task={task}
      user={me}
      confidenceScore={null}
      onClaim={vi.fn()}
      onRelease={vi.fn()}
      claimBusy={false}
      isProjectAdmin={overrides.isProjectAdmin ?? false}
      onAdminRelease={onAdminRelease}
      adminReleaseBusy={overrides.adminReleaseBusy ?? false}
      canEditLabels={overrides.canEditLabels ?? false}
      projectLabels={overrides.projectLabels ?? []}
      onUpdateLabels={onUpdateLabels}
      labelsBusy={overrides.labelsBusy ?? false}
    />,
  );
  return { onAdminRelease, onUpdateLabels };
}

describe("TaskMetaSidebar admin work-claim release", () => {
  it("non-admin sees the admin release control DISABLED with a reason, not hidden", () => {
    renderSidebar(makeTask({ claimedByUserId: "u-2", claimedByUser: { id: "u-2", login: "other", name: "Other Person", avatarUrl: null } }), {
      isProjectAdmin: false,
    });
    expect(screen.getByText("Other Person")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "Release (admin)" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute(
      "title",
      "Only project admins can release another actor's claim",
    );
  });

  it("admin sees Release (admin) on a claim held by someone else, naming the holder in the confirm", async () => {
    const { onAdminRelease } = renderSidebar(
      makeTask({
        claimedByUserId: "u-2",
        claimedByUser: { id: "u-2", login: "other", name: "Other Person", avatarUrl: null },
      }),
      { isProjectAdmin: true },
    );

    await userEvent.click(screen.getByRole("button", { name: "Release (admin)" }));
    expect(await screen.findByText(/Other Person currently holds the work claim/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Release" }));
    expect(onAdminRelease).toHaveBeenCalledWith({ releaseWorkClaim: true });
  });

  it("admin does not see an admin release control on their OWN claim (self-service Release already covers it)", () => {
    renderSidebar(
      makeTask({ claimedByUserId: "u-1", claimedByUser: { id: "u-1", login: "lan", name: "Lan", avatarUrl: null } }),
      { isProjectAdmin: true },
    );
    expect(screen.getByRole("button", { name: "Release" })).toBeInTheDocument(); // self-service
    expect(screen.queryByRole("button", { name: "Release (admin)" })).not.toBeInTheDocument();
  });

  it("admin sees Release (admin) on an agent-held claim (no self-service release exists for agent claims)", async () => {
    const { onAdminRelease } = renderSidebar(
      makeTask({ claimedByAgentId: "agent-1", claimedByAgent: { id: "agent-1", name: "builder-bot" } }),
      { isProjectAdmin: true },
    );
    await userEvent.click(screen.getByRole("button", { name: "Release (admin)" }));
    expect(await screen.findByText(/Agent builder-bot currently holds the work claim/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Release" }));
    expect(onAdminRelease).toHaveBeenCalledWith({ releaseWorkClaim: true });
  });
});

describe("TaskMetaSidebar admin review-claim release", () => {
  it("renders no Reviewer row when there is no review claim", () => {
    renderSidebar(makeTask({}), { isProjectAdmin: true });
    expect(screen.queryByText("Reviewer")).not.toBeInTheDocument();
  });

  it("non-admin sees the Reviewer name and a DISABLED release control (not hidden)", () => {
    renderSidebar(
      makeTask({ reviewClaimedByUserId: "u-3", reviewClaimedByUser: { id: "u-3", login: "rev", name: "Reviewer Person", avatarUrl: null } }),
      { isProjectAdmin: false },
    );
    expect(screen.getByText("Reviewer Person")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "Release" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute(
      "title",
      "Only project admins can release another actor's claim",
    );
  });

  it("admin sees a Release control on the review claim, naming the holder, and calls onAdminRelease with releaseReviewClaim", async () => {
    const { onAdminRelease } = renderSidebar(
      makeTask({
        status: "review",
        reviewClaimedByUserId: "u-3",
        reviewClaimedByUser: { id: "u-3", login: "rev", name: "Reviewer Person", avatarUrl: null },
      }),
      { isProjectAdmin: true },
    );

    await userEvent.click(screen.getByRole("button", { name: "Release" }));
    expect(await screen.findByText(/Reviewer Person currently holds the review claim/)).toBeInTheDocument();

    // The row's own "Release" button is still in the DOM behind the dialog,
    // so scope to the dialog to disambiguate the two same-labeled buttons.
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Release" }));
    expect(onAdminRelease).toHaveBeenCalledWith({ releaseReviewClaim: true });
  });

  it("falls back to a truncated id when no resolved reviewer user/agent is present", () => {
    renderSidebar(makeTask({ reviewClaimedByUserId: "abcdef1234567890" }), { isProjectAdmin: true });
    expect(screen.getByText(/User abcdef12/)).toBeInTheDocument();
  });
});

describe("TaskMetaSidebar labels editor", () => {
  it("a non-write viewer with no labels sees no Labels row at all", () => {
    renderSidebar(makeTask({ labels: [] }), { canEditLabels: false });
    expect(screen.queryByText("Labels")).not.toBeInTheDocument();
  });

  it("a non-write viewer with existing labels sees the badges read-only, no editor", () => {
    renderSidebar(makeTask({ labels: ["easy-pick"] }), { canEditLabels: false });
    expect(screen.getByText("Labels")).toBeInTheDocument();
    expect(screen.getByText("easy-pick")).toBeInTheDocument();
    expect(screen.queryByLabelText("Add label")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Remove label/)).not.toBeInTheDocument();
  });

  // Mutation probe: this asserts the component actually calls the
  // onUpdateLabels callback (the abstraction over PATCH /tasks/:id in
  // TaskDetail.tsx) with the right payload, not just that some local state
  // updates. Verified by temporarily neutering handleAddLabel's call to
  // onUpdateLabels in TaskMetaSidebar.tsx (commenting out the
  // `onUpdateLabels([...])` call) and re-running this file: this test goes
  // red because onUpdateLabels is never called, confirming the test would
  // catch that mutation. Restored afterward.
  it("a write-capable human can add a label, calling onUpdateLabels with the full new array", async () => {
    const { onUpdateLabels } = renderSidebar(makeTask({ labels: ["frontend"] }), {
      canEditLabels: true,
    });
    const input = screen.getByLabelText("Add label");
    await userEvent.type(input, "needs-operator");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onUpdateLabels).toHaveBeenCalledWith(["frontend", "needs-operator"]);
  });

  it("trims surrounding whitespace before calling onUpdateLabels", async () => {
    const { onUpdateLabels } = renderSidebar(makeTask({ labels: [] }), {
      canEditLabels: true,
    });
    const input = screen.getByLabelText("Add label");
    await userEvent.type(input, "  needs-operator  ");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onUpdateLabels).toHaveBeenCalledWith(["needs-operator"]);
  });

  it("rejects a duplicate label case-insensitively, naming the existing variant, without calling onUpdateLabels", async () => {
    const { onUpdateLabels } = renderSidebar(makeTask({ labels: ["Frontend"] }), {
      canEditLabels: true,
    });
    const input = screen.getByLabelText("Add label");
    await userEvent.type(input, "frontend");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(
      await screen.findByText('That label is already on this task (as "Frontend").'),
    ).toBeInTheDocument();
    expect(onUpdateLabels).not.toHaveBeenCalled();
  });

  it("keeps the typed draft in the input when onUpdateLabels resolves false (save failed)", async () => {
    const onUpdateLabels = vi.fn().mockResolvedValue(false);
    renderSidebar(makeTask({ labels: [] }), { canEditLabels: true, onUpdateLabels });
    const input = screen.getByLabelText("Add label") as HTMLInputElement;
    await userEvent.type(input, "needs-operator");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onUpdateLabels).toHaveBeenCalledWith(["needs-operator"]);
    expect(input.value).toBe("needs-operator");
  });

  it("disables the input, Add, and every Remove button while labelsBusy", () => {
    renderSidebar(makeTask({ labels: ["frontend", "ui"] }), {
      canEditLabels: true,
      labelsBusy: true,
    });
    expect(screen.getByLabelText("Add label")).toBeDisabled();
    // The Add button renders a "Loading" sr-only suffix while busy (see
    // Button.tsx), so its accessible name is no longer the exact "Add".
    expect(screen.getByRole("button", { name: /^Add/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove label frontend" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove label ui" })).toBeDisabled();
  });

  it("a write-capable human can remove a label, calling onUpdateLabels with it excluded", async () => {
    const { onUpdateLabels } = renderSidebar(makeTask({ labels: ["frontend", "ui"] }), {
      canEditLabels: true,
    });
    await userEvent.click(screen.getByRole("button", { name: "Remove label frontend" }));
    expect(onUpdateLabels).toHaveBeenCalledWith(["ui"]);
  });

  it("rejects an empty label before calling onUpdateLabels, with a visible message", async () => {
    const { onUpdateLabels } = renderSidebar(makeTask({ labels: [] }), { canEditLabels: true });
    const input = screen.getByLabelText("Add label");
    await userEvent.type(input, "   ");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Label cannot be empty.")).toBeInTheDocument();
    expect(onUpdateLabels).not.toHaveBeenCalled();
  });

  it("rejects a label over 100 characters before calling onUpdateLabels, with a visible message", async () => {
    const { onUpdateLabels } = renderSidebar(makeTask({ labels: [] }), { canEditLabels: true });
    const input = screen.getByLabelText("Add label");
    await userEvent.type(input, "a".repeat(101));
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(
      await screen.findByText("Label must be 100 characters or fewer."),
    ).toBeInTheDocument();
    expect(onUpdateLabels).not.toHaveBeenCalled();
  });

  it("rejects a 21st label before calling onUpdateLabels, with a visible message", async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `label-${i}`);
    const { onUpdateLabels } = renderSidebar(makeTask({ labels: twenty }), {
      canEditLabels: true,
    });
    const input = screen.getByLabelText("Add label");
    await userEvent.type(input, "one-too-many");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(
      await screen.findByText("A task can have at most 20 labels."),
    ).toBeInTheDocument();
    expect(onUpdateLabels).not.toHaveBeenCalled();
  });

  it("offers the project's existing labels as datalist suggestions, excluding ones already on the task", () => {
    renderSidebar(makeTask({ labels: ["frontend"] }), {
      canEditLabels: true,
      projectLabels: ["frontend", "ui", "dx"],
    });
    const input = screen.getByLabelText("Add label") as HTMLInputElement;
    const listId = input.getAttribute("list");
    expect(listId).toBeTruthy();
    const options = document.querySelectorAll(`#${listId} option`);
    const values = [...options].map((o) => o.getAttribute("value"));
    expect(values).toEqual(["ui", "dx"]);
  });
});
