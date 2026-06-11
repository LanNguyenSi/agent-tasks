"use client";

// Portal-rendered dropdown panel.
// Position/flip logic shared with Select via usePopover hook.
// Panel geometry (.app-dropdown-menu) is in globals.css (including z-index: 120).
// Only truly dynamic values (top, left, minWidth, visibility) are in the style prop.

import { type CSSProperties, type ReactNode } from "react";
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
      style={dynamicStyle}
    >
      {children}
    </div>,
    document.body,
  );
}
