/** @vitest-environment jsdom */
/**
 * Smoke tests for StatesTable — the dumb-component matrix of workflow
 * states. The parent owns all mutation state, so every interaction is
 * verified by asserting that the right handler was called with the
 * right args. No network, no routing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  StatesTable,
  type StatesTableProps,
} from "../../src/app/projects/workflow/_components/StatesTable";
import type { WorkflowDefinition } from "../../src/lib/api";

function makeDef(): WorkflowDefinition {
  return {
    initialState: "open",
    states: [
      { name: "open", label: "Open", terminal: false, agentInstructions: "" },
      {
        name: "in_progress",
        label: "In progress",
        terminal: false,
        agentInstructions: "Work on the task",
      },
      { name: "done", label: "Done", terminal: true, agentInstructions: "" },
    ],
    transitions: [],
  };
}

// Handlers are the subset of StatesTableProps we mock. `vi.fn<Signature>()`
// returns a Mock whose call signature matches the component's prop type, so
// spreading these into JSX compiles cleanly without unsafe casts.
function makeHandlers() {
  return {
    onAddState: vi.fn<StatesTableProps["onAddState"]>(),
    onRemoveState: vi.fn<StatesTableProps["onRemoveState"]>(),
    onUpdateStateField: vi.fn<StatesTableProps["onUpdateStateField"]>(),
    onSetInitialState: vi.fn<StatesTableProps["onSetInitialState"]>(),
    onToggleInstructionsExpanded:
      vi.fn<StatesTableProps["onToggleInstructionsExpanded"]>(),
  };
}

type MockedHandlers = ReturnType<typeof makeHandlers>;

function renderTable(opts: {
  canEdit?: boolean;
  saving?: boolean;
  expanded?: Set<number>;
  def?: WorkflowDefinition;
  handlers?: MockedHandlers;
} = {}) {
  const handlers = opts.handlers ?? makeHandlers();
  const def = opts.def ?? makeDef();
  render(
    <StatesTable
      def={def}
      canEdit={opts.canEdit ?? false}
      saving={opts.saving ?? false}
      expandedInstructions={opts.expanded ?? new Set()}
      {...handlers}
    />,
  );
  return { handlers, def };
}

describe("StatesTable — read-only", () => {
  it("renders state names as code elements with no editable controls", () => {
    renderTable({ canEdit: false });
    const codes = screen
      .getAllByText((_, el) => el?.tagName === "CODE")
      .map((el) => el.textContent);
    expect(codes).toContain("open");
    expect(codes).toContain("in_progress");
    expect(codes).toContain("done");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /add state/i })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("shows initial state as code, not as a select", () => {
    renderTable({ canEdit: false });
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("shows terminal=true as 'yes' and terminal=false as em-dash", () => {
    renderTable({ canEdit: false });
    expect(screen.getByText("yes")).toBeInTheDocument();
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });
});

describe("StatesTable — edit mode", () => {
  let handlers: MockedHandlers;

  beforeEach(() => {
    handlers = makeHandlers();
  });

  it("renders name inputs and the Add state button", () => {
    renderTable({ canEdit: true, handlers });
    expect(screen.getAllByRole("textbox")).toHaveLength(6); // name+label × 3 rows
    expect(screen.getByRole("button", { name: /add state/i })).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
  });

  it("initial-state select has one option per state", () => {
    renderTable({ canEdit: true, handlers });
    // The initial-state select is the one whose current value matches
    // defIntial. Since it's the only <select> in edit mode, grab by role.
    const combobox = screen.getByRole("combobox") as HTMLSelectElement;
    const options = within(combobox).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["open", "in_progress", "done"]);
    expect(combobox.value).toBe("open");
  });

  it("clicking + Add state calls onAddState exactly once", async () => {
    renderTable({ canEdit: true, handlers });
    await userEvent.click(screen.getByRole("button", { name: /add state/i }));
    expect(handlers.onAddState).toHaveBeenCalledTimes(1);
  });

  it("clicking the ✕ remove button calls onRemoveState with the row index", async () => {
    renderTable({ canEdit: true, handlers });
    const removeButtons = screen.getAllByTitle("Remove state");
    expect(removeButtons).toHaveLength(3);
    await userEvent.click(removeButtons[1]);
    expect(handlers.onRemoveState).toHaveBeenCalledTimes(1);
    expect(handlers.onRemoveState).toHaveBeenCalledWith(1);
  });

  it("typing in the name field calls onUpdateStateField(i, 'name', nextValue)", async () => {
    renderTable({ canEdit: true, handlers });
    const nameInputs = screen
      .getAllByRole("textbox")
      .filter((el) => (el as HTMLInputElement).value === "in_progress");
    expect(nameInputs).toHaveLength(1);
    await userEvent.type(nameInputs[0], "x");
    // Mock never writes back to `value`, so the controlled input stays at
    // "in_progress" and the single keystroke fires one call with
    // "in_progressx". Pinning the exact value catches row-crossing bugs
    // where another row's onChange would fire with the same field name but
    // the wrong starting value.
    expect(handlers.onUpdateStateField).toHaveBeenCalledWith(
      1,
      "name",
      "in_progressx",
    );
  });

  it("typing in the label field calls onUpdateStateField(i, 'label', nextValue)", async () => {
    renderTable({ canEdit: true, handlers });
    // The label input for row 1 starts as "In progress"; find it by value.
    const labelInput = screen
      .getAllByRole("textbox")
      .find((el) => (el as HTMLInputElement).value === "In progress")!;
    await userEvent.type(labelInput, "!");
    expect(handlers.onUpdateStateField).toHaveBeenCalledWith(
      1,
      "label",
      "In progress!",
    );
  });

  it("toggling terminal checkbox calls onUpdateStateField(i, 'terminal', nextValue)", async () => {
    renderTable({ canEdit: true, handlers });
    const checkboxes = screen.getAllByRole("checkbox");
    await userEvent.click(checkboxes[0]); // 'open' row, was false
    expect(handlers.onUpdateStateField).toHaveBeenCalledWith(0, "terminal", true);

    handlers.onUpdateStateField.mockClear();
    await userEvent.click(checkboxes[2]); // 'done' row, was true
    expect(handlers.onUpdateStateField).toHaveBeenCalledWith(2, "terminal", false);
  });

  it("clicking the collapsed instructions preview toggles expansion", async () => {
    renderTable({ canEdit: true, handlers });
    // Collapsed row 1 shows the first line of agentInstructions as a button.
    const preview = screen.getByRole("button", { name: /work on the task/i });
    await userEvent.click(preview);
    expect(handlers.onToggleInstructionsExpanded).toHaveBeenCalledWith(1);
  });

  it("when expanded, textarea edits call onUpdateStateField(i, 'agentInstructions', value)", async () => {
    renderTable({
      canEdit: true,
      handlers,
      expanded: new Set([1]),
    });
    const textarea = screen
      .getAllByRole("textbox")
      .find((el) => el.tagName === "TEXTAREA") as HTMLTextAreaElement | undefined;
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    await userEvent.type(textarea!, "!");
    expect(handlers.onUpdateStateField).toHaveBeenCalledWith(
      1,
      "agentInstructions",
      "Work on the task!",
    );
  });

  it("changing the initial-state dropdown calls onSetInitialState(name)", async () => {
    renderTable({ canEdit: true, handlers });
    const combobox = screen.getByRole("combobox") as HTMLSelectElement;
    await userEvent.selectOptions(combobox, "done");
    expect(handlers.onSetInitialState).toHaveBeenCalledWith("done");
  });

  it("saving=true disables all inputs and the Add state button", () => {
    renderTable({ canEdit: true, saving: true, handlers });
    for (const input of screen.getAllByRole("textbox")) {
      expect(input).toBeDisabled();
    }
    for (const box of screen.getAllByRole("checkbox")) {
      expect(box).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: /add state/i })).toBeDisabled();
    expect(screen.getByRole("combobox")).toBeDisabled();
  });
});
