/** @vitest-environment jsdom */
/**
 * ui/DropdownMenu: which items keyboard focus can land on, and that an item
 * announced as disabled is never activated.
 *
 * Focus (first item on open, ArrowDown/ArrowUp cycle):
 *   - skipped: a disabled button, an element with the
 *     .app-dropdown-item-disabled class, and an element that is not a
 *     menuitem but carries aria-disabled="true";
 *   - kept: an explicit role="menuitem" with aria-disabled="true" (also with
 *     the disabled class), so a menu whose only entry is unavailable still
 *     has somewhere to put focus.
 * Activation: a click, Enter or Space on an aria-disabled="true" item does
 * not run its handlers, does not follow its link and leaves the menu open;
 * enabled items keep working (the control cases).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { useRef, type ReactNode } from "react";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DropdownMenu from "../../src/components/ui/DropdownMenu";

afterEach(cleanup);

function Harness({ children, onClose = () => {} }: { children: ReactNode; onClose?: () => void }) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchorRef} type="button">
        Trigger
      </button>
      <DropdownMenu anchorRef={anchorRef} open onClose={onClose}>
        {children}
      </DropdownMenu>
    </>
  );
}

function panel(): HTMLElement {
  return document.querySelector(".app-dropdown-menu") as HTMLElement;
}

/** Wait for the open-time focus (DropdownMenu focuses on a 0ms timer). */
async function expectInitialFocus(text: string): Promise<void> {
  await waitFor(() => expect(document.activeElement).toHaveTextContent(text));
}

/** Text of the items focus visits from the initial one, `steps` ArrowDowns. */
async function cycle(steps: number): Promise<string[]> {
  const seen = [document.activeElement?.textContent ?? ""];
  for (let i = 0; i < steps; i++) {
    await userEvent.keyboard("{ArrowDown}");
    seen.push(document.activeElement?.textContent ?? "");
  }
  return seen;
}

describe("DropdownMenu focusable items", () => {
  it("skips a button styled .app-dropdown-item-disabled", async () => {
    render(
      <Harness>
        <button type="button" className="app-dropdown-item app-dropdown-item-disabled">
          Looks disabled
        </button>
        <button type="button" className="app-dropdown-item">
          Enabled
        </button>
      </Harness>,
    );
    await expectInitialFocus("Enabled");
    expect(await cycle(2)).toEqual(["Enabled", "Enabled", "Enabled"]);
  });

  it("skips a menuitem styled .app-dropdown-item-disabled that is not aria-disabled", async () => {
    render(
      <Harness>
        <div role="menu">
          <span role="menuitem" tabIndex={-1} className="app-dropdown-item app-dropdown-item-disabled">
            Styled only
          </span>
          <button type="button" role="menuitem" className="app-dropdown-item">
            Enabled
          </button>
        </div>
      </Harness>,
    );
    await expectInitialFocus("Enabled");
    expect(await cycle(1)).toEqual(["Enabled", "Enabled"]);
  });

  it("skips a non-menuitem button or link with aria-disabled=\"true\"", async () => {
    render(
      <Harness>
        <button type="button" aria-disabled="true" className="app-dropdown-item">
          Aria-disabled button
        </button>
        <a href="/elsewhere" aria-disabled="true" className="app-dropdown-item">
          Aria-disabled link
        </a>
        <button type="button" className="app-dropdown-item">
          Enabled
        </button>
      </Harness>,
    );
    await expectInitialFocus("Enabled");
    expect(await cycle(2)).toEqual(["Enabled", "Enabled", "Enabled"]);
  });

  it("skips a disabled button", async () => {
    render(
      <Harness>
        <button type="button" disabled className="app-dropdown-item">
          Disabled
        </button>
        <button type="button" className="app-dropdown-item">
          Enabled
        </button>
      </Harness>,
    );
    await expectInitialFocus("Enabled");
  });

  it("keeps a role=\"menuitem\" with aria-disabled=\"true\" in the cycle", async () => {
    render(
      <Harness>
        <div role="menu">
          <p role="menuitem" aria-disabled="true" tabIndex={-1} className="app-dropdown-item">
            Unavailable
          </p>
          <button type="button" role="menuitem" className="app-dropdown-item">
            Next
          </button>
        </div>
      </Harness>,
    );
    await expectInitialFocus("Unavailable");
    expect(await cycle(2)).toEqual(["Unavailable", "Next", "Unavailable"]);
  });

  it("keeps an aria-disabled menuitem that also has the disabled class (the only item)", async () => {
    render(
      <Harness>
        <div role="menu">
          <p
            role="menuitem"
            aria-disabled="true"
            tabIndex={-1}
            className="app-dropdown-item app-dropdown-item-disabled"
          >
            Only entry
          </p>
        </div>
      </Harness>,
    );
    await expectInitialFocus("Only entry");
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByText("Only entry")).toHaveFocus();
  });
});

