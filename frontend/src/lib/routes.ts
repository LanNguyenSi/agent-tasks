// Single owner of every in-app URL the UI/IA restructure (agent-tasks-ui-ia
// stage 1) may relocate. Each builder returned a string byte-identical to
// the hand-built template it replaced, so a later task moves a route by
// changing one function here instead of every call site (the board has
// moved: see boardHref). No encoding is
// applied: the old templates interpolated raw values (UUIDs today) and so do
// these builders.

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

/** Projects page: `/teams`, optionally pre-selecting a team. */
export function projectsHref(params: { teamId?: string } = {}): string {
  return params.teamId ? `/teams?teamId=${params.teamId}` : "/teams";
}

/** Project hub under `/projects/<id>`: a tab, or the hub root when no tab is
 * given (the hub root renders a redirect to the board). */
export function projectHubHref(projectId: string, tab?: ProjectHubTab): string {
  return tab ? `/projects/${projectId}/${tab}` : `/projects/${projectId}`;
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
