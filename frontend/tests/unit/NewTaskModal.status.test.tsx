/** @vitest-environment jsdom */
/**
 * NewTaskModal -- backlog-aware create status (2026-08-20 operator
 * decision, supersedes D19).
 *
 * Contract under test:
 *   - the Status dropdown offers exactly Backlog (first) then Open;
 *   - no initialStatus prop (the three generic entry points) defaults to
 *     DEFAULT_CREATE_STATUS (backlog);
 *   - a non-selectable initialStatus (e.g. "in_progress", from a board
 *     column's + button whose gating still exists until a follow-up task)
 *     clamps to DEFAULT_CREATE_STATUS;
 *   - initialStatus="open" (the board's Open column + button) still works;
 *   - while status is backlog, the "me" assignee option is disabled with a
 *     hint and submit does NOT call claimTask; switching to Open re-enables
 *     it;
 *   - creating with status backlog sends status "backlog" to createTask.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../src/lib/api", () => ({
  createTask: vi.fn(),
  claimTask: vi.fn(),
}));

import NewTaskModal from "../../src/components/dashboard/NewTaskModal";
import { ToastProvider } from "../../src/components/ui/Toast";
import { createTask, claimTask } from "../../src/lib/api";

const mockCreateTask = vi.mocked(createTask);
const mockClaimTask = vi.mocked(claimTask);

function renderModal(props: Partial<Parameters<typeof NewTaskModal>[0]> = {}) {
  return render(
    <ToastProvider>
      <NewTaskModal
        open
        onClose={vi.fn()}
        projectId="p-1"
        templateFields={null}
        templatePresets={[]}
        enforcementMode={null}
        onTaskCreated={vi.fn()}
        onEditTask={vi.fn()}
        {...props}
      />
    </ToastProvider>,
  );
}

function statusCombobox() {
  return screen.getByRole("combobox", { name: "Status" });
}

function assigneeCombobox() {
  return screen.getByRole("combobox", { name: "Assignee" });
}

async function fillTitle(title = "A new task") {
  await userEvent.type(screen.getByLabelText("Title"), title);
}

beforeEach(() => {
  mockCreateTask.mockReset();
  mockClaimTask.mockReset();
  // jsdom does not implement scrollIntoView; the Select listbox calls it.
  Element.prototype.scrollIntoView = vi.fn();
});

describe("NewTaskModal -- Status dropdown", () => {
  it("offers exactly Backlog (first) then Open", async () => {
    renderModal();
    await userEvent.click(statusCombobox());
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Backlog", "Open"]);
  });

  it("defaults to Backlog when no initialStatus is given (the three generic entry points)", () => {
    renderModal();
    expect(statusCombobox()).toHaveTextContent("Backlog");
  });

  it("clamps a non-selectable initialStatus (e.g. in_progress) to the default", () => {
    renderModal({ initialStatus: "in_progress" });
    expect(statusCombobox()).toHaveTextContent("Backlog");
  });

  it("still opens with Open preselected when initialStatus='open' (board's Open column +)", () => {
    renderModal({ initialStatus: "open" });
    expect(statusCombobox()).toHaveTextContent("Open");
  });
});

describe("NewTaskModal -- Assignee guard while status is backlog", () => {
  it("disables the Assignee control with a hint while status is backlog", () => {
    renderModal();
    expect(assigneeCombobox()).toBeDisabled();
    expect(screen.getByText(/backlog tasks can't be claimed/i)).toBeInTheDocument();
  });

  it("re-enables Assignee, and clears the hint, when switched to Open", async () => {
    renderModal();
    await userEvent.click(statusCombobox());
    await userEvent.click(screen.getByRole("option", { name: "Open" }));

    expect(assigneeCombobox()).toBeEnabled();
    expect(screen.queryByText(/backlog tasks can't be claimed/i)).not.toBeInTheDocument();
  });

  it("submits with status backlog and does NOT call claimTask, even if the assignee had been 'me'", async () => {
    mockCreateTask.mockResolvedValue({ task: { id: "task-1" } as never });
    renderModal({ initialStatus: "open" });

    // Pick "me" while status is Open (Assignee is enabled there)...
    await userEvent.click(assigneeCombobox());
    await userEvent.click(screen.getByRole("option", { name: "Assign to me" }));

    // ...then switch to Backlog: the Assignee control becomes disabled (so
    // the user can no longer change it), but its already-picked "me" value
    // is deliberately NOT reset here -- handleSubmit's own
    // `status !== "backlog"` check is what must stop the claim call.
    await userEvent.click(statusCombobox());
    await userEvent.click(screen.getByRole("option", { name: "Backlog" }));
    expect(assigneeCombobox()).toBeDisabled();

    await fillTitle();
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(mockCreateTask).toHaveBeenCalled());
    expect(mockCreateTask.mock.calls[0]![1]).toMatchObject({ status: "backlog" });
    expect(mockClaimTask).not.toHaveBeenCalled();
  });

  it("submits with status open and DOES call claimTask when assignee is 'me'", async () => {
    mockCreateTask.mockResolvedValue({ task: { id: "task-2" } as never });
    mockClaimTask.mockResolvedValue({ id: "task-2" } as never);
    renderModal({ initialStatus: "open" });

    await userEvent.click(assigneeCombobox());
    await userEvent.click(screen.getByRole("option", { name: "Assign to me" }));

    await fillTitle();
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(mockCreateTask).toHaveBeenCalled());
    expect(mockCreateTask.mock.calls[0]![1]).toMatchObject({ status: "open" });
    await waitFor(() => expect(mockClaimTask).toHaveBeenCalledWith("task-2"));
  });
});
