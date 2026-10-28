/** @vitest-environment jsdom */
/**
 * Opt-in searchable mode of the shared Select (dependency picker, task 7c6768d4).
 * Non-searchable usage must stay a button combobox without a text input.
 */
import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Select from "../../src/components/ui/Select";

const OPTIONS = [
  { value: "", label: "Add blocker..." },
  { value: "aaaa1111-0000", label: "Fix login", detail: "aaaa1111 · open", idPrefix: "aaaa1111-0000" },
  { value: "bbbb2222-0000", label: "Fix login", detail: "bbbb2222 · done", idPrefix: "bbbb2222-0000" },
  { value: "cccc3333-0000", label: "Write Docs", detail: "cccc3333 · open", idPrefix: "cccc3333-0000" },
];

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

function Harness({ searchable = true, onChange = vi.fn() }: { searchable?: boolean; onChange?: (v: string) => void }) {
  const [v, setV] = useState("");
  return (
    <div>
      <Select
        options={OPTIONS}
        value={v}
        onChange={(x) => {
          onChange(x);
          setV(x);
        }}
        ariaLabel="Add blocker"
        searchable={searchable}
        emptyText="No matching tasks"
      />
      <button type="button">after</button>
    </div>
  );
}

const optionNames = () => screen.queryAllByRole("option").map((o) => o.textContent);

