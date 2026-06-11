// Card primitive — all geometry in CSS classes (globals.css .card--*).
// surface prop: "surface" (default, --surface bg) | "raised" (--surface-raised bg).
// dashed and interactive modifier props are additive.
//
// The style prop is kept for caller-owned dynamic overrides only; the Card
// component itself carries no inline geometry.

import type { CSSProperties, ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  padding?: "sm" | "md";
  dashed?: boolean;
  interactive?: boolean;
  /** Elevation step: "surface" (panel) or "raised" (card/modal). */
  surface?: "surface" | "raised";
  /** Kept for caller-owned dynamic values only. */
  style?: CSSProperties;
}

export default function Card({
  children,
  className,
  padding = "md",
  dashed = false,
  interactive = false,
  surface = "surface",
  style,
}: CardProps) {
  return (
    <div
      className={[
        "card",
        `card--${surface}`,
        dashed ? "card--dashed" : "",
        interactive ? "card--interactive" : "",
        `card--padding-${padding}`,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
    >
      {children}
    </div>
  );
}
