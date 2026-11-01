/** @vitest-environment jsdom */
/**
 * Smoke tests for StatesTable — the dumb-component matrix of workflow
 * states. The parent owns all mutation state, so every interaction is
 * verified by asserting that the right handler was called with the
 * right args. No network, no routing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  StatesTable,
  type StatesTableProps,
} from "../../src/app/projects/[id]/workflow/_components/StatesTable";
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

  it("shows neither the rules hint nor the lock notice", () => {
    renderTable({ canEdit: false });
    expect(screen.queryByText(/lowercase letters, digits and underscores/i)).toBeNull();
    expect(screen.queryByText(/cannot be added, renamed or removed/i)).toBeNull();
    expect(screen.queryByText(/fixed: every task starts in open/i)).toBeNull();
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
    // label x 3 rows, name x 2 rows: the initial state `open` keeps a read-only name.
    expect(screen.getAllByRole("textbox")).toHaveLength(5);
    expect(screen.getByRole("button", { name: /add state/i })).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
  });

  it("the remove column has an accessible header (visually hidden)", () => {
    renderTable({ canEdit: true, handlers });
    const header = screen.getByRole("columnheader", { name: "Remove" });
    expect(header.querySelector(".sr-only")).not.toBeNull();
  });

  it("shows the initial state as fixed code, with no select to change it", () => {
    renderTable({ canEdit: true, handlers });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText(/fixed: every task starts in open/i)).toBeInTheDocument();
  });

  it("the open row has no name input and no lock notice is shown", () => {
    renderTable({ canEdit: true, handlers });
    expect(screen.queryByRole("textbox", { name: "State name for row 1" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "State name for row 2" })).toBeInTheDocument();
    expect(screen.queryByText(/cannot be added, renamed or removed/i)).toBeNull();
  });

  it("shows the rules hint (name format, reserved names, tasks are not moved)", () => {
    renderTable({ canEdit: true, handlers });
    const hint = screen.getByText(/lowercase letters, digits and underscores/i);
    expect(hint.textContent).toMatch(/at most 64/);
    expect(hint.textContent).toMatch(/backlog and abandoned are reserved/);
    expect(hint.textContent).toMatch(/Renaming a state updates its transitions/);
    expect(hint.textContent).toMatch(/Tasks in a state you rename or remove are not moved/);
  });

  it("clicking + Add state calls onAddState exactly once", async () => {
    renderTable({ canEdit: true, handlers });
    await userEvent.click(screen.getByRole("button", { name: /add state/i }));
    expect(handlers.onAddState).toHaveBeenCalledTimes(1);
  });

  it("clicking the ✕ remove button calls onRemoveState with the row index", async () => {
    renderTable({ canEdit: true, handlers });
    // Buttons use title="Remove state <name>"; match by prefix regex.
    const removeButtons = screen.getAllByTitle(/^Remove state/);
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
    await userEvent.click(checkboxes[1]); // 'in_progress' row, was false (the open row's box is disabled)
    expect(handlers.onUpdateStateField).toHaveBeenCalledWith(1, "terminal", true);

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

  it("saving=true disables all inputs and the Add state button", () => {
    renderTable({ canEdit: true, saving: true, handlers });
    for (const input of screen.getAllByRole("textbox")) {
      expect(input).toBeDisabled();
    }
    for (const box of screen.getAllByRole("checkbox")) {
      expect(box).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: /add state/i })).toBeDisabled();
  });
});

describe("StatesTable: the initial state is fixed", () => {
  const reason = (el: HTMLElement) =>
    document.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent ?? "";

  it("the open row's remove button and terminal checkbox are disabled and explained", () => {
    renderTable({ canEdit: true });
    const remove = screen.getByTitle("Remove state open");
    expect(remove).toBeDisabled();
    expect(reason(remove)).toMatch(/open is the initial state: every task starts there, so it cannot be removed/);
    const terminal = screen.getByRole("checkbox", { name: "Mark state open as terminal" });
    expect(terminal).toBeDisabled();
    expect(reason(terminal)).toMatch(/open is the initial state: a task created in a terminal state could never be claimed/);
  });

  it("clicking the disabled controls calls no handler", async () => {
    const handlers = makeHandlers();
    renderTable({ canEdit: true, handlers });
    await userEvent.click(screen.getByTitle("Remove state open"));
    await userEvent.click(screen.getByRole("checkbox", { name: "Mark state open as terminal" }));
    expect(handlers.onRemoveState).not.toHaveBeenCalled();
    expect(handlers.onUpdateStateField).not.toHaveBeenCalled();
  });

  it("the other rows' controls are enabled and carry no description", () => {
    renderTable({ canEdit: true });
    for (const name of ["in_progress", "done"]) {
      expect(screen.getByTitle(`Remove state ${name}`)).toBeEnabled();
      expect(screen.getByTitle(`Remove state ${name}`)).not.toHaveAttribute("aria-describedby");
      expect(screen.getByRole("checkbox", { name: `Mark state ${name} as terminal` })).toBeEnabled();
    }
  });

  it("follows initialState, not the literal name open", () => {
    const def = makeDef();
    def.initialState = "in_progress";
    renderTable({ canEdit: true, def });
    expect(screen.getByTitle("Remove state in_progress")).toBeDisabled();
    expect(screen.getByTitle("Remove state open")).toBeEnabled();
  });

  it("a stored terminal initial state can still be unmarked (to repair it)", async () => {
    const handlers = makeHandlers();
    const def = makeDef();
    def.states[0]!.terminal = true;
    renderTable({ canEdit: true, def, handlers });
    const terminal = screen.getByRole("checkbox", { name: "Mark state open as terminal" });
    expect(terminal).toBeEnabled();
    await userEvent.click(terminal);
    expect(handlers.onUpdateStateField).toHaveBeenCalledWith(0, "terminal", false);
  });

  it("saving disables the other rows' controls too", () => {
    renderTable({ canEdit: true, saving: true });
    expect(screen.getByTitle("Remove state done")).toBeDisabled();
  });
});

describe("StatesTable: name validation (mirrors the backend)", () => {
  function nameInput(row: number): HTMLInputElement {
    return screen.getByRole("textbox", { name: `State name for row ${row}` }) as HTMLInputElement;
  }

  const REFUSED: Array<[string, string, RegExp]> = [
    ["empty", "", /cannot be empty/i],
    ["uppercase", "QA", /must match \[a-z0-9_\]\+/],
    ["a space", "q a", /must match \[a-z0-9_\]\+/],
    ["a dash", "q-a", /must match \[a-z0-9_\]\+/],
    ["longer than 64", "a".repeat(65), /at most 64 characters/],
    ["reserved backlog", "backlog", /"backlog" is reserved/],
    ["reserved abandoned", "abandoned", /"abandoned" is reserved/],
    ["a duplicate of another state", "done", /Duplicate state name: "done"/],
    ["a duplicate of open", "open", /Duplicate state name: "open"/],
  ];

  for (const [label, value, message] of REFUSED) {
    it(`refuses ${label}: shows the error, marks the input invalid, forwards nothing`, () => {
      const handlers = makeHandlers();
      renderTable({ canEdit: true, handlers });
      fireEvent.change(nameInput(2), { target: { value } });
      const input = nameInput(2);
      expect(input).toHaveAttribute("aria-invalid", "true");
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toMatch(message);
      expect(input.getAttribute("aria-describedby")).toBe(alert.id);
      expect(input.value).toBe(value);
      expect(handlers.onUpdateStateField).not.toHaveBeenCalled();
    });
  }

  const ACCEPTED = ["qa", "qa_2", "0", "a".repeat(64), "ship_it_2"];
  for (const value of ACCEPTED) {
    it(`accepts ${value.length > 20 ? `a ${value.length}-character name` : value}: forwards the rename, no error`, () => {
      const handlers = makeHandlers();
      renderTable({ canEdit: true, handlers });
      fireEvent.change(nameInput(2), { target: { value } });
      expect(handlers.onUpdateStateField).toHaveBeenCalledWith(1, "name", value);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(nameInput(2)).toHaveAttribute("aria-invalid", "false");
      expect(nameInput(2)).not.toHaveAttribute("aria-describedby");
    });
  }

  it("typing the current name back after an invalid one is not a duplicate and forwards nothing", () => {
    const handlers = makeHandlers();
    renderTable({ canEdit: true, handlers });
    fireEvent.change(nameInput(2), { target: { value: "QA" } });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.change(nameInput(2), { target: { value: "in_progress" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(handlers.onUpdateStateField).not.toHaveBeenCalled();
  });

  it("a valid name after an invalid one clears the error and forwards the rename", () => {
    const handlers = makeHandlers();
    renderTable({ canEdit: true, handlers });
    fireEvent.change(nameInput(2), { target: { value: "QA" } });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.change(nameInput(2), { target: { value: "qa" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(handlers.onUpdateStateField).toHaveBeenCalledTimes(1);
    expect(handlers.onUpdateStateField).toHaveBeenCalledWith(1, "name", "qa");
  });

  it("leaving the field with an invalid name restores the last valid name and drops the error", () => {
    const handlers = makeHandlers();
    renderTable({ canEdit: true, handlers });
    fireEvent.change(nameInput(2), { target: { value: "backlog" } });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.blur(nameInput(2));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(nameInput(2).value).toBe("in_progress");
  });

  it("clicking Add state drops a pending invalid name (row indexes shift)", async () => {
    renderTable({ canEdit: true });
    fireEvent.change(nameInput(2), { target: { value: "QA" } });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /add state/i }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(nameInput(2).value).toBe("in_progress");
  });

  it("clicking a remove button drops a pending invalid name (row indexes shift)", async () => {
    renderTable({ canEdit: true });
    fireEvent.change(nameInput(2), { target: { value: "QA" } });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await userEvent.click(screen.getByTitle("Remove state done"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(nameInput(2).value).toBe("in_progress");
  });

  it("an invalid name in one row does not show on another row", () => {
    renderTable({ canEdit: true });
    fireEvent.change(nameInput(2), { target: { value: "QA" } });
    expect(nameInput(3)).toHaveAttribute("aria-invalid", "false");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });
});

describe("StatesTable: focus after add and remove", () => {
  // A parent that applies add and remove to its own state, like the page does,
  // so the focus effect sees the row count change. `refuse` keeps remove inert.
  function Harness({ refuse = false, initial = makeDef() }: { refuse?: boolean; initial?: WorkflowDefinition }) {
    const [def, setDef] = useState(initial);
    return (
      <StatesTable
        def={def}
        canEdit
        saving={false}
        expandedInstructions={new Set()}
        onAddState={() =>
          setDef((d) => ({
            ...d,
            states: [...d.states, { name: `new_state_${d.states.length}`, label: "New state", terminal: false }],
          }))
        }
        onRemoveState={(i) => {
          if (refuse) return;
          setDef((d) => ({ ...d, states: d.states.filter((_, j) => j !== i) }));
        }}
        onUpdateStateField={vi.fn()}
        onToggleInstructionsExpanded={vi.fn()}
      />
    );
  }

  it("adding a state moves focus to the new row's name input", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: /add state/i }));
    const input = screen.getByRole("textbox", { name: "State name for row 4" });
    expect(input).toHaveFocus();
    expect((input as HTMLInputElement).value).toBe("new_state_3");
  });

  it("removing a state moves focus to the name input of the row that took its place", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTitle("Remove state in_progress"));
    expect(screen.getByRole("textbox", { name: "State name for row 2" })).toHaveFocus();
    expect((screen.getByRole("textbox", { name: "State name for row 2" }) as HTMLInputElement).value).toBe("done");
  });

  it("removing the last row moves focus to the previous row's name input", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTitle("Remove state done"));
    expect(screen.getByRole("textbox", { name: "State name for row 2" })).toHaveFocus();
  });

  it("falls back to the Add state button when the next row has no name input (the open row)", async () => {
    const def: WorkflowDefinition = {
      initialState: "open",
      states: [
        { name: "open", label: "Open", terminal: false },
        { name: "done", label: "Done", terminal: true },
      ],
      transitions: [],
    };
    render(<Harness initial={def} />);
    await userEvent.click(screen.getByTitle("Remove state done"));
    expect(screen.getByRole("button", { name: /add state/i })).toHaveFocus();
  });

  it("a refused removal leaves focus on the remove button", async () => {
    render(<Harness refuse />);
    const remove = screen.getByTitle("Remove state in_progress");
    await userEvent.click(remove);
    expect(remove).toHaveFocus();
  });
});