describe("Select searchable", () => {
  it("renders a text input combobox, not a button, only when searchable", () => {
    const { unmount } = render(<Harness />);
    expect(screen.getByRole("combobox", { name: "Add blocker" }).tagName).toBe("INPUT");
    unmount();
    render(<Harness searchable={false} />);
    expect(screen.getByRole("combobox", { name: "Add blocker" }).tagName).toBe("BUTTON");
  });

  it("filters by label substring, case-insensitively", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByRole("combobox"), "dOcS");
    expect(optionNames()).toEqual(["Write Docscccc3333 · open"]);
  });

  it("finds a task by short id and hides the clear row while typing", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByRole("combobox"), "BBBB22");
    expect(optionNames()).toEqual(["Fix loginbbbb2222 · done"]);
  });

  it("never lists the clear row for a non-empty query, even when its label matches", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByRole("combobox"), "blocker");
    expect(optionNames()).toEqual(["No matching tasks"]);
    expect(screen.getByText("No matching tasks")).toBeInTheDocument();
  });

  it("shows all rows including the clear row for an empty query", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("combobox"));
    expect(optionNames()).toHaveLength(4);
  });

  it("lists same-titled tasks distinguishably", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByRole("combobox"), "fix");
    expect(optionNames()).toEqual(["Fix loginaaaa1111 · open", "Fix loginbbbb2222 · done"]);
  });

  it("shows the empty row when nothing matches", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByRole("combobox"), "zzz");
    expect(screen.getByText("No matching tasks")).toBeInTheDocument();
  });

  it("moves with ArrowDown/ArrowUp over the filtered list and Enter picks", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole("combobox");
    await userEvent.type(input, "fix");
    // first match is active after typing
    expect(input).toHaveAttribute("aria-activedescendant", expect.stringMatching(/-opt-0$/));
    await userEvent.keyboard("{ArrowDown}");
    expect(input).toHaveAttribute("aria-activedescendant", expect.stringMatching(/-opt-1$/));
    await userEvent.keyboard("{ArrowDown}"); // wraps
    expect(input).toHaveAttribute("aria-activedescendant", expect.stringMatching(/-opt-0$/));
    await userEvent.keyboard("{ArrowUp}"); // wraps back
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("bbbb2222-0000");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    // The input value is always the query; the chosen option is the placeholder.
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("placeholder", "Fix login (bbbb2222 · done)");
  });

  it("typing after a pick starts a fresh query instead of appending to the chosen text", async () => {
    render(<Harness />);
    const input = screen.getByRole("combobox");
    await userEvent.type(input, "docs{Enter}");
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("placeholder", "Write Docs (cccc3333 · open)");
    // focus + keyboard: userEvent.type would click first, which opens the list itself
    input.focus();
    await userEvent.keyboard("aaaa");
    expect(optionNames()).toEqual(["Fix loginaaaa1111 · open"]);
  });

  it("typing from the untouched 'nothing chosen' state filters by exactly what was typed", async () => {
    render(<Harness />);
    const input = screen.getByRole("combobox");
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("placeholder", "Add blocker...");
    input.focus();
    await userEvent.keyboard("cccc");
    expect(optionNames()).toEqual(["Write Docscccc3333 · open"]);
  });

  it("Backspace after a pick edits nothing: the input stays empty and the list closed", async () => {
    render(<Harness />);
    const input = screen.getByRole("combobox");
    await userEvent.type(input, "docs{Enter}");
    input.focus();
    await userEvent.keyboard("{Backspace}");
    expect(input).toHaveValue("");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).toHaveAttribute("placeholder", "Write Docs (cccc3333 · open)");
  });

  it("pasting after a pick is a fresh query, not appended to the chosen text", async () => {
    render(<Harness />);
    const input = screen.getByRole("combobox");
    await userEvent.type(input, "docs{Enter}");
    input.focus();
    await userEvent.paste("aaaa");
    expect(input).toHaveValue("aaaa");
    expect(optionNames()).toEqual(["Fix loginaaaa1111 · open"]);
  });

  it("clicking inside the input while the list is open keeps it open and keeps the query", async () => {
    render(<Harness />);
    const input = screen.getByRole("combobox");
    await userEvent.type(input, "fix");
    await userEvent.click(input);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveValue("fix");
    expect(optionNames()).toHaveLength(2);
  });

  it("the chevron closes an open list and opens a closed one", async () => {
    const { container } = render(<Harness />);
    const input = screen.getByRole("combobox");
    const chevron = container.querySelector("svg.select-search-chevron") as SVGElement;
    await userEvent.click(chevron);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveFocus();
    await userEvent.click(chevron);
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("mousedown on the listbox container (padding, scrollbar) keeps the list open and focus in the input", async () => {
    render(<Harness />);
    const input = screen.getByRole("combobox");
    await userEvent.type(input, "fix");
    await userEvent.pointer({ keys: "[MouseLeft>]", target: screen.getByRole("listbox") });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(input).toHaveFocus();
    expect(input).toHaveValue("fix");
  });

  it("shows the chosen option as a read-only label with title and suffix while closed", async () => {
    const { container } = render(<Harness />);
    expect(container.querySelector(".select-search-chosen")).toBeNull();
    await userEvent.type(screen.getByRole("combobox"), "docs{Enter}");
    expect(container.querySelector(".select-search-chosen-label")?.textContent).toBe("Write Docs");
    expect(container.querySelector(".select-search-chosen-detail")?.textContent).toBe("(cccc3333 · open)");
  });

  it("matches ids by prefix only, never inside the id", async () => {
    render(
      <Select
        options={[
          { value: "", label: "Add blocker..." },
          { value: "3f2a91c0-7b1e-4d2a-9add-0c5e8f1b2a33", label: "Fix login", idPrefix: "3f2a91c0-7b1e-4d2a-9add-0c5e8f1b2a33" },
        ]}
        value=""
        onChange={vi.fn()}
        ariaLabel="x"
        searchable
        emptyText="No matching tasks"
      />,
    );
    const input = screen.getByRole("combobox");
    await userEvent.type(input, "add");
    expect(optionNames()).toEqual(["No matching tasks"]);
    await userEvent.clear(input);
    await userEvent.type(input, "3F2A91C0");
    expect(optionNames()).toEqual(["Fix login"]);
    await userEvent.clear(input);
    await userEvent.type(input, "2a91");
    expect(optionNames()).toEqual(["No matching tasks"]);
  });

  it("Enter with no match picks nothing", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.type(screen.getByRole("combobox"), "zzz{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Escape closes the list and keeps focus on the input", async () => {
    render(<Harness />);
    const input = screen.getByRole("combobox");
    await userEvent.type(input, "fix");
    expect(input).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).toHaveFocus();
  });

  it("clicking an option picks it", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.type(screen.getByRole("combobox"), "docs");
    await userEvent.click(screen.getByRole("option"));
    expect(onChange).toHaveBeenCalledWith("cccc3333-0000");
  });

  it("closes on blur and resets the query", async () => {
    render(<Harness />);
    const input = screen.getByRole("combobox");
    await userEvent.type(input, "fix");
    await userEvent.tab();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await userEvent.click(input);
    expect(optionNames()).toHaveLength(4);
  });

  it("does not open while disabled", async () => {
    render(<Select options={OPTIONS} value="" onChange={vi.fn()} ariaLabel="x" searchable disabled />);
    const input = screen.getByRole("combobox");
    await userEvent.type(input, "fix");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

describe("Select non-searchable is unchanged", () => {
  it("has no text input, keeps full list and 'No options' empty row", async () => {
    render(<Select options={OPTIONS} value="" onChange={vi.fn()} ariaLabel="x" />);
    await userEvent.click(screen.getByRole("combobox"));
    expect(optionNames()).toHaveLength(4);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("typing letters does not filter; Space picks the active option", async () => {
    const onChange = vi.fn();
    render(<Select options={OPTIONS} value="" onChange={onChange} ariaLabel="x" />);
    const trigger = screen.getByRole("combobox");
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}zzz");
    expect(optionNames()).toHaveLength(4);
    await userEvent.keyboard("{ArrowDown} ");
    expect(onChange).toHaveBeenCalledWith("aaaa1111-0000");
  });

  it("empty options render 'No options'", async () => {
    render(<Select options={[]} value="" onChange={vi.fn()} ariaLabel="x" />);
    await userEvent.click(screen.getByRole("combobox"));
    expect(screen.getByText("No options")).toBeInTheDocument();
  });
});
