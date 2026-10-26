/**
 * Recent projects per team, kept in localStorage for the Home "Your projects"
 * strip (UI/IA stage 1, T05): the board page records a visit when a project is
 * resolved, Home reads the list and orders its strip recents-first.
 *
 * Storage shape: a JSON array of project ids, most recent first, at most
 * `RECENT_PROJECTS_LIMIT` entries, under `agent-tasks:recentProjects:<teamId>`
 * so teams never share a list. Same guarded-storage pattern as
 * lib/dashboardPrefs.ts and lib/currentTeam.ts: every access is wrapped,
 * blocked or corrupt storage behaves as "no recents" and never throws.
 */

const RECENT_PROJECTS_KEY_PREFIX = "agent-tasks:recentProjects:";

/** Max project ids kept per team. */
export const RECENT_PROJECTS_LIMIT = 8;

/** Max projects the Home "Your projects" strip renders. */
export const HOME_PROJECTS_STRIP_LIMIT = 6;

function storageKey(teamId: string): string {
  return `${RECENT_PROJECTS_KEY_PREFIX}${teamId}`;
}

/**
 * Read the recent project ids for a team, most recent first. Absent,
 * unparseable, non-array or blocked storage yields an empty list; entries
 * that are not non-empty strings are dropped, then deduped (first occurrence
 * wins), then capped.
 */
export function readRecentProjects(teamId: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(teamId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const ids: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string" || item.length === 0) continue;
      if (!ids.includes(item)) ids.push(item);
      if (ids.length >= RECENT_PROJECTS_LIMIT) break;
    }
    return ids;
  } catch {
    // localStorage can throw in private mode — treat as no recents.
    return [];
  }
}

/**
 * Record a board visit: the id moves to the front (most recent), the list is
 * deduped, capped at `RECENT_PROJECTS_LIMIT`, and stored. Blank ids and
 * blocked storage silently no-op.
 */
export function recordRecentProject(teamId: string, projectId: string): void {
  if (typeof window === "undefined") return;
  if (!teamId || !projectId) return;
  try {
    const next = [
      projectId,
      ...readRecentProjects(teamId).filter((id) => id !== projectId),
    ].slice(0, RECENT_PROJECTS_LIMIT);
    window.localStorage.setItem(storageKey(teamId), JSON.stringify(next));
  } catch {
    // No-op for blocked storage contexts.
  }
}
