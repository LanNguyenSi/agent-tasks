/**
 * Pure sorting logic for the /teams projects table.
 *
 * Extracted from the page component so the per-column comparators and the
 * header-click direction rule are unit-testable without rendering React.
 * The active-tasks comparator reads the asynchronously-loaded `taskCounts`
 * map (missing entry treated as 0), and the date comparators tolerate the
 * nullable `githubSyncAt` (manual projects) by falling back to epoch 0.
 */
import type { Project } from "./api";

export type ProjectSortColumn = "name" | "repo" | "activeTasks" | "createdAt" | "syncedAt";
export type SortDirection = "asc" | "desc";

// Columns whose natural first-click direction is ascending (alphabetical);
// numeric and date columns default to descending (highest / newest first),
// mirroring the /tasks table.
const NATURAL_ASC: readonly ProjectSortColumn[] = ["name", "repo"];

/** The direction a column adopts the first time it becomes the sort column. */
export function naturalDirection(column: ProjectSortColumn): SortDirection {
  return NATURAL_ASC.includes(column) ? "asc" : "desc";
}

/**
 * Resolve the next sort state when a sortable header is activated: flip the
 * direction when re-clicking the active column, otherwise switch column and
 * apply that column's natural first-click direction.
 */
export function nextSort(
  current: { column: ProjectSortColumn; direction: SortDirection },
  clicked: ProjectSortColumn,
): { column: ProjectSortColumn; direction: SortDirection } {
  if (clicked === current.column) {
    return { column: clicked, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { column: clicked, direction: naturalDirection(clicked) };
}

/** Ascending comparator for a single column. Negate for descending. */
export function compareProjects(
  a: Project,
  b: Project,
  column: ProjectSortColumn,
  taskCounts: Record<string, number>,
): number {
  switch (column) {
    case "name":
      return a.name.localeCompare(b.name);
    case "repo":
      return (a.githubRepo ?? "").localeCompare(b.githubRepo ?? "");
    case "activeTasks":
      return (taskCounts[a.id] ?? 0) - (taskCounts[b.id] ?? 0);
    case "createdAt":
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    case "syncedAt":
      return new Date(a.githubSyncAt ?? 0).getTime() - new Date(b.githubSyncAt ?? 0).getTime();
  }
}

/** Return a new array of projects sorted by the given column and direction. */
export function sortProjects(
  projects: Project[],
  column: ProjectSortColumn,
  direction: SortDirection,
  taskCounts: Record<string, number>,
): Project[] {
  return [...projects].sort((a, b) => {
    const cmp = compareProjects(a, b, column, taskCounts);
    return direction === "asc" ? cmp : -cmp;
  });
}
