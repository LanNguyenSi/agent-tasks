"use client";

/**
 * Team switching glue between the header switcher and the pages.
 *
 * The URL is the single source of truth. A switch in the header does two
 * things (see AppHeader): `rememberTeam` (lib/currentTeam) and, for the
 * sections that show team-scoped data, a navigation to that section's root
 * with `?teamId=` (`teamSwitchHref`). Every team-scoped page then derives its
 * current team from the same input the header uses,
 * `resolveCurrentTeam(teams, { urlTeamId })`, through `useCurrentTeam`; so a
 * switch, the browser's back/forward buttons and a pasted link all land the
 * page on the team the header shows. Nothing depends on a side channel.
 */

import { useEffect, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { rememberTeam, resolveCurrentTeam } from "./currentTeam";
import { projectsHref, teamSettingsHref } from "./routes";

/**
 * Where a switch to `teamId` lands, given the current path: the root of the
 * section the user is in, with `?teamId=`. A project hub or board route goes
 * to the Projects list (the project belongs to the old team). Paths whose
 * content is not team-scoped (personal settings) stay put: `null`.
 */
export function teamSwitchHref(pathname: string, teamId: string): string | null {
  if (pathname === "/home" || pathname.startsWith("/home/")) {
    return `/home?teamId=${teamId}`;
  }
  if (pathname === "/tasks" || pathname.startsWith("/tasks/")) {
    return `/tasks?teamId=${teamId}`;
  }
  if (pathname === "/projects" || pathname.startsWith("/projects/")) {
    return projectsHref({ teamId });
  }
  if (pathname === "/settings/team" || pathname.startsWith("/settings/team/")) {
    return `${teamSettingsHref()}?teamId=${teamId}`;
  }
  return null;
}

/**
 * The page's current team: `resolveCurrentTeam(teams, { urlTeamId })` with
 * `urlTeamId` read from `?teamId`, the exact input the header uses. It is
 * derived during render (no state of its own), so it cannot diverge from the
 * URL: it changes exactly when the URL's team or the teams list changes, and
 * the last URL always wins. Pages key their data-loading effect on the
 * returned team's id and cancel the previous load on cleanup.
 *
 * A team named by a valid `?teamId` is remembered (existing convention).
 * `null` for an empty list.
 */
export function useCurrentTeam<T extends { id: string }>(teams: T[]): T | null {
  const searchParams = useSearchParams();
  const urlTeamId = searchParams?.get("teamId") ?? null;
  const team = useMemo(
    () => (teams.length > 0 ? resolveCurrentTeam(teams, { urlTeamId }) : null),
    [teams, urlTeamId],
  );
  const teamId = team?.id ?? null;
  useEffect(() => {
    if (teamId && teamId === urlTeamId) rememberTeam(teamId);
  }, [teamId, urlTeamId]);
  return team;
}
