"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

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
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [positionReady, setPositionReady] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({
    position: "fixed",
    top: -9999,
    left: -9999,
    minWidth,
    zIndex: 120,
  });

  useEffect(() => {
    setMounted(true);
  }, []);

  const computePosition = useMemo(
    () => () => {
      const anchor = anchorRef.current;
      if (!anchor) return;

      const rect = anchor.getBoundingClientRect();
      const panelWidth = Math.max(panelRef.current?.offsetWidth ?? minWidth, minWidth);
      const viewportPadding = 8;
      const maxLeft = window.innerWidth - panelWidth - viewportPadding;
      const idealLeft = align === "end" ? rect.right - panelWidth : rect.left;
      const left = Math.min(Math.max(viewportPadding, idealLeft), maxLeft);
      const top = Math.min(rect.bottom + offset, window.innerHeight - viewportPadding);

      setStyle({
        position: "fixed",
        top,
        left,
        minWidth,
        zIndex: 120,
      });
      setPositionReady(true);
    },
    [align, anchorRef, minWidth, offset],
  );

  useLayoutEffect(() => {
    if (!open) return;

    setPositionReady(false);
    computePosition();
    const rafId = window.requestAnimationFrame(computePosition);

    function handleResizeOrScroll() {
      computePosition();
    }

    window.addEventListener("resize", handleResizeOrScroll);
    window.addEventListener("scroll", handleResizeOrScroll, true);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("resize", handleResizeOrScroll);
      window.removeEventListener("scroll", handleResizeOrScroll, true);
    };
  }, [computePosition, open]);

  useEffect(() => {
    if (!open) setPositionReady(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [anchorRef, onClose, open]);

  if (!open || !mounted) return null;

  return createPortal(
    <div
      ref={panelRef}
      className={["app-dropdown-menu", className].filter(Boolean).join(" ")}
      style={{ ...style, visibility: positionReady ? "visible" : "hidden" }}
    >
      {children}
    </div>,
    document.body,
  );
}
