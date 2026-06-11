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

/** Collect focusable, non-disabled menu items from a container element. */
function getFocusableItems(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], [role="menuitem"]:not([aria-disabled="true"])',
    ),
  ).filter(
    (el) =>
      !el.classList.contains("app-dropdown-item-disabled") &&
      el.getAttribute("aria-disabled") !== "true",
  );
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

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
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
      onKeyDown={handleKeyDown}
      // eslint-disable-next-line no-restricted-syntax
      style={dynamicStyle}
    >
      {children}
    </div>,
    document.body,
  );
}
