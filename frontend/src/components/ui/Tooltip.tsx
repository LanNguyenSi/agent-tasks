// Tooltip: shows on hover (200ms delay) AND focus (immediate).
// role=tooltip per ARIA spec; positioned above by default with a
// viewport-edge flip via data-side="bottom" when near the top edge.
// Pure CSS transform positioning; JS handles the flip detection.
//
// Usage:
//   <Tooltip content="Copy to clipboard">
//     <button>Copy</button>
//   </Tooltip>

"use client";

import {
  useRef,
  useState,
  useEffect,
  useId,
  type ReactNode,
} from "react";

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Tooltip({ content, children, className }: TooltipProps) {
  const id = useId();
  const tooltipId = `tooltip-${id.replace(/:/g, "")}`;
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const [side, setSide] = useState<"top" | "bottom">("top");

  // Detect viewport-edge flip: if the wrapper is near the top edge,
  // render the tooltip below instead.
  useEffect(() => {
    function updateSide() {
      if (!wrapperRef.current) return;
      const rect = wrapperRef.current.getBoundingClientRect();
      // If fewer than 60px above the trigger, flip to bottom
      setSide(rect.top < 60 ? "bottom" : "top");
    }
    updateSide();
    window.addEventListener("scroll", updateSide, { passive: true });
    window.addEventListener("resize", updateSide, { passive: true });
    return () => {
      window.removeEventListener("scroll", updateSide);
      window.removeEventListener("resize", updateSide);
    };
  }, []);

  return (
    <span
      ref={wrapperRef}
      className={["tooltip-wrapper", className].filter(Boolean).join(" ")}
    >
      {children}
      <span
        ref={tooltipRef}
        role="tooltip"
        id={tooltipId}
        className="tooltip-content"
        data-side={side}
      >
        {content}
      </span>
    </span>
  );
}
