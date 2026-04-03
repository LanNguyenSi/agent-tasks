"use client";

import {
  useEffect,
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
  const [style, setStyle] = useState<CSSProperties>({});

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

      setStyle({
        position: "fixed",
        top: rect.bottom + offset,
        left,
        minWidth,
        zIndex: 120,
      });
    },
    [align, anchorRef, minWidth, offset],
  );

  useEffect(() => {
    if (!open) return;

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
    <div ref={panelRef} className={["app-dropdown-menu", className].filter(Boolean).join(" ")} style={style}>
      {children}
    </div>,
    document.body,
  );
}

