// Status chip data mapped to design-token CSS var names so they adapt to
// light/dark and remain consistent across every task surface.
// Single source of truth: mirrors the pattern in lib/priorityColors.ts.
// Keys are the task Status field values from the API.
// Unknown statuses fall back to the open (grey) treatment in consumers.

export const STATUS_LABELS: Record<string, string> = {
  open: "Open",
  "in-progress": "In Progress",
  review: "Review",
  done: "Done",
};

// CSS var() references for dot and text color per status.
// The chip fill (13% tint) and border are derived via color-mix() in the
// CSS modifier classes (.status-chip--open etc.) so they stay in CSS, not
// inline styles. These vars are for components that need programmatic access
// (e.g. custom workflow states that must fall back to the open treatment).
export const STATUS_COLORS: Record<string, { dot: string; text: string }> = {
  open: {
    dot: "var(--status-open)",
    text: "var(--status-open-text)",
  },
  "in-progress": {
    dot: "var(--status-in-progress)",
    text: "var(--status-in-progress-text)",
  },
  review: {
    dot: "var(--status-review)",
    text: "var(--status-review-text)",
  },
  done: {
    dot: "var(--status-done)",
    text: "var(--status-done-text)",
  },
};

// Canonical list of known standard status values.
export const KNOWN_STATUSES = Object.keys(STATUS_LABELS);
