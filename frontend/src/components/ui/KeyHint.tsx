// Small monospace key chip (e.g. "/", "C", "⌘↵").
// Geometry and color live in .key-hint in globals.css.
//
// Usage: <KeyHint>/<KeyHint>   <KeyHint>⌘↵</KeyHint>

import type { ReactNode } from "react";

interface KeyHintProps {
  children: ReactNode;
  className?: string;
}

export function KeyHint({ children, className }: KeyHintProps) {
  return (
    <span className={["key-hint", className].filter(Boolean).join(" ")}>
      {children}
    </span>
  );
}
