// 10px/600 uppercase priority text in --priority-* color.
// Per design: NEVER a chip, always bare micro text.
// Carries aria-label="Priority: X" so the encoding is not color-only.
//
// Usage: <PriorityLabel priority="high" />

interface PriorityLabelProps {
  priority: string;
  className?: string;
}

// Map priority strings to CSS modifier class suffixes.
const PRIORITY_CLASS_MAP: Record<string, string> = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  // Also accept lowercase variants from API
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
};

export function PriorityLabel({ priority, className }: PriorityLabelProps) {
  const modifier = PRIORITY_CLASS_MAP[priority] ?? "low";
  const label = priority.charAt(0).toUpperCase() + priority.slice(1).toLowerCase();

  return (
    <span
      className={[
        "priority-label",
        `priority-label--${modifier}`,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={`Priority: ${label}`}
    >
      {label}
    </span>
  );
}
