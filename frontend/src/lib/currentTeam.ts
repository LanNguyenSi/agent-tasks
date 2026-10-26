/**
 * The single current-team rule for the app pages (/home, /tasks, /projects).
 *
 * One team is "current" per user. The precedence is:
 *
 *   1. the team named by `?teamId` in the page URL (explicit navigation wins);
 *   2. the team id remembered in localStorage under `agent-tasks:lastTeamId`
 *      (written by rememberTeam, same key the Projects page switcher always used);
 *   3. the first team of the list;
 *   4. `null` when the user has no teams at all (callers render their
 *      zero-team state or redirect to /onboarding when `needsOnboarding`
 *      holds, see lib/access.ts).
 *
 * `pickCurrentTeam` is the pure core (both ids passed in, no I/O) so the
 * precedence matrix is testable in the node environment. `resolveCurrentTeam`
 * is the page-facing entry point: it layers the localStorage read on top.
 * The read is side-effect-free and treats blocked/absent storage as absent.
 *
 * Remembering a URL-selected team is deliberately the callers' job
 * (`if (team.id === urlTeamId) rememberTeam(team.id)`) so this module stays
 * pure except for `rememberTeam`.
 *
 * Mirrors the pattern in lib/teamsPrefs.ts.
 */

/** localStorage key of the last team the user picked (predates this module). */
export const LAST_TEAM_KEY = "agent-tasks:lastTeamId";

/** Minimal structural bound so the helper works with `Team` and test fakes. */
interface HasId {
  id: string;
}

/**
 * Pure precedence: URL id -> stored id -> first team -> null. An id that
 * matches no team is ignored (an invalid URL or stale stored id falls through
 * to the next tier instead of resolving to nothing).
 */
export function pickCurrentTeam<T extends HasId>(
  teams: T[],
  opts: { urlTeamId?: string | null; storedTeamId?: string | null },
): T | null {
  const { urlTeamId, storedTeamId } = opts;
  const fromUrl = urlTeamId ? teams.find((t) => t.id === urlTeamId) : undefined;
  if (fromUrl) return fromUrl;
  const fromStored = storedTeamId
    ? teams.find((t) => t.id === storedTeamId)
    : undefined;
  if (fromStored) return fromStored;
  return teams[0] ?? null;
}

/** Read the remembered team id; blocked or absent storage behaves as absent. */
export function readRememberedTeamId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LAST_TEAM_KEY);
  } catch {
    // localStorage can throw in private mode — treat as absent.
    return null;
  }
}

/** Persist the current team id; blocked storage contexts silently no-op. */
export function rememberTeam(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_TEAM_KEY, id);
  } catch {
    // No-op for blocked storage contexts.
  }
}

/**
 * Page-facing resolution: reads the remembered team id and applies the
 * precedence in `pickCurrentTeam`. Returns null only for an empty team list.
 */
export function resolveCurrentTeam<T extends HasId>(
  teams: T[],
  opts: { urlTeamId?: string | null },
): T | null {
  return pickCurrentTeam(teams, {
    urlTeamId: opts.urlTeamId,
    storedTeamId: readRememberedTeamId(),
  });
}