describe("DropdownMenu never activates an aria-disabled item", () => {
  function renderDisabledItems() {
    const onDisabledClick = vi.fn();
    const onDisabledKeyDown = vi.fn();
    const onLinkClick = vi.fn();
    const onEnabledClick = vi.fn();
    const onClose = vi.fn();
    render(
      <Harness onClose={onClose}>
        <div role="menu">
          <button
            type="button"
            role="menuitem"
            aria-disabled="true"
            className="app-dropdown-item"
            onClick={onDisabledClick}
            onKeyDown={onDisabledKeyDown}
          >
            Unavailable action
          </button>
          <a
            href="/elsewhere"
            role="menuitem"
            aria-disabled="true"
            className="app-dropdown-item"
            onClick={onLinkClick}
          >
            Unavailable link
          </a>
          <button type="button" role="menuitem" className="app-dropdown-item" onClick={onEnabledClick}>
            Available action
          </button>
        </div>
      </Harness>,
    );
    return { onDisabledClick, onDisabledKeyDown, onLinkClick, onEnabledClick, onClose };
  }

  it("a click on it runs no handler and leaves the menu open", async () => {
    const spies = renderDisabledItems();
    await userEvent.click(screen.getByRole("menuitem", { name: "Unavailable action" }));
    expect(spies.onDisabledClick).not.toHaveBeenCalled();
    expect(spies.onClose).not.toHaveBeenCalled();
    expect(panel()).not.toBeNull();
  });

  it("a click on a child of it (its text wrapper) runs no handler either", () => {
    const onClick = vi.fn();
    render(
      <Harness>
        <div role="menu">
          <button type="button" role="menuitem" aria-disabled="true" onClick={onClick}>
            <span>Wrapped label</span>
          </button>
        </div>
      </Harness>,
    );
    fireEvent.click(screen.getByText("Wrapped label"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
  ])("%s on it runs neither its key handler nor its click handler", async (_label, key) => {
    const spies = renderDisabledItems();
    await expectInitialFocus("Unavailable action");
    await userEvent.keyboard(key);
    expect(spies.onDisabledKeyDown).not.toHaveBeenCalled();
    expect(spies.onDisabledClick).not.toHaveBeenCalled();
    expect(spies.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("menuitem", { name: "Unavailable action" })).toHaveFocus();
  });

  it("Enter on it is default-prevented (no native activation)", async () => {
    renderDisabledItems();
    const notCanceled = fireEvent.keyDown(screen.getByRole("menuitem", { name: "Unavailable action" }), {
      key: "Enter",
    });
    expect(notCanceled).toBe(false);
  });

  it("a click on an aria-disabled link runs no handler and does not follow it", () => {
    const spies = renderDisabledItems();
    const notCanceled = fireEvent.click(screen.getByRole("menuitem", { name: "Unavailable link" }));
    expect(notCanceled).toBe(false);
    expect(spies.onLinkClick).not.toHaveBeenCalled();
  });

  it("control: an enabled item still runs on click and on Enter", async () => {
    const spies = renderDisabledItems();
    await userEvent.click(screen.getByRole("menuitem", { name: "Available action" }));
    expect(spies.onEnabledClick).toHaveBeenCalledTimes(1);
    screen.getByRole("menuitem", { name: "Available action" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(spies.onEnabledClick).toHaveBeenCalledTimes(2);
  });

  it("control: other keys on a disabled item still reach the menu (ArrowDown moves focus)", async () => {
    renderDisabledItems();
    await expectInitialFocus("Unavailable action");
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Unavailable link" })).toHaveFocus();
  });
});
