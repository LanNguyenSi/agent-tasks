"use client";

// Collapsible section with animated chevron. All geometry in .collapsible-*
// classes in globals.css; no inline styles except the chevron rotation which
// is handled via a CSS modifier class.

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
export default function CollapsibleSection({
  title,
  count,
  defaultOpen = false,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="collapsible-section">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="collapsible-section-toggle"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          aria-hidden="true"
          className={["collapsible-chevron", open ? "collapsible-chevron--open" : ""].filter(Boolean).join(" ")}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
        </svg>
        <span className="section-kicker">
          {title}
          {count !== undefined && count > 0 ? ` (${count})` : ""}
        </span>
      </button>
      {open && <div className="collapsible-section-body">{children}</div>}
    </section>
  );
}
