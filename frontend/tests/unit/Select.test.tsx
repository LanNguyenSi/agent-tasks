/** @vitest-environment jsdom */
/**
 * Select's disabled trigger -- aria-disabled pattern (review round 1 fix,
 * task 31528564).
 *
 * The disabled trigger must NOT use the native `disabled` attribute (that
 * would drop it from the tab order); it stays focusable, exposes
 * `aria-disabled="true"`, and its open/keydown/click handlers are the thing
 * that actually suppresses opening the listbox -- via click, and via
 * keyboard (Enter, Space, ArrowDown).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Select from "../../src/components/ui/Select";

const OPTIONS = [
  { value: "unassigned", label: "Unassigned" },
  { value: "me", label: "Assign to me" },
];

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe("Select -- disabled trigger (aria-disabled pattern)", () => {
  it("stays focusable (tab-reachable) while disabled", () => {
    render(
      <Select options={OPTIONS} value="unassigned" onChange={vi.fn()} ariaLabel="Assignee" disabled />,
    );
    const trigger = screen.getByRole("combobox", { name: "Assignee" });
    // Native `disabled` would drop the trigger from the tab order; the
    // aria-disabled pattern keeps it focusable while still announcing
    // unavailability to assistive tech.
    expect(trigger).not.toHaveAttribute("disabled");
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    trigger.focus();
    expect(trigger).toHaveFocus();
  });

  it("does not open on click while disabled", async () => {
    render(
      <Select options={OPTIONS} value="unassigned" onChange={vi.fn()} ariaLabel="Assignee" disabled />,
    );
    const trigger = screen.getByRole("combobox", { name: "Assignee" });
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("does not open on Enter while disabled", async () => {
    render(
      <Select options={OPTIONS} value="unassigned" onChange={vi.fn()} ariaLabel="Assignee" disabled />,
    );
    const trigger = screen.getByRole("combobox", { name: "Assignee" });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("does not open on Space while disabled", async () => {
    render(
      <Select options={OPTIONS} value="unassigned" onChange={vi.fn()} ariaLabel="Assignee" disabled />,
    );
    const trigger = screen.getByRole("combobox", { name: "Assignee" });
    trigger.focus();
    await userEvent.keyboard(" ");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("does not open on ArrowDown while disabled", async () => {
    render(
      <Select options={OPTIONS} value="unassigned" onChange={vi.fn()} ariaLabel="Assignee" disabled />,
    );
    const trigger = screen.getByRole("combobox", { name: "Assignee" });
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("opens normally via click when NOT disabled (control)", async () => {
    render(<Select options={OPTIONS} value="unassigned" onChange={vi.fn()} ariaLabel="Assignee" />);
    const trigger = screen.getByRole("combobox", { name: "Assignee" });
    expect(trigger).not.toHaveAttribute("aria-disabled");
    await userEvent.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });
});
