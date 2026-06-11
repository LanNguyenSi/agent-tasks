// 8px dot + label chip for task status.
// Styling is driven by lib/status.ts token names via CSS modifier classes
// in globals.css. Unknown statuses fall back to neutral (grey/open) styling
// with the raw status value as the label.
//
// Usage:
//   <StatusChip status="in-progress" />
//   <StatusChip status="custom-wf-state" />   ← unknown: grey fallback

import { STATUS_LABELS } from "@/lib/status";

interface StatusChipProps {
  status: string;
  className?: string;
}

// Map API status strings to CSS modifier class suffixes.
const STATUS_CLASS_MAP: Record<string, string> = {
  open: "open",
  "in-progress": "in-progress",
  review: "review",
  done: "done",
};

export function StatusChip({ status, className }: StatusChipProps) {
  const modifier = STATUS_CLASS_MAP[status] ?? "unknown";
  const label = STATUS_LABELS[status] ?? status;

  return (
    <span
      className={[
        "status-chip",
        `status-chip--${modifier}`,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="status-chip-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
