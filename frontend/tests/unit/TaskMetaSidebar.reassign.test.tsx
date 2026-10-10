/** @vitest-environment jsdom */
/**
 * TaskMetaSidebar -- admin claim reassign picker.
 *
 * Contract under test:
 *   - a human project admin sees a Reassign control on a held work claim and
 *     on a review claim; picking an eligible actor calls adminReassignClaim
 *     with the right claim and target and hands the updated task back.
 *   - the current holder is not offered as a target.
 *   - a 403 and a 409 from the server are shown with the server's message and
 *     leave the picker open; a 403 while loading the candidates is shown too.
 *   - the picker is hidden (not disabled) for non-admins, for a missing
 *     (non-human) user and on a finished task.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const apiMocks = vi.hoisted(() => ({
  getEligibleActors: vi.fn(),
  adminReassignClaim: vi.fn(),
}));

vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  getEligibleActors: apiMocks.getEligibleActors,
  adminReassignClaim: apiMocks.adminReassignClaim,
}));

import TaskMetaSidebar from "../../src/components/task-detail/TaskMetaSidebar";
import { ApiRequestError, type Task, type User } from "../../src/lib/api";

const me = { id: "u-1", login: "lan" } as User;

const actors = {
  humans: [
    { userId: "u-1", name: "Lan", source: "team", role: "ADMIN" },
    { userId: "u-2", name: "Other Person", source: "team", role: "HUMAN_MEMBER" },
    { userId: "u-4", name: "Guest Dev", source: "project", role: "PROJECT_CONTRIBUTOR" },
  ],
  agents: [{ tokenId: "agent-9", name: "builder-bot" }],
};

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
    claimedByUserId: "u-2",
    claimedByAgentId: null,
    claimedByUser: { id: "u-2", login: "other", name: "Other Person", avatarUrl: null },
    claimedByAgent: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
    ...over,
  } as Task;
}

function renderSidebar(
  task: Task,
  overrides: { isProjectAdmin?: boolean; user?: User | null; onClaimReassigned?: (task: Task) => void } = {},
) {
  const onClaimReassigned = overrides.onClaimReassigned ?? vi.fn();
  render(
    <TaskMetaSidebar
      task={task}
      user={overrides.user === undefined ? me : overrides.user}
      confidenceScore={null}
      onRelease={vi.fn()}
      claimBusy={false}
      isProjectAdmin={overrides.isProjectAdmin ?? true}
      onAdminRelease={vi.fn().mockResolvedValue(true)}
      adminReleaseBusy={false}
      onClaimReassigned={onClaimReassigned}
    />,
  );
  return { onClaimReassigned };
}

async function openAndPick(label: RegExp | string, claimName: string) {
  await userEvent.click(screen.getByRole("button", { name: "Reassign work claim" }));
  const combobox = await screen.findByRole("combobox", { name: claimName });
  await userEvent.click(combobox);
  await userEvent.click(await screen.findByRole("option", { name: label }));
}

beforeEach(() => {
  // jsdom does not implement scrollIntoView; the Select listbox calls it.
  Element.prototype.scrollIntoView = vi.fn();
  apiMocks.getEligibleActors.mockReset();
  apiMocks.adminReassignClaim.mockReset();
  apiMocks.getEligibleActors.mockResolvedValue(actors);
});

describe("TaskMetaSidebar claim reassign picker", () => {
  it("reassigns the work claim to a chosen human and hands the updated task back", async () => {
    const updated = makeTask({ claimedByUserId: "u-4" });
    apiMocks.adminReassignClaim.mockResolvedValue({
      task: updated,
      reassigned: { claim: "work", priorHolder: { type: "human", id: "u-2" }, newHolder: { type: "human", id: "u-4" } },
    });
    const { onClaimReassigned } = renderSidebar(makeTask({}));

    await openAndPick(/Guest Dev/, "Reassign work claim to");
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));

    expect(apiMocks.getEligibleActors).toHaveBeenCalledWith("p-1");
    expect(apiMocks.adminReassignClaim).toHaveBeenCalledWith("t-1", { claim: "work", target: { type: "human", id: "u-4" } });
    expect(onClaimReassigned).toHaveBeenCalledWith(updated);
    expect(screen.queryByRole("combobox", { name: "Reassign work claim to" })).not.toBeInTheDocument();
  });

  it("reassigns the review claim to an agent", async () => {
    const task = makeTask({
      status: "review",
      reviewClaimedByUserId: "u-3",
      reviewClaimedByUser: { id: "u-3", login: "rev", name: "Reviewer Person", avatarUrl: null },
    });
    apiMocks.adminReassignClaim.mockResolvedValue({
      task,
      reassigned: { claim: "review", priorHolder: { type: "human", id: "u-3" }, newHolder: { type: "agent", id: "agent-9" } },
    });
    renderSidebar(task);

    // Two claims are held (work by Other Person, review by Reviewer Person);
    // the second Reassign control belongs to the Reviewer row.
    await userEvent.click(screen.getByRole("button", { name: "Reassign review claim" }));
    await userEvent.click(await screen.findByRole("combobox", { name: "Reassign review claim to" }));
    await userEvent.click(await screen.findByRole("option", { name: /builder-bot/ }));
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));

    expect(apiMocks.adminReassignClaim).toHaveBeenCalledWith("t-1", { claim: "review", target: { type: "agent", id: "agent-9" } });
  });

  it("does not offer the current holder as a target", async () => {
    renderSidebar(makeTask({}));
    await userEvent.click(screen.getByRole("button", { name: "Reassign work claim" }));
    await userEvent.click(await screen.findByRole("combobox", { name: "Reassign work claim to" }));
    const listbox = await screen.findByRole("listbox");
    const names = within(listbox).getAllByRole("option").map((o) => o.textContent);
    expect(names).toHaveLength(3);
    expect(names.join("|")).not.toMatch(/Other Person/);
    expect(names.join("|")).toMatch(/Lan.*Guest Dev.*builder-bot/);
  });

  it("shows the server's message for a 409 and keeps the picker open", async () => {
    apiMocks.adminReassignClaim.mockRejectedValue(
      new ApiRequestError("conflict", "This project requires a distinct reviewer: the work claim cannot be reassigned to the task's current reviewer", 409),
    );
    const { onClaimReassigned } = renderSidebar(makeTask({}));

    await openAndPick(/Guest Dev/, "Reassign work claim to");
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/requires a distinct reviewer/);
    expect(onClaimReassigned).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "Reassign work claim to" })).toBeInTheDocument();
  });

  it("shows the server's message for a 403 on reassign", async () => {
    apiMocks.adminReassignClaim.mockRejectedValue(
      new ApiRequestError("forbidden", "Only project admins can reassign another actor's claim", 403),
    );
    const { onClaimReassigned } = renderSidebar(makeTask({}));

    await openAndPick(/Guest Dev/, "Reassign work claim to");
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Only project admins can reassign another actor's claim");
    expect(onClaimReassigned).not.toHaveBeenCalled();
  });

  it("shows the server's message when loading the eligible actors is refused with 403", async () => {
    apiMocks.getEligibleActors.mockRejectedValue(
      new ApiRequestError("forbidden", "Only project admins can list eligible claim holders", 403),
    );
    renderSidebar(makeTask({}));

    await userEvent.click(screen.getByRole("button", { name: "Reassign work claim" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Only project admins can list eligible claim holders");
    expect(screen.queryByRole("combobox", { name: "Reassign work claim to" })).not.toBeInTheDocument();
    expect(apiMocks.adminReassignClaim).not.toHaveBeenCalled();
  });

  it("is hidden for a non-admin, not disabled", () => {
    renderSidebar(makeTask({}), { isProjectAdmin: false });
    expect(screen.queryByRole("button", { name: /^Reassign (work|review) claim$/ })).not.toBeInTheDocument();
  });

  it("is hidden when there is no signed-in human user", () => {
    renderSidebar(makeTask({}), { user: null });
    expect(screen.queryByRole("button", { name: /^Reassign (work|review) claim$/ })).not.toBeInTheDocument();
  });

  it("is hidden on a finished task", () => {
    renderSidebar(makeTask({ status: "done" }));
    expect(screen.queryByRole("button", { name: /^Reassign (work|review) claim$/ })).not.toBeInTheDocument();
  });

  it("is hidden for a non-admin on a review claim too", () => {
    renderSidebar(
      makeTask({ status: "review", reviewClaimedByUserId: "u-3", reviewClaimedByUser: { id: "u-3", login: "rev", name: "Reviewer Person", avatarUrl: null } }),
      { isProjectAdmin: false },
    );
    expect(screen.queryByRole("button", { name: /^Reassign (work|review) claim$/ })).not.toBeInTheDocument();
  });
});
