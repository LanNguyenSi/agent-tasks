"use client";

import { useState, type ReactNode } from "react";

interface CollapsibleSectionProps {
  title: string;
  /** Optional count shown next to the title, e.g. "Activity (3)". Hidden when 0. */
  count?: number;
  /** Whether the section starts expanded. Defaults to collapsed. */
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * A section whose body collapses behind a clickable `section-kicker` header.
 * Used for the rarely-needed parts of the task detail modal so they stop
 * stretching the modal by default. Reset across tasks is done by the caller
 * keying the element (`key={task.id}`), so this stays state-only.
 */
export default function CollapsibleSection({ title, count, defaultOpen = false, children }: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section style={{ marginBottom: "0.8rem" }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.4rem",
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          width: "100%",
          textAlign: "left",
        }}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          aria-hidden="true"
          style={{ color: "var(--muted)", flexShrink: 0, transition: "transform 0.15s", transform: open ? "rotate(90deg)" : "none" }}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
        </svg>
        <span className="section-kicker" style={{ marginBottom: 0 }}>
          {title}
          {count !== undefined && count > 0 ? ` (${count})` : ""}
        </span>
      </button>
      {open && <div style={{ marginTop: "0.4rem" }}>{children}</div>}
    </section>
  );
}
