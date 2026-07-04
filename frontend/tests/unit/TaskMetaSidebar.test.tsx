/** @vitest-environment jsdom */
/**
 * TaskMetaSidebar -- admin claim-release controls.
 *
 * Contract under test:
 *   - a non-admin human never sees the admin release affordances, even
 *     when a work or review claim is held by someone else.
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
  } = {},
) {
  const onAdminRelease = overrides.onAdminRelease ?? vi.fn().mockResolvedValue(true);
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
    />,
  );
  return onAdminRelease;
}

describe("TaskMetaSidebar admin work-claim release", () => {
  it("non-admin sees no admin release affordance even when someone else holds the claim", () => {
    renderSidebar(makeTask({ claimedByUserId: "u-2", claimedByUser: { id: "u-2", login: "other", name: "Other Person", avatarUrl: null } }), {
      isProjectAdmin: false,
    });
    expect(screen.getByText("Other Person")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Release (admin)" })).not.toBeInTheDocument();
  });

  it("admin sees Release (admin) on a claim held by someone else, naming the holder in the confirm", async () => {
    const onAdminRelease = renderSidebar(
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
    const onAdminRelease = renderSidebar(
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

  it("non-admin sees the Reviewer name but no release control", () => {
    renderSidebar(
      makeTask({ reviewClaimedByUserId: "u-3", reviewClaimedByUser: { id: "u-3", login: "rev", name: "Reviewer Person", avatarUrl: null } }),
      { isProjectAdmin: false },
    );
    expect(screen.getByText("Reviewer Person")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Release" })).not.toBeInTheDocument();
  });

  it("admin sees a Release control on the review claim, naming the holder, and calls onAdminRelease with releaseReviewClaim", async () => {
    const onAdminRelease = renderSidebar(
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
