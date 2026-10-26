// Single owner of every in-app URL the UI/IA restructure (agent-tasks-ui-ia
// stage 1) may relocate. Each builder must return a string byte-identical to
// the hand-built template it replaced, so a later task moves a route by
// changing one function here instead of every call site. No encoding is
// applied: the old templates interpolated raw values (UUIDs today) and so do
// these builders.

export type ProjectHubTab = "members" | "settings" | "workflow";

/** Board URL: `/dashboard` plus `teamId`, `projectId`, `taskId` query
 * parameters in that order. Unset (absent or empty) parameters are omitted;
 * no `?` is added when none remain. */
export function boardHref(params: {
  teamId?: string;
  projectId?: string;
  taskId?: string;
} = {}): string {
  const parts: string[] = [];
  if (params.teamId) parts.push(`teamId=${params.teamId}`);
  if (params.projectId) parts.push(`projectId=${params.projectId}`);
  if (params.taskId) parts.push(`taskId=${params.taskId}`);
  return parts.length > 0 ? `/dashboard?${parts.join("&")}` : "/dashboard";
}

/** Projects page: `/teams`, optionally pre-selecting a team. */
export function projectsHref(params: { teamId?: string } = {}): string {
  return params.teamId ? `/teams?teamId=${params.teamId}` : "/teams";
}

/** Project hub tab under `/projects/<id>`. */
export function projectHubHref(projectId: string, tab: ProjectHubTab): string {
  return `/projects/${projectId}/${tab}`;
}

export function settingsHref(): string {
  return "/settings";
}

/** Settings deep-linked to the API Tokens section. */
export function apiTokensSettingsHref(): string {
  return "/settings#api-tokens";
}

export function ssoSettingsHref(): string {
  return "/settings/sso";
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

// Anchored at both ends: only `/tasks` itself or `/tasks?<query>` passes, so a
// scheme, a host, `/tasks/..`, `/tasksX` or a fragment cannot match.
const BACK_HREF_PATTERN = /^\/tasks(\?[^#]*)?$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Validates the `from` value `/tasks/[id]` receives before it is used as a
 * navigation target (open-redirect guard). `raw` is the value as
 * `URLSearchParams.get` returns it (decoded once); a repeated parameter
 * (array), `null` or `undefined` is rejected. It returns `raw` unchanged when
 * it is `/tasks` or `/tasks?...` and its fully decoded form carries no `//`,
 * no backslash and no control character; otherwise `null`. Never returns the
 * decoded form, since decoding again would corrupt `%`-escapes in the query. */
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
