/**
 * Pure helpers + localStorage persistence for the /teams page view-mode
 * preference: "cards" (default for small team) or "table" (default for
 * large team). A stored preference acts as a sticky override.
 *
 * Mirrors the pattern in lib/dashboardPrefs.ts.
 */

export type TeamsViewMode = "table" | "cards";

/**
 * Project-count threshold: at or below this number the auto-default is
 * "cards"; above it the auto-default is "table".
 */
export const TEAMS_VIEW_THRESHOLD = 12;

const VIEW_MODE_KEY = "agent-tasks:teams:viewMode";

export function isTeamsViewMode(v: unknown): v is TeamsViewMode {
  return v === "table" || v === "cards";
}

/**
 * Read the stored view mode. Returns null when nothing valid is stored,
 * so the caller can distinguish a sticky preference from a missing one
 * (absence triggers the count-based auto-default).
 */
export function readStoredView(): TeamsViewMode | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(VIEW_MODE_KEY);
    if (isTeamsViewMode(raw)) return raw;
  } catch {
    // localStorage can throw in private mode — treat as absent.
  }
  return null;
}

export function storeView(v: TeamsViewMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VIEW_MODE_KEY, v);
  } catch {
    // No-op for blocked storage contexts.
  }
}

/**
 * Resolve the initial view mode.
 *
 * A stored preference is a sticky override. Absent one, auto-default by
 * project count: "cards" when few (≤ threshold), "table" when many.
 */
export function resolveInitialView(opts: {
  storedView: TeamsViewMode | null;
  projectCount: number;
  threshold?: number;
}): TeamsViewMode {
  const { storedView, projectCount, threshold = TEAMS_VIEW_THRESHOLD } = opts;
  return storedView ?? (projectCount <= threshold ? "cards" : "table");
}
