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

// ── Active (open + in_progress) ───────────────────────────────────────────────

/**
 * The one definition of "active" work: open and in progress. Review is its own
 * scope and a draft in backlog is not started, so neither counts. Home's
 * "Active" tile and widget, its "Your projects" strip and the "N active
 * tasks" on /projects all go through this list, so the same project shows the
 * same number everywhere. The backend's `counts.open` is the same two
 * statuses.
 */
export const ACTIVE_STATUSES = ["open", "in_progress"] as const;

/** `status` query value for a request that fetches the active scope. */
export const ACTIVE_STATUS_PARAM = ACTIVE_STATUSES.join(",");

export function isActiveTask(t: Pick<Task, "status">): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(t.status);
}

// ── Widget requests ───────────────────────────────────────────────────────────

/** Rows a widget shows before its "+N more" link. */
export const WIDGET_LIMIT = 10;

/**
 * The active widget also feeds the per-project counts of the "Your projects"
 * strip, which are only shown when this fetch is provably complete
 * (`counts.open <= rows`). The backend's default page size, so the request
 * is no bigger than the one Home used to make for everything.
 */
export const ACTIVE_FETCH_LIMIT = 500;

export type WidgetKey = "mine" | "priority" | "backlog" | "open" | "review" | "done";

export interface WidgetRequest {
  status: string;
  priority?: string;
  mine?: boolean;
  recency?: "recent";
  limit: number;
}

/**
 * One scoped request per widget, so a widget's rows come from its own scope
 * and not from whatever happens to be in one capped slice of the whole team
 * (the backend returns at most 500 rows per call, newest update first).
 * `counts` in every response is team-wide and independent of these filters.
 * Statuses follow the `/tasks` scope presets, except `mine`, which spans every
 * non-terminal status of the built-in workflow like the backend's `counts.mine`.
 */
export const WIDGET_REQUESTS: Record<WidgetKey, WidgetRequest> = {
  mine: { status: "backlog,open,in_progress,review", mine: true, limit: WIDGET_LIMIT },
  priority: { status: "open,in_progress,review", priority: "CRITICAL,HIGH", limit: WIDGET_LIMIT },
  backlog: { status: "backlog", limit: WIDGET_LIMIT },
  open: { status: ACTIVE_STATUS_PARAM, limit: ACTIVE_FETCH_LIMIT },
  review: { status: "review", limit: WIDGET_LIMIT },
  done: { status: "done", recency: "recent", limit: WIDGET_LIMIT },
};
