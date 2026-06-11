// Empty-state component, centered stack with optional icon, title, description,
// and action slot. All geometry in .empty-state-* classes in globals.css.
//
// Backward compat: existing call sites that pass message= still work (title
// alias). The dashed prop adds a dashed border variant.
//
// Usage:
//   <EmptyState
//     icon="box"
//     title="No tasks yet"
//     description="Create your first task to get started."
//     dashed
//     action={<Button size="sm">New task</Button>}
//   />
//   // Legacy:
//   <EmptyState message="Nothing here." action={<a href="#">Create</a>} />

import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

interface EmptyStateProps {
  /** Icon drawn above the title. */
  icon?: IconName;
  /** Primary text. */
  title?: string;
  /** Secondary text below the title. */
  description?: string;
  /**
   * @deprecated Use `title` instead. Kept for backward compatibility with
   * existing call sites that pass a `message` prop.
   */
  message?: string;
  /** Action slot rendered below the description (e.g. a Button). */
  action?: ReactNode;
  /** Dashed hairline border variant. */
  dashed?: boolean;
  className?: string;
}

export default function EmptyState({
  icon,
  title,
  description,
  message,
  action,
  dashed = false,
  className,
}: EmptyStateProps) {
  // message is the legacy prop, fall back to it when title is not provided.
  const displayTitle = title ?? message;

  return (
    <div
      className={["empty-state", dashed ? "empty-state--dashed" : "", className]
        .filter(Boolean)
        .join(" ")}
    >
      {icon && (
        <span className="empty-state-icon" aria-hidden="true">
          <Icon name={icon} size={32} />
        </span>
      )}
      {displayTitle && <p className="empty-state-title">{displayTitle}</p>}
      {description && <p className="empty-state-description">{description}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
