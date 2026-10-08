// Pure predicates behind the /home dashboard's widget filters. Split out of
// page.tsx (a Next.js page module, which can't carry extra named exports)
// so they stay unit-testable without rendering the full auth/team-fetching
// page.

import type { Task } from "../../lib/api";

/** Agent-created draft awaiting operator promotion out of backlog. */
export function isBacklogTask(t: Pick<Task, "status">): boolean {
  return t.status === "backlog";
}

/** Statuses that count as actionable work on the /home dashboard. */
const ACTIONABLE_STATUSES: ReadonlySet<string> = new Set(["open", "in_progress", "review"]);

/**
 * High/critical priority AND actionable: only open, in-progress or in-review
 * tasks. Done and abandoned tasks are finished, and backlog drafts are not
 * promoted yet (they surface in their own widget instead).
 */
// Kept in sync with the backend priorityCount query (routes/tasks.ts,
// counts.priority) and the /tasks scope=priority preset: all three use
// this status allowlist.
export function isPriorityTask(t: Pick<Task, "priority" | "status">): boolean {
  return (t.priority === "CRITICAL" || t.priority === "HIGH") && ACTIONABLE_STATUSES.has(t.status);
}
