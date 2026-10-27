"use client";

// Portal-rendered dropdown panel.
// Position/flip logic shared with Select via usePopover hook.
// Panel geometry (.app-dropdown-menu) is in globals.css (including z-index: 120).
// Only truly dynamic values (top, left, minWidth, visibility) are in the style prop.
//
// Keyboard behaviour:
//   - First focusable item receives focus when the menu opens.
//   - ArrowDown / ArrowUp / Home / End cycle through focusable items.
//   - Escape closes the menu and restores focus to the trigger.
//   - An item with aria-disabled="true" is never activated: the panel
//     swallows clicks and Enter/Space on it (a role="menuitem" one stays
//     focusable, see getFocusableItems).
//   - While open, the panel isolates keydown: no key typed inside it reaches
//     the page (window-level shortcuts stay silent), see handleKeyDown.

import { type CSSProperties, type ReactNode, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { usePopover } from "./usePopover";

interface DropdownMenuProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: "start" | "end";
  minWidth?: number;
  offset?: number;
  className?: string;
}

/** Collect the menu items keyboard focus can land on. Disabled items are
 *  skipped, with one exception: an explicit role="menuitem" carrying
 *  aria-disabled="true" stays in the cycle (focusable, announced as
 *  disabled), so a menu whose only entry is unavailable still gives focus
 *  something to land on; the panel never activates such an item (see
 *  disabledItemOf). Skipped: a disabled button, an element with the
 *  .app-dropdown-item-disabled class (unless it is such a disabled
 *  menuitem), and any other element with aria-disabled="true". */
function getFocusableItems(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], [role="menuitem"]',
    ),
  ).filter((el) => {
    if (el.getAttribute("role") === "menuitem" && el.getAttribute("aria-disabled") === "true") {
      return true;
    }
    return (
      !el.classList.contains("app-dropdown-item-disabled") &&
      el.getAttribute("aria-disabled") !== "true"
    );
  });
}

/** The aria-disabled="true" element inside `panel` that `target` sits in,
 *  or null. Clicks and Enter/Space on it are swallowed by the panel, so an
 *  item announced as disabled never runs a handler or follows a link. */
function disabledItemOf(panel: HTMLElement | null, target: EventTarget | null): Element | null {
  if (!panel || !(target instanceof Element)) return null;
  const item = target.closest('[aria-disabled="true"]');
  return item && panel.contains(item) ? item : null;
}

export default function DropdownMenu({
  anchorRef,
  open,
  onClose,
  children,
  align = "end",
  minWidth = 200,
  offset = 8,
  className,
}: DropdownMenuProps) {
  const { panelRef, positionStyle, positionReady, mounted } = usePopover({
    anchorRef,
    open,
    onClose,
    align,
    minWidth,
    offset,
  });

  // Focus the first menu item when the menu opens.
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => {
      if (!panelRef.current) return;
      const items = getFocusableItems(panelRef.current);
      items[0]?.focus();
    }, 0);
    return () => window.clearTimeout(id);
    // panelRef is a stable ref -- safe to omit from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keydown isolation while the menu is open, for every caller. The panel is
  // portaled to document.body, but React events bubble through the portal
  // along the React tree, and stopping the synthetic event here also stops the
  // underlying native event before it reaches window/document -- so a page's
  // window-level shortcuts ("/" and "C" on /tasks) never fire on a key typed
  // inside the open menu (previously only the /tasks row menu did this with a
  // per-caller wrapper; the account menu, the team menu and the project picker
  // leaked their keys to the page). It does not swallow the panel's own
  // handling: stopPropagation only halts further bubbling, and Escape never
  // gets here at all -- usePopover consumes it in a document capture-phase
  // listener (which runs before this bubble handler) and closes the menu.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (!panelRef.current) return;
      const items = getFocusableItems(panelRef.current);
      if (!items.length) return;
      const currentIdx = items.indexOf(document.activeElement as HTMLElement);

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          items[(currentIdx < items.length - 1 ? currentIdx + 1 : 0)]?.focus();
          break;
        case "ArrowUp":
          e.preventDefault();
          items[(currentIdx > 0 ? currentIdx - 1 : items.length - 1)]?.focus();
          break;
        case "Home":
          e.preventDefault();
          items[0]?.focus();
          break;
        case "End":
          e.preventDefault();
          items[items.length - 1]?.focus();
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          // Restore focus to the trigger element.
          window.setTimeout(() => anchorRef.current?.focus(), 0);
          break;
        default:
          break;
      }
    },
    // panelRef and anchorRef are stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onClose],
  );

  // Capture phase, so the panel sees the event before the item's own
  // handlers: stopping it here keeps a disabled item's onClick/onKeyDown
  // from running, and preventDefault cancels a link's navigation or a
  // button's native activation.
  const handleClickCapture = useCallback((e: React.MouseEvent) => {
    if (!disabledItemOf(panelRef.current, e.target)) return;
    e.preventDefault();
    e.stopPropagation();
  }, [panelRef]);

  const handleKeyDownCapture = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (!disabledItemOf(panelRef.current, e.target)) return;
    e.preventDefault();
    e.stopPropagation();
  }, [panelRef]);

  if (!open || !mounted) return null;

  // position, minWidth, and visibility are truly dynamic values.
  // z-index lives in .app-dropdown-menu CSS (always 120 for this overlay layer).
  const dynamicStyle: CSSProperties = {
    /* dynamic: computed position from usePopover */
    ...positionStyle,
    /* dynamic: minWidth prop */
    minWidth,
    /* dynamic: hidden until first position computation is ready */
    visibility: positionReady ? "visible" : "hidden",
  };

  return createPortal(
    <div
      ref={panelRef}
      className={["app-dropdown-menu", className].filter(Boolean).join(" ")}
      onClickCapture={handleClickCapture}
      onKeyDownCapture={handleKeyDownCapture}
      onKeyDown={handleKeyDown}
      // eslint-disable-next-line no-restricted-syntax
      style={dynamicStyle}
    >
      {children}
    </div>,
    document.body,
  );
}
