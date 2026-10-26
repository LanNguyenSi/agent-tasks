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
