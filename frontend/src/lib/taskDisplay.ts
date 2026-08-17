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

/**
 * True when a search query looks like a UUID/hex id fragment: 4+ chars of
 * hex digits and/or dashes, case-insensitive. Task ids are lowercase v4
 * UUIDs (see backend/prisma/schema.prisma). Gates the id-prefix search
 * match (below) onto only queries that plausibly denote a short id/UUID
 * fragment, so an ordinary title search doesn't also pull in id matches.
 */
export function looksLikeIdFragment(query: string): boolean {
  return /^[0-9a-f-]{4,}$/i.test(query);
}

/**
 * Dashboard search predicate (client-side filter for the board/list task
 * views): matches title/description/externalRef/labels (the existing
 * case-insensitive substring search), OR'd with an id-prefix match when
 * the query looks like a hex/UUID fragment. The id branch is additive
 * only: it never suppresses the text match, so pasting a short id (the
 * first 8 chars of a task's UUID, shown next to the title in the list
 * rows) finds the task even when that id text never appears in the title.
 */
export function matchesTaskSearch(task: Task, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  const lower = q.toLowerCase();
  const textMatch = `${task.title} ${task.description ?? ""} ${task.externalRef ?? ""} ${(task.labels ?? []).join(" ")}`
    .toLowerCase()
    .includes(lower);
  if (textMatch) return true;
  return looksLikeIdFragment(q) && task.id.toLowerCase().startsWith(lower);
}
