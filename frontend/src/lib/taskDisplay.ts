// Shared task display utilities consumed across dashboard components and home.
// Single source of truth for helpers that were previously duplicated in
// dashboard/BoardView.tsx and dashboard/TaskListView.tsx.
//
// See also: lib/status.ts (STATUS_LABELS, STATUS_COLORS, KNOWN_STATUSES).

import type { Task } from "./api";

/** Normalize API underscore status values to hyphenated CSS/lib keys. */
export function normalizeStatus(s: string): string {
  return s.replace(/_/g, "-");
}

/** True when a task has a due date in the past and is not yet done. */
export function isOverdue(task: Task): boolean {
  if (!task.dueAt || task.status === "done") return false;
  return new Date(task.dueAt).getTime() < Date.now();
}

/**
 * Format an ISO date string as YYYY-MM-DD for compact date display.
 * Returns "" when value is null.
 */
export function toDateLabel(value: string | null): string {
  if (!value) return "";
  return value.slice(0, 10);
}

/** Human-readable assignee name for display in tables and cards. */
export function getAssigneeName(task: Task): string {
  if (task.claimedByUser) return task.claimedByUser.name ?? task.claimedByUser.login;
  if (task.claimedByAgent) return `Agent ${task.claimedByAgent.name}`;
  return "Unassigned";
}

/** Sort rank for task priority: lower number = higher priority. */
export const PRIORITY_RANK: Record<string, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};
