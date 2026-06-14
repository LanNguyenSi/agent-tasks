/** @vitest-environment jsdom */
/**
 * Layered Escape: Select popover inside Modal.
 *
 * Contract:
 *   - First Escape closes only the innermost open popover; the modal stays
 *     open and form state is preserved.
 *   - Second Escape (no popover open) closes the modal.
 *   - When no popover is open, a single Escape closes the modal (unchanged).
 *   - When closeOnEscape={false}, Escape never closes the modal; a popover
 *     (if open) still closes on the first press.
 *
 * These cases exercise BOTH the usePopover capture-phase listener and
 * Modal's bubble-phase listener on document. jsdom correctly models the
 * capture/bubble ordering that the fix relies on.
 */
import { useState, useRef } from "react";
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// jsdom does not implement scrollIntoView; stub it so Select's scroll-active-
// option effect does not throw and obscure the event-propagation assertions.
// Capture and restore the original so the stub does not leak past this file.
let originalScrollIntoView: typeof window.HTMLElement.prototype.scrollIntoView;
beforeAll(() => {
  originalScrollIntoView = window.HTMLElement.prototype.scrollIntoView;
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterAll(() => {
  window.HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
});

import Modal from "../../src/components/ui/Modal";
import Select from "../../src/components/ui/Select";
import DropdownMenu from "../../src/components/ui/DropdownMenu";

afterEach(cleanup);

const OPTIONS = [
  { value: "alpha", label: "Alpha" },
  { value: "beta", label: "Beta" },
];

interface HarnessProps {
  closeOnEscape?: boolean;
  onClose: () => void;
}

// A minimal form inside a Modal: a text input (to verify form state survives)
// and a Select that uses usePopover internally.
function Harness({ closeOnEscape = true, onClose }: HarnessProps) {
  const [modalOpen, setModalOpen] = useState(true);
  const [selectValue, setSelectValue] = useState("alpha");
  const [inputValue, setInputValue] = useState("hello");

  return (
    <Modal
      open={modalOpen}
      onClose={() => {
        setModalOpen(false);
        onClose();
      }}
      title="Test modal"
      closeOnEscape={closeOnEscape}
    >
      <input
        aria-label="name"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
      />
      <Select
        options={OPTIONS}
        value={selectValue}
        onChange={setSelectValue}
        ariaLabel="priority"
      />
    </Modal>
  );
}

describe("Layered Escape: Select popover inside Modal", () => {
  it("first Escape closes only the popover; modal and form input stay intact", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    // Open the Select popover by clicking its combobox trigger.
    await userEvent.click(screen.getByRole("combobox", { name: "priority" }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    // First Escape: popover capture listener should fire and stop propagation.
    await userEvent.keyboard("{Escape}");

    // Popover is gone.
    expect(screen.queryByRole("listbox")).toBeNull();
    // Modal is still open.
    expect(screen.getByRole("dialog", { name: "Test modal" })).toBeInTheDocument();
    // Modal onClose was NOT called.
    expect(onClose).not.toHaveBeenCalled();
    // Form input value is preserved.
    expect(screen.getByRole("textbox", { name: "name" })).toHaveValue("hello");
    // Focus is restored to the Select trigger (a no-op for Select since focus
    // never left it, but it exercises the central focus-restore path).
    expect(screen.getByRole("combobox", { name: "priority" })).toHaveFocus();
  });

  it("second Escape (no popover open) closes the modal", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    // Open the popover then close it with first Escape.
    await userEvent.click(screen.getByRole("combobox", { name: "priority" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();

    // Second Escape: no popover capture listener; Modal's bubble listener fires.
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape closes the modal immediately when no popover is open", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    // Confirm no listbox is visible.
    expect(screen.queryByRole("listbox")).toBeNull();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closeOnEscape={false}: Escape never closes the modal; popover still closes on first press", async () => {
    const onClose = vi.fn();
    render(<Harness closeOnEscape={false} onClose={onClose} />);

    // Open the popover.
    await userEvent.click(screen.getByRole("combobox", { name: "priority" }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    // First Escape: popover closes, modal stays.
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Test modal" })).toBeInTheDocument();

    // Second Escape: modal stays (closeOnEscape=false).
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Test modal" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

// A trigger button + DropdownMenu inside a Modal. Unlike Select, DropdownMenu
// moves focus INTO the menu on open and relied on its own Escape handler to
// return focus to the trigger, the path the capture-phase stopPropagation
// would otherwise swallow. usePopover restores it centrally instead.
function DropdownHarness({ onClose }: { onClose: () => void }) {
  const [modalOpen, setModalOpen] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  return (
    <Modal
      open={modalOpen}
      onClose={() => {
        setModalOpen(false);
        onClose();
      }}
      title="Test modal"
    >
      <button ref={anchorRef} onClick={() => setMenuOpen(true)}>
        Open menu
      </button>
      <DropdownMenu anchorRef={anchorRef} open={menuOpen} onClose={() => setMenuOpen(false)}>
        <button role="menuitem">Item one</button>
        <button role="menuitem">Item two</button>
      </DropdownMenu>
    </Modal>
  );
}

describe("Layered Escape: DropdownMenu inside Modal (focus restore)", () => {
  it("first Escape closes only the menu and returns focus to the trigger; second closes the modal", async () => {
    const onClose = vi.fn();
    render(<DropdownHarness onClose={onClose} />);

    const trigger = screen.getByRole("button", { name: "Open menu" });
    await userEvent.click(trigger);

    // The menu opens and moves focus to its first item.
    const firstItem = await screen.findByRole("menuitem", { name: "Item one" });
    await waitFor(() => expect(firstItem).toHaveFocus());

    // First Escape: menu closes, modal stays, focus returns to the trigger.
    // This is the regression guard: capture-phase stopPropagation must not
    // strand focus on <body> by swallowing the inner focus-restore handler.
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menuitem", { name: "Item one" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Test modal" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();

    // Second Escape (no popover open): the modal closes.
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
