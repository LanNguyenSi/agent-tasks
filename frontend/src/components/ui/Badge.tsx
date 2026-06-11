// Small count or label badge with tinted fills.
// Tones match the status chip palette plus neutral and primary.
// Geometry lives in .badge and .badge--<tone> in globals.css.
//
// Usage:
//   <Badge tone="neutral">3</Badge>
//   <Badge tone="status-done">Done</Badge>

import type { ReactNode } from "react";

export type BadgeTone =
  | "neutral"
  | "primary"
  | "status-open"
  | "status-in-progress"
  | "status-review"
  | "status-done";

interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}

export function Badge({ children, tone = "neutral", className }: BadgeProps) {
  return (
    <span className={["badge", `badge--${tone}`, className].filter(Boolean).join(" ")}>
      {children}
    </span>
  );
}
