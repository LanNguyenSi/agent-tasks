/** @vitest-environment jsdom */
/**
 * Smoke tests for TransitionsTable. Focus: edit-mode widgets call the
 * right handler with the right index + field, the unknown-rule red-pill
 * preservation path, the empty-state row, and saving=true disabling.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  TransitionsTable,
  type TransitionsTableProps,
} from "../../src/app/projects/workflow/_components/TransitionsTable";
import type {
  WorkflowDefinition,
  WorkflowRule,
} from "../../src/lib/api";

const RULES: WorkflowRule[] = [
  {
    id: "branchPresent",
    label: "Branch present",
    description: "A git branch is linked to the task.",
    failureMessage: "Set branchName before transitioning.",
  },
  {
    id: "prMerged",
    label: "PR merged",
    description: "The linked pull request has been merged.",
    failureMessage: "Merge the PR before transitioning.",
  },
  {
    id: "ciGreen",
    label: "CI green",
    description: "The linked PR's latest commit has all checks green.",
    failureMessage: "Wait for CI to go green before transitioning.",
  },
];

function ruleLabelMap(): Map<string, string> {
  return new Map(RULES.map((r) => [r.id, r.label]));
}

function makeDef(opts: { transitions?: WorkflowDefinition["transitions"] } = {}): WorkflowDefinition {
  return {
    initialState: "open",
    states: [
      { name: "open", label: "Open", terminal: false, agentInstructions: "" },
      { name: "in_progress", label: "In progress", terminal: false, agentInstructions: "" },
      { name: "done", label: "Done", terminal: true, agentInstructions: "" },
    ],
    transitions: opts.transitions ?? [
      {
        from: "open",
        to: "in_progress",
        label: "Start",
        requiredRole: "any",
        requires: ["branchPresent"],
      },
      {
        from: "in_progress",
        to: "done",
        label: "Finish",
        requiredRole: "ADMIN",
        requires: ["prMerged", "legacyRule"], // legacyRule is not in RULES → unknown pill
      },
    ],
  };
}

// Handlers are the subset of TransitionsTableProps we mock. `vi.fn<Signature>()`
// returns a Mock whose call signature matches the component's prop type, so
// spreading these into JSX compiles cleanly without unsafe casts.
function makeHandlers() {
  return {
    onAddTransition: vi.fn<TransitionsTableProps["onAddTransition"]>(),
    onRemoveTransition: vi.fn<TransitionsTableProps["onRemoveTransition"]>(),
    onUpdateTransitionField:
      vi.fn<TransitionsTableProps["onUpdateTransitionField"]>(),
    onToggleRule: vi.fn<TransitionsTableProps["onToggleRule"]>(),
  };
}

type MockedHandlers = ReturnType<typeof makeHandlers>;

function renderTable(opts: {
  canEdit?: boolean;
  saving?: boolean;
  def?: WorkflowDefinition;
  handlers?: MockedHandlers;
} = {}) {
  const handlers = opts.handlers ?? makeHandlers();
  const def = opts.def ?? makeDef();
  render(
    <TransitionsTable
      def={def}
      rules={RULES}
      ruleLabelById={ruleLabelMap()}
      canEdit={opts.canEdit ?? false}
      saving={opts.saving ?? false}
      {...handlers}
    />,
  );
  return { handlers, def };
}

describe("TransitionsTable — read-only", () => {
  it("renders from/to as code elements and no editable controls", () => {
    renderTable({ canEdit: false });
    const codes = screen
      .getAllByText((_, el) => el?.tagName === "CODE")
      .map((el) => el.textContent);
    expect(codes).toContain("open");
    expect(codes).toContain("in_progress");
    expect(codes).toContain("done");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /add transition/i })).toBeNull();
  });

  it("shows rule labels from the catalog map, falls back to raw id for unknown", () => {
    renderTable({ canEdit: false });
    // branchPresent → "Branch present", prMerged → "PR merged",
    // legacyRule → "legacyRule" (fallback).
    expect(screen.getByText("Branch present")).toBeInTheDocument();
    expect(screen.getByText("PR merged")).toBeInTheDocument();
    expect(screen.getByText("legacyRule")).toBeInTheDocument();
  });
});

describe("TransitionsTable — edit mode", () => {
  let handlers: MockedHandlers;

  beforeEach(() => {
    handlers = makeHandlers();
  });

  it("renders from/to dropdowns, label inputs, and required-role selects", () => {
    renderTable({ canEdit: true, handlers });
    // 2 rows × (from, to, requiredRole) = 6 selects
    expect(screen.getAllByRole("combobox")).toHaveLength(6);
    // 2 label inputs (both text)
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
  });

  it("required-role select has exactly 4 options (any / ADMIN / HUMAN_MEMBER / REVIEWER)", () => {
    renderTable({ canEdit: true, handlers });
    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    // Required-role selects for each row are the 3rd and 6th in document order
    // (from, to, role, from, to, role). Pin by value rather than by index to
    // survive cosmetic reordering.
    const roleSelects = selects.filter((s) =>
      ["any", "ADMIN", "HUMAN_MEMBER", "REVIEWER"].includes(s.value),
    );
    expect(roleSelects).toHaveLength(2);
    for (const s of roleSelects) {
      const opts = within(s).getAllByRole("option").map((o) => o.textContent);
      expect(opts).toEqual(["any", "ADMIN", "HUMAN_MEMBER", "REVIEWER"]);
    }
  });

  it("+ Add transition calls onAddTransition", async () => {
    renderTable({ canEdit: true, handlers });
    await userEvent.click(screen.getByRole("button", { name: /add transition/i }));
    expect(handlers.onAddTransition).toHaveBeenCalledTimes(1);
  });

  it("✕ on a row calls onRemoveTransition with the row index", async () => {
    renderTable({ canEdit: true, handlers });
    const removeButtons = screen.getAllByTitle("Remove transition");
    expect(removeButtons).toHaveLength(2);
    await userEvent.click(removeButtons[1]);
    expect(handlers.onRemoveTransition).toHaveBeenCalledTimes(1);
    expect(handlers.onRemoveTransition).toHaveBeenCalledWith(1);
  });

  it("typing in the label input calls onUpdateTransitionField with (i, 'label', nextValue)", async () => {
    renderTable({ canEdit: true, handlers });
    const labelInput = screen
      .getAllByRole("textbox")
      .find((el) => (el as HTMLInputElement).value === "Start")!;
    await userEvent.type(labelInput, "!");
    // Mock never writes back to `value`; the single keystroke fires one call
    // with "Start!". Pinning the exact value catches row-crossing bugs.
    expect(handlers.onUpdateTransitionField).toHaveBeenCalledWith(
      0,
      "label",
      "Start!",
    );
  });

  it("changing required-role calls onUpdateTransitionField(i, 'requiredRole', value)", async () => {
    renderTable({ canEdit: true, handlers });
    const roleSelects = (screen.getAllByRole("combobox") as HTMLSelectElement[]).filter(
      (s) => ["any", "ADMIN", "HUMAN_MEMBER", "REVIEWER"].includes(s.value),
    );
    await userEvent.selectOptions(roleSelects[0], "REVIEWER");
    expect(handlers.onUpdateTransitionField).toHaveBeenCalledWith(
      0,
      "requiredRole",
      "REVIEWER",
    );
  });

  it("changing the 'from' dropdown calls onUpdateTransitionField(i, 'from', name)", async () => {
    renderTable({ canEdit: true, handlers });
    // The first 'from' select on row 0 has value 'open'. Find it by value
    // among the first three selects (from, to, role for row 0).
    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    const fromRow0 = selects.slice(0, 3).find((s) => s.value === "open")!;
    await userEvent.selectOptions(fromRow0, "in_progress");
    expect(handlers.onUpdateTransitionField).toHaveBeenCalledWith(
      0,
      "from",
      "in_progress",
    );
  });

  it("changing the 'to' dropdown calls onUpdateTransitionField(i, 'to', name)", async () => {
    renderTable({ canEdit: true, handlers });
    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    // Row 0 'to' select starts at 'in_progress' (from the fixture). It's the
    // only select in the first three with that value.
    const toRow0 = selects.slice(0, 3).find((s) => s.value === "in_progress")!;
    await userEvent.selectOptions(toRow0, "done");
    expect(handlers.onUpdateTransitionField).toHaveBeenCalledWith(
      0,
      "to",
      "done",
    );
  });

  it("toggling a rule checkbox calls onToggleRule(i, ruleId, nextState)", async () => {
    renderTable({ canEdit: true, handlers });
    // Row 0 has branchPresent checked, prMerged unchecked, ciGreen unchecked.
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    // First three checkboxes correspond to row 0's three rules in catalog order.
    const row0BranchPresent = checkboxes[0];
    const row0PrMerged = checkboxes[1];
    expect(row0BranchPresent).toBeChecked();
    expect(row0PrMerged).not.toBeChecked();

    await userEvent.click(row0PrMerged);
    expect(handlers.onToggleRule).toHaveBeenCalledWith(0, "prMerged", true);

    handlers.onToggleRule.mockClear();
    await userEvent.click(row0BranchPresent);
    expect(handlers.onToggleRule).toHaveBeenCalledWith(0, "branchPresent", false);
  });

  it("unknown rule renders as a red '(unknown)' pill and stays visible", () => {
    renderTable({ canEdit: true, handlers });
    // legacyRule is in row 1's requires but not in RULES — should appear as
    // a red unknown pill in the edit-mode gates cell.
    expect(screen.getByText(/legacyRule \(unknown\)/i)).toBeInTheDocument();
  });

  it("unknown rule survives a parent re-render that mutates sibling rules", () => {
    // The meaningful preservation contract: when the parent re-renders with
    // an updated `requires` array that changes the known-rule membership on
    // the same row (e.g., adding ciGreen), the unknown-rule pill must still
    // appear. This matches how the parent's toggleRule mutator actually
    // updates the draft and re-renders the child.
    const handlers = makeHandlers();
    const def = makeDef();
    const { rerender } = render(
      <TransitionsTable
        def={def}
        rules={RULES}
        ruleLabelById={ruleLabelMap()}
        canEdit={true}
        saving={false}
        {...handlers}
      />,
    );
    expect(screen.getByText(/legacyRule \(unknown\)/i)).toBeInTheDocument();

    const updatedDef: WorkflowDefinition = {
      ...def,
      transitions: def.transitions.map((t, i) =>
        i === 1
          ? { ...t, requires: ["prMerged", "legacyRule", "ciGreen"] }
          : t,
      ),
    };
    rerender(
      <TransitionsTable
        def={updatedDef}
        rules={RULES}
        ruleLabelById={ruleLabelMap()}
        canEdit={true}
        saving={false}
        {...handlers}
      />,
    );
    expect(screen.getByText(/legacyRule \(unknown\)/i)).toBeInTheDocument();
  });

  it("empty-state row renders with canEdit-adjusted colSpan when no transitions", () => {
    renderTable({
      canEdit: true,
      handlers,
      def: makeDef({ transitions: [] }),
    });
    const emptyCell = screen.getByText(/no transitions defined/i);
    expect(emptyCell).toBeInTheDocument();
    expect(emptyCell.tagName).toBe("TD");
    expect((emptyCell as HTMLTableCellElement).colSpan).toBe(6);
  });

  it("empty-state colSpan is 5 in read-only mode (no remove column)", () => {
    renderTable({
      canEdit: false,
      handlers,
      def: makeDef({ transitions: [] }),
    });
    const emptyCell = screen.getByText(/no transitions defined/i);
    expect((emptyCell as HTMLTableCellElement).colSpan).toBe(5);
  });

  it("saving=true disables every input, select, and the Add button", () => {
    renderTable({ canEdit: true, saving: true, handlers });
    for (const el of screen.getAllByRole("textbox")) expect(el).toBeDisabled();
    for (const el of screen.getAllByRole("combobox")) expect(el).toBeDisabled();
    for (const el of screen.getAllByRole("checkbox")) expect(el).toBeDisabled();
    expect(screen.getByRole("button", { name: /add transition/i })).toBeDisabled();
  });
});
