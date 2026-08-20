// Pure predicates behind the /home dashboard's widget filters. Split out of
// page.tsx (a Next.js page module, which can't carry extra named exports)
// so they stay unit-testable without rendering the full auth/team-fetching
// page.

import type { Task } from "../../lib/api";

/** Agent-created draft awaiting operator promotion out of backlog. */
export function isBacklogTask(t: Pick<Task, "status">): boolean {
  return t.status === "backlog";
}

/**
 * High/critical priority AND actionable: excludes done (already finished)
 * and backlog (not yet promoted, so not actionable work). Backlog tasks
 * surface in their own widget instead.
 */
// Kept in sync with the backend priorityCount query (routes/tasks.ts,
// counts.priority): both exclude done and unpromoted backlog drafts.
export function isPriorityTask(t: Pick<Task, "priority" | "status">): boolean {
  return (t.priority === "CRITICAL" || t.priority === "HIGH") && t.status !== "done" && !isBacklogTask(t);
}
