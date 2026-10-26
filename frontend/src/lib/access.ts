/**
 * Who may use the app without a team: the single rule behind every
 * "send to /onboarding?" decision (entry redirects, /home, /projects,
 * /tasks, /onboarding itself).
 *
 * A user can reach work through a team membership or through a per-project
 * share. `needsOnboarding` is true only when they have neither: no teams AND
 * no shared projects. Either input alone is enough to stay out of onboarding
 * (teams win: with one or more teams the shared-projects list is not even
 * consulted). Nothing else (GitHub connection, role, email) may enter the
 * rule, so it stays a pure function of the two lists.
 *
 * Callers land on /home when `needsOnboarding` is false and on /onboarding
 * when it is true; /onboarding sends only users WITH teams to /home, never a
 * team-less user with shared projects (they get a "Skip for now" link
 * instead), so the two pages can never redirect to each other.
 */

import { getProjects, getTeams, type Project, type Team } from "./api";

export interface AccessContext {
  teams: Team[];
  /** Projects shared with a user who has no team; always empty when `teams` is not. */
  sharedProjects: Project[];
  /** Set (only) when the shared-projects lookup failed and was treated as empty. */
  sharedProjectsError?: true;
}

/** True only for a user with no teams and no shared projects. */
export function needsOnboarding(ctx: AccessContext): boolean {
  return ctx.teams.length === 0 && ctx.sharedProjects.length === 0;
}

/**
 * Load the two lists. The unscoped project listing is only requested for a
 * user without teams: it is what the backend serves a team-less human (their
 * shared projects), while for a user with several teams it answers
 * `400 multiple_teams` and it cannot change the outcome anyway.
 *
 * The shared lookup fails soft: if it rejects, the user counts as having no
 * shared projects (`sharedProjectsError` records that), so a brand-new user
 * still reaches the create-team form and the entry redirects behave as they
 * did before shared projects mattered (no teams -> /onboarding). A failing
 * team request keeps rejecting: that is a real error, not "no access".
 */
export async function getAccessContext(): Promise<AccessContext> {
  const teams = await getTeams();
  if (teams.length > 0) return { teams, sharedProjects: [] };
  try {
    return { teams, sharedProjects: await getProjects() };
  } catch {
    return { teams, sharedProjects: [], sharedProjectsError: true };
  }
}
