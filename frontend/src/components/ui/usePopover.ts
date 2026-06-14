"use client";

// Shared portal + position/flip logic consumed by Select and DropdownMenu.
// Handles: portal mounting, anchor-relative fixed-position computation,
// scroll/resize repositioning, outside-click, and Escape-to-close.
//
// Only the two computed coordinates (top, left) and optional width are
// returned as positionStyle; all other panel geometry lives in CSS classes.
//
// Usage:
//   const { panelRef, positionStyle, positionReady, mounted } = usePopover({
//     anchorRef, open, onClose, align: "start", matchAnchorWidth: true,
//   });

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

export interface UsePopoverOptions {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  align?: "start" | "end";
  /** Minimum panel width in pixels. Ignored when matchAnchorWidth is true. */
  minWidth?: number;
  /** When true, panel width matches the anchor's rendered width. */
  matchAnchorWidth?: boolean;
  /** Vertical gap between anchor and panel. */
  offset?: number;
}

export interface UsePopoverResult {
  panelRef: RefObject<HTMLDivElement | null>;
  /**
   * Contains only truly dynamic values (top, left, optional width) computed
   * from getBoundingClientRect(). All other geometry lives in CSS.
   */
  positionStyle: CSSProperties;
  positionReady: boolean;
  mounted: boolean;
}

export function usePopover({
  anchorRef,
  open,
  onClose,
  align = "end",
  minWidth = 200,
  matchAnchorWidth = false,
  offset = 8,
}: UsePopoverOptions): UsePopoverResult {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [positionReady, setPositionReady] = useState(false);
  const [positionStyle, setPositionStyle] = useState<CSSProperties>({
    position: "fixed",
    top: -9999,
    left: -9999,
  });

  // Portal mount guard: createPortal needs the browser DOM.
  useEffect(() => {
    setMounted(true);
  }, []);

  const computePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    const anchorWidth = rect.width;
    const panelEl = panelRef.current;
    const effectiveWidth = matchAnchorWidth
      ? anchorWidth
      : Math.max(panelEl?.offsetWidth ?? minWidth, minWidth);
    const viewportPadding = 8;
    const maxLeft = window.innerWidth - effectiveWidth - viewportPadding;
    const idealLeft = align === "end" ? rect.right - effectiveWidth : rect.left;
    /* dynamic: computed from getBoundingClientRect() */
    const left = Math.min(Math.max(viewportPadding, idealLeft), maxLeft);

    // Flip to top if not enough space below
    const spaceBelow = window.innerHeight - rect.bottom - offset;
    const spaceAbove = rect.top - offset;
    const panelHeight = panelEl?.offsetHeight ?? 200;
    const showBelow = spaceBelow >= panelHeight || spaceBelow >= spaceAbove;
    /* dynamic: computed from getBoundingClientRect() */
    const top = showBelow
      ? rect.bottom + offset
      : Math.max(viewportPadding, rect.top - offset - panelHeight);

    const style: CSSProperties = {
      position: "fixed",
      /* dynamic: computed anchor position */
      top,
      left,
    };
    if (matchAnchorWidth) {
      /* dynamic: matches anchor element's rendered width */
      style.width = anchorWidth;
    }
    setPositionStyle(style);
    setPositionReady(true);
  }, [align, anchorRef, matchAnchorWidth, minWidth, offset]);

  // Recompute when open changes or on scroll/resize
  useLayoutEffect(() => {
    if (!open) {
      setPositionReady(false);
      return;
    }
    computePosition();
    const rafId = window.requestAnimationFrame(computePosition);
    window.addEventListener("resize", computePosition);
    window.addEventListener("scroll", computePosition, true);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("resize", computePosition);
      window.removeEventListener("scroll", computePosition, true);
    };
  }, [computePosition, open]);

  // Outside click and Escape to close
  useEffect(() => {
    if (!open) return;

    function handlePointerDown(e: MouseEvent) {
      if (panelRef.current?.contains(e.target as Node)) return;
      if (anchorRef.current?.contains(e.target as Node)) return;
      onClose();
    }

    function handleEscape(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      onClose();
      // Restore focus to the trigger. Because the capture-phase
      // stopPropagation below halts the event at document, the inner
      // component's own keydown handler never runs, so any focus-restore it
      // would have performed must happen here. DropdownMenu moves focus into
      // the menu on open and relied on its Escape handler to return focus to
      // the anchor; doing it centrally keeps that behavior. For Select (focus
      // never leaves the trigger) this is a no-op.
      anchorRef.current?.focus();
      // Consume the event so it does not reach Modal's bubble-phase Escape
      // handler. Capture phase (used below) always runs before bubble phase,
      // making this deterministic regardless of listener registration order.
      // The listener is only registered while a popover is open, so when
      // nothing is open this stopPropagation is never called and Escape
      // propagates normally to the Modal.
      e.stopPropagation();
    }

    document.addEventListener("mousedown", handlePointerDown);
    // Capture phase: fires before any bubble-phase listener (including Modal),
    // regardless of which listener was registered first.
    document.addEventListener("keydown", handleEscape, { capture: true });
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      // Must pass { capture: true } to match the registration; omitting it
      // would target the bubble-phase slot and leave the capture listener
      // alive, causing a ghost handler and listener leaks.
      document.removeEventListener("keydown", handleEscape, { capture: true });
    };
  }, [anchorRef, onClose, open]);

  return { panelRef, positionStyle, positionReady, mounted };
}
