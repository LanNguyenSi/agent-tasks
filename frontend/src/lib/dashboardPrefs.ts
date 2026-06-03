/**
 * Pure helpers + localStorage persistence for the project dashboard's
 * view preferences: done-task visibility, view mode, and sort.
 *
 * Split out of `app/dashboard/page.tsx` so the done-visibility predicate
 * is unit-testable without a DOM, mirroring how `lib/theme.ts` and
 * `lib/workflow-draft.ts` isolate their pure cores.
 *
 * Note on "done age": there is no `completedAt` column on Task, so the
 * age of a done task is proxied by `updatedAt`. That is already the
 * board's done-column sort key, so the proxy is consistent with existing
 * behaviour. A done task that gets edited or commented on bumps
 * `updatedAt` and therefore re-counts as "recent" — intentional, so a
 * freshly revisited done task stays visible.
 */

export type DoneVisibility = "recent" | "all" | "none";
export type DashboardViewMode = "board" | "list";
export type SortDirection = "asc" | "desc";

export interface PersistedSort {
  column: string;
  direction: SortDirection;
}

/** Age window (in days) for the "recent" done filter. */
export const DONE_RECENT_DAYS = 14;
const DONE_RECENT_MS = DONE_RECENT_DAYS * 24 * 60 * 60 * 1000;

/** Max done cards rendered in the board column before the expander. */
export const DONE_BOARD_VISIBLE_LIMIT = 10;

export const DEFAULT_DONE_VISIBILITY: DoneVisibility = "recent";
export const DEFAULT_VIEW_MODE: DashboardViewMode = "board";

const DONE_VISIBILITY_KEY = "agent-tasks:dashboard:doneVisibility";
const VIEW_MODE_KEY = "agent-tasks:dashboard:viewMode";
const SORT_KEY = "agent-tasks:dashboard:sort";

export function isDoneVisibility(value: unknown): value is DoneVisibility {
  return value === "recent" || value === "all" || value === "none";
}

export function isViewMode(value: unknown): value is DashboardViewMode {
  return value === "board" || value === "list";
}

/**
 * Whether a done task is hidden under the given visibility.
 *
 * - `all`: never hidden.
 * - `none`: always hidden.
 * - `recent`: hidden when `updatedAt` is older than the window.
 *
 * An unparseable timestamp is treated as visible (fail open) so a bad
 * value never silently swallows a task.
 */
export function isDoneTaskHidden(
  visibility: DoneVisibility,
  updatedAt: string,
  now: number,
  windowMs: number = DONE_RECENT_MS,
): boolean {
  if (visibility === "all") return false;
  if (visibility === "none") return true;
  const updated = new Date(updatedAt).getTime();
  if (Number.isNaN(updated)) return false;
  return now - updated > windowMs;
}

export function readStoredDoneVisibility(): DoneVisibility {
  if (typeof window === "undefined") return DEFAULT_DONE_VISIBILITY;
  try {
    const raw = window.localStorage.getItem(DONE_VISIBILITY_KEY);
    if (isDoneVisibility(raw)) return raw;
  } catch {
    // localStorage can throw in private mode — fall back to default.
  }
  return DEFAULT_DONE_VISIBILITY;
}

export function storeDoneVisibility(value: DoneVisibility): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DONE_VISIBILITY_KEY, value);
  } catch {
    // No-op for blocked storage contexts.
  }
}

export function readStoredViewMode(): DashboardViewMode {
  if (typeof window === "undefined") return DEFAULT_VIEW_MODE;
  try {
    const raw = window.localStorage.getItem(VIEW_MODE_KEY);
    if (isViewMode(raw)) return raw;
  } catch {
    // localStorage can throw in private mode — fall back to default.
  }
  return DEFAULT_VIEW_MODE;
}

export function storeViewMode(value: DashboardViewMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VIEW_MODE_KEY, value);
  } catch {
    // No-op for blocked storage contexts.
  }
}

/**
 * Read a persisted sort, validating the column against the caller's
 * allowed set (the dashboard's `SortColumn` union) so a stale or
 * tampered value can never select an unknown column. Returns null when
 * nothing valid is stored.
 */
export function readStoredSort(validColumns: readonly string[]): PersistedSort | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SORT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const { column, direction } = parsed as Record<string, unknown>;
      if (
        typeof column === "string" &&
        validColumns.includes(column) &&
        (direction === "asc" || direction === "desc")
      ) {
        return { column, direction };
      }
    }
  } catch {
    // Malformed JSON or blocked storage — ignore and fall back.
  }
  return null;
}

export function storeSort(sort: PersistedSort): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SORT_KEY, JSON.stringify(sort));
  } catch {
    // No-op for blocked storage contexts.
  }
}
