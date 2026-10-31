/** @vitest-environment jsdom */
/**
 * NewTaskModal resets every field when the modal opens and when the resolved
 * initial status changes while it is open. A re-render with both unchanged
 * (the parent re-rendering, a new callback identity) keeps what the user typed.
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
import { waitForCall } from "./helpers/waitForCall";
import { createTask, claimTask } from "../../src/lib/api";

const mockCreateTask = vi.mocked(createTask);
const mockClaimTask = vi.mocked(claimTask);

type Props = Parameters<typeof NewTaskModal>[0];

function modal(props: Partial<Props> = {}) {
  return (
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
    </ToastProvider>
  );
}

const titleInput = () => screen.getByLabelText("Title") as HTMLInputElement;
const descriptionInput = () => screen.getByLabelText("Description") as HTMLTextAreaElement;
const statusCombobox = () => screen.getByRole("combobox", { name: "Status" });

beforeEach(() => {
  mockCreateTask.mockReset();
  mockClaimTask.mockReset();
  // jsdom does not implement scrollIntoView; the Select listbox calls it.
  Element.prototype.scrollIntoView = vi.fn();
});

describe("NewTaskModal: reset on open", () => {
  it("starts empty again after the modal was closed and opened", async () => {
    const { rerender } = render(modal());
    await userEvent.type(titleInput(), "Half typed");
    await userEvent.type(descriptionInput(), "Some notes");

    rerender(modal({ open: false }));
    rerender(modal({ open: true }));

    expect(titleInput().value).toBe("");
    expect(descriptionInput().value).toBe("");
  });

  it("resets the status to the initial status on reopen", async () => {
    const { rerender } = render(modal({ initialStatus: "open" }));
    expect(statusCombobox()).toHaveTextContent("Open");
    await userEvent.click(statusCombobox());
    await userEvent.click(screen.getByRole("option", { name: "Backlog" }));
    expect(statusCombobox()).toHaveTextContent("Backlog");

    rerender(modal({ open: false, initialStatus: "open" }));
    rerender(modal({ open: true, initialStatus: "open" }));

    expect(statusCombobox()).toHaveTextContent("Open");
  });

  it("clears every field, so the next create carries only what is typed after the reopen", async () => {
    mockCreateTask.mockResolvedValue({ task: { id: "task-1" } as never });
    const allFields = {
      goal: true,
      acceptanceCriteria: true,
      context: true,
      constraints: true,
      scope: true,
      outOfScope: true,
      dependencies: true,
      risk: true,
      agentPrompt: true,
    };
    const { rerender } = render(modal({ initialStatus: "open", templateFields: allFields }));

    await userEvent.type(titleInput(), "Old title");
    await userEvent.type(descriptionInput(), "Old description");
    await userEvent.click(screen.getByRole("combobox", { name: "Priority" }));
    await userEvent.click(screen.getByRole("option", { name: "HIGH" }));
    await userEvent.type(screen.getByLabelText("Due Date"), "2026-12-31");
    await userEvent.click(screen.getByRole("combobox", { name: "Assignee" }));
    await userEvent.click(screen.getByRole("option", { name: "Assign to me" }));
    await userEvent.click(screen.getByRole("button", { name: /Agent Template/ }));
    for (const label of [
      "Goal",
      "Acceptance Criteria",
      "Context",
      "Constraints",
      "Scope",
      "Out of Scope",
      "Dependencies",
      "Risk",
      "Agent Prompt",
    ]) {
      await userEvent.type(screen.getByLabelText(label), `old ${label}`);
    }
    await userEvent.click(screen.getByRole("combobox", { name: "Task type" }));
    await userEvent.click(screen.getByRole("option", { name: "feature" }));

    rerender(modal({ open: false, initialStatus: "open", templateFields: allFields }));
    const onTaskCreated = vi.fn();
    rerender(modal({ open: true, initialStatus: "open", templateFields: allFields, onTaskCreated }));

    await userEvent.type(titleInput(), "New title");
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));

    const body = (await waitForCall(mockCreateTask))[0]![1];
    expect(body).toMatchObject({ title: "New title", status: "open", priority: "MEDIUM" });
    // Nothing from before the reopen: no description, no due date, no
    // template data (every template field and the task type were cleared).
    expect(body.description).toBeUndefined();
    expect(body.dueAt).toBeUndefined();
    expect(body).not.toHaveProperty("templateData");
    // The "me" pick was reset too, so no claim follows the create. Wait for
    // onTaskCreated first: the submit handler calls it after the claim
    // decision, so the negative assertion cannot pass before that decision.
    await waitFor(() => expect(onTaskCreated).toHaveBeenCalled());
    expect(mockClaimTask).not.toHaveBeenCalled();
  });

  it("returns from the post-create confidence panel to an empty form on reopen", async () => {
    mockCreateTask.mockResolvedValue({
      task: { id: "task-1", title: "Made" } as never,
      confidence: {
        score: 40,
        threshold: 60,
        blocking: false,
        missing: [],
        findings: [],
        nextActions: [],
      },
    });
    const { rerender } = render(modal());
    await userEvent.type(titleInput(), "Made");
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(await screen.findByText("Task created")).toBeInTheDocument();

    rerender(modal({ open: false }));
    rerender(modal({ open: true }));

    expect(screen.queryByText("Task created")).not.toBeInTheDocument();
    expect(titleInput().value).toBe("");
  });

  it("clears a create that was still in flight when the modal was closed", async () => {
    mockCreateTask.mockReturnValue(new Promise(() => {}));
    const { rerender } = render(modal());
    await userEvent.type(titleInput(), "Slow one");
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(screen.getByRole("button", { name: /Creating/ })).toBeDisabled();

    rerender(modal({ open: false }));
    rerender(modal({ open: true }));

    expect(screen.getByRole("button", { name: "Create task" })).toBeEnabled();
  });

  it("resets typed fields when the initial status changes while open", async () => {
    const { rerender } = render(modal({ initialStatus: "backlog" }));
    await userEvent.type(titleInput(), "Typed under backlog");

    rerender(modal({ initialStatus: "open" }));

    expect(titleInput().value).toBe("");
    expect(statusCombobox()).toHaveTextContent("Open");
  });

  it("does not reset when a non-selectable initial status resolves to the same status", async () => {
    // "in_progress" clamps to the default (backlog), so swapping between two
    // raw values that resolve alike is not a change of the reset key.
    const { rerender } = render(modal({ initialStatus: "in_progress" }));
    await userEvent.type(titleInput(), "Keep me");

    rerender(modal({ initialStatus: "done" }));

    expect(titleInput().value).toBe("Keep me");
  });

  it("keeps typed fields when the parent re-renders with the same open and status", async () => {
    const { rerender } = render(modal({ initialStatus: "open" }));
    await userEvent.type(titleInput(), "Keep me");
    await userEvent.type(descriptionInput(), "And me");

    rerender(modal({ initialStatus: "open", onClose: vi.fn(), onTaskCreated: vi.fn() }));

    expect(titleInput().value).toBe("Keep me");
    expect(descriptionInput().value).toBe("And me");
  });
});
