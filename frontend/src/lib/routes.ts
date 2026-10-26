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

/** Project hub under `/projects/<id>`: a tab, or the hub root (Overview)
 * when no tab is given. */
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
