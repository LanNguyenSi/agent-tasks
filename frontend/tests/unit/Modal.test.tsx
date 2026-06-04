/** @vitest-environment jsdom */
/**
 * Modal primitive — accessibility behaviour: dialog role + accessible
 * name, Escape-to-close (and the closeOnEscape opt-out), and focus
 * management (focus-on-open, restore-on-close).
 */
import { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import Modal from "../../src/components/ui/Modal";

afterEach(cleanup);

describe("Modal — accessibility", () => {
  it("exposes role=dialog, aria-modal, and an accessible name from the title", () => {
    render(
      <Modal open onClose={() => {}} title="Edit task">
        body
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "Edit task" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("renders nothing when closed", () => {
    render(
      <Modal open={false} onClose={() => {}} title="Hidden">
        body
      </Modal>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves focus to the dialog on open", () => {
    render(
      <Modal open onClose={() => {}} title="Focus me">
        body
      </Modal>,
    );
    expect(screen.getByRole("dialog")).toHaveFocus();
  });

  it("closes on Escape by default", async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Closable">
        body
      </Modal>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the X icon button is clicked", async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Has a close button">
        body
      </Modal>,
    );
    // The close control is an icon button with an accessible name, not
    // literal "Close" text.
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on Escape when closeOnEscape is false", async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Owns its escape" closeOnEscape={false}>
        body
      </Modal>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on overlay click but not on card click", async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Overlay">
        <button>inside</button>
      </Modal>,
    );
    await userEvent.click(screen.getByText("inside"));
    expect(onClose).not.toHaveBeenCalled();
    // The overlay is the dialog's parent element.
    const overlay = screen.getByRole("dialog").parentElement!;
    await userEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the trigger after closing", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          <Modal open={open} onClose={() => setOpen(false)} title="Restore">
            body
          </Modal>
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByText("Open");
    await userEvent.click(trigger);
    expect(screen.getByRole("dialog")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });
});
