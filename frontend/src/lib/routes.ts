// Single owner of every in-app URL the UI/IA restructure (agent-tasks-ui-ia
// stage 1) may relocate. Each builder returned a string byte-identical to
// the hand-built template it replaced, so a later task moves a route by
// changing one function here instead of every call site (the board has
// moved: see boardHref). No encoding is
// applied (authHref is the one builder that encodes, see its comment): the
// old templates interpolated raw values (UUIDs today) and so do these
// builders.

export type ProjectHubTab = "board" | "members" | "settings" | "workflow";

/** Board URL: the project's board tab, `/projects/<projectId>/board`, plus
 * `?taskId=` when given; `teamId` is not part of it (the board is reached
 * through its project alone). Without a `projectId` there is no board to
 * name: with a `teamId` this is that team's Projects page, with neither it
 * is the legacy `/dashboard`, which resumes the last board opened in this
 * browser. A `taskId` without its project is dropped. Unset (absent or
 * empty) parameters are omitted. */
export function boardHref(params: {
  teamId?: string;
  projectId?: string;
  taskId?: string;
} = {}): string {
  if (params.projectId) {
    const board = projectHubHref(params.projectId, "board");
    return params.taskId ? `${board}?taskId=${params.taskId}` : board;
  }
  return params.teamId ? projectsHref({ teamId: params.teamId }) : "/dashboard";
}

/** Projects page: `/projects`, optionally pre-selecting a team. The legacy
 * `/teams` URL redirects here (next.config.mjs redirects), query included. */
export function projectsHref(params: { teamId?: string } = {}): string {
  return params.teamId ? `/projects?teamId=${params.teamId}` : "/projects";
}

/** Project hub under `/projects/<id>`: a tab, or the hub root when no tab is
 * given (the hub root renders a redirect to the board). */
export function projectHubHref(projectId: string, tab?: ProjectHubTab): string {
  return tab ? `/projects/${projectId}/${tab}` : `/projects/${projectId}`;
}

/** Sign-in URL with a way back: `/auth?redirect=<location>`, where
 * `location` is the current in-app location, path plus query joined as the
 * browser has them (e.g. `/projects/p1/board?taskId=t1`). The value is
 * `encodeURIComponent`-encoded so its own `&`/`=`/`?` survive as one
 * parameter and `searchParams.get("redirect")` returns it whole; /auth's
 * `safeRedirect` parses the decoded form. */
export function authHref(location: string): string {
  return `/auth?redirect=${encodeURIComponent(location)}`;
}

export function settingsHref(): string {
  return "/settings";
}

/** Team settings (API tokens, Enterprise SSO entry), optionally deep-linked
 * to one of its sections. Personal settings stay at `settingsHref()`. */
export function teamSettingsHref(section?: "api-tokens" | "sso", teamId?: string): string {
  const base = teamId ? `/settings/team?teamId=${encodeURIComponent(teamId)}` : "/settings/team";
  return section ? `${base}#${section}` : base;
}

/** Team settings deep-linked to the API Tokens section; with `teamId` the
 * page opens that team instead of the remembered one. */
export function apiTokensSettingsHref(teamId?: string): string {
  return teamSettingsHref("api-tokens", teamId);
}

/** SSO sub-page under team settings. The old `/settings/sso` URL redirects
 * here (next.config.mjs redirects), query included. */
export function ssoSettingsHref(): string {
  return "/settings/team/sso";
}

/** Full-page task detail: `/tasks/<id>`. With `from` (an in-app list URL such
 * as `/tasks?scope=open`) the page links back to it: `from` is passed through
 * `encodeURIComponent` so its own query survives as one parameter. The reader
 * is `safeBackHref`, which must be the only consumer of `from`. Without `from`
 * the result is the bare `/tasks/<id>` the old template produced. */
export function taskHref(taskId: string, params: { from?: string } = {}): string {
  return params.from
    ? `/tasks/${taskId}?from=${encodeURIComponent(params.from)}`
    : `/tasks/${taskId}`;
}

/** The `from` value the board modal's "Open as full page" link carries. It is
 * not a list URL, so `safeBackHref` rejects it (no Tasks crumb, the page keeps
 * its board fallback); the header reads it to keep Projects highlighted. */
export const FROM_BOARD = "board";

/** Full-page task detail opened from the board modal: `/tasks/<id>?from=board`. */
export function taskFromBoardHref(taskId: string): string {
  return `/tasks/${taskId}?from=${FROM_BOARD}`;
}

// Anchored at both ends: only `/tasks` itself or `/tasks?<query>` passes, so a
// scheme, a host, `/tasks/..`, `/tasksX` or a fragment cannot match.
const BACK_HREF_PATTERN = /^\/tasks(\?[^#]*)?$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Validates the `from` value `/tasks/[id]` receives before it is used as a
 * navigation target (open-redirect guard). `raw` is the value as
 * `URLSearchParams.get` returns it (decoded once); a repeated parameter
 * (array), `null` or `undefined` is rejected. It returns `raw` unchanged when
 * it is `/tasks` or `/tasks?...` and its form after one further
 * `decodeURIComponent` carries no `//`, no backslash and no control character;
 * otherwise `null`. The pattern is tested on the raw value on purpose, so the
 * path cannot be reached through an escape. Never returns the decoded form,
 * since decoding again would corrupt `%`-escapes in the query. */
export function safeBackHref(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (!BACK_HREF_PATTERN.test(raw)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.includes("//")) return null;
  if (decoded.includes("\\")) return null;
  if (CONTROL_CHARS.test(decoded)) return null;
  return raw;
}

// Control chars, DEL, whitespace, backslash: never legal in a redirect
// value; checked raw and once more after one decodeURIComponent.
const REDIRECT_BAD_CHARS = /[\u0000-\u001f\u007f\s\\]/;
// Project-hub location: a non-empty project id segment, optional path,
// optional query, no fragment. Anchored at both ends.
const PROJECTS_REDIRECT = /^\/projects\/[^/?#]+(\/[^?#]*)?(\?[^#]*)?$/;

/**
 * Validate a ?redirect= parameter coming back from a deep link
 * (e.g. /invite/[token], or a project location after a 401). raw is
 * searchParams.get("redirect") (decoded once); allowlist same-origin paths
 * under known features so an attacker cannot craft an auth URL that bounces
 * an authenticated session to an external origin. The allowlist carries
 * /invite/ landings and project-hub locations (/projects/<id>, path and
 * query) through to the bounce; extend deliberately when new feature
 * deep-links need it. Returns raw unchanged or null. Rules, in order:
 * null/empty no; a bad char in raw no; one decodeURIComponent (a throw no;
 * a bad char, a // prefix or a // in the decoded path part no); raw must
 * start with exactly one /; no . or .. segment in the decoded path; then
 * only the two allowed prefixes. Anchored checks only, never includes().
 * Lives here (not in the auth page) because Next rejects extra exports
 * from a page file; the page imports this.
 */
export function safeRedirect(raw: string | null): string | null {
  if (!raw) return null;
  if (REDIRECT_BAD_CHARS.test(raw)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (REDIRECT_BAD_CHARS.test(decoded)) return null;
  if (decoded.startsWith("//")) return null;
  const decodedPath = decoded.split(/[?#]/)[0];
  if (decodedPath.includes("//")) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (decodedPath.split("/").some((s) => s === "." || s === "..")) return null;
  if (raw.startsWith("/invite/")) return raw;
  if (PROJECTS_REDIRECT.test(raw)) return raw;
  return null;
}
