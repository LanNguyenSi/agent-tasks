"use client";

/**
 * Team switching glue between the header switcher and the pages.
 *
 * The URL is the single source of truth. A switch in the header does two
 * things (see AppHeader): `rememberTeam` (lib/currentTeam) and, for the
 * sections that show team-scoped data, a navigation to that section's root
 * with `?teamId=` (`teamSwitchHref`). Every team-scoped page derives its
 * current team through `useCurrentTeam` and, when the URL names no valid
 * team, writes the team it resolved into the URL (a replace, no history
 * entry). From then on the page and the header read the same `?teamId`, so
 * neither decides from the remembered team (localStorage), which another tab
 * can change at any time.
 */

import { useEffect, useMemo, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
 * `resolveCurrentTeam(teams, { urlTeamId })`, memoized on its two inputs.
 * The remembered-team fallback (localStorage) is read only when the teams or
 * the URL's team change, never on a plain re-render, so a write from another
 * tab cannot move the result between renders. A valid `urlTeamId` always
 * wins and makes the remembered team irrelevant. The header and the pages
 * both resolve through this hook. `null` for an unknown or empty list.
 */
export function useResolvedTeam<T extends { id: string }>(
  teams: T[] | null | undefined,
  urlTeamId: string | null,
): T | null {
  return useMemo(
    () => (teams && teams.length > 0 ? resolveCurrentTeam(teams, { urlTeamId }) : null),
    [teams, urlTeamId],
  );
}

/**
 * The page's current team, for the team-scoped pages (/home, /projects,
 * /tasks, /settings/team). It resolves through `useResolvedTeam` from
 * `?teamId`, the input the header uses, and keeps no state of its own:
 * it changes exactly when the URL's team or the teams list changes, and the
 * last URL always wins. Pages key their data-loading effect on the returned
 * team's id and cancel the previous load on cleanup.
 *
 * When `?teamId` is absent or names no team of the list, the hook writes the
 * resolved team into the URL with `router.replace` (same path, other query
 * parameters and the hash kept, no new history entry). That write does not
 * count as the user's choice: the team it names is not remembered. A team
 * the URL names in any other way (a switch, a link, back/forward) is
 * remembered (existing convention). `null` for an empty list.
 */
export function useCurrentTeam<T extends { id: string }>(teams: T[]): T | null {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams?.toString() ?? "";
  const urlTeamId = searchParams?.get("teamId") ?? null;
  const team = useResolvedTeam(teams, urlTeamId);
  const teamId = team?.id ?? null;
  // The team id this hook last wrote into the URL, until the URL shows it.
  const writtenTeamIdRef = useRef<string | null>(null);

  // Remember a team the URL names, unless the URL names it because this hook
  // wrote it there (the write is not the user's choice).
  useEffect(() => {
    if (!teamId || teamId !== urlTeamId) return;
    const written = writtenTeamIdRef.current === teamId;
    writtenTeamIdRef.current = null;
    if (!written) rememberTeam(teamId);
  }, [teamId, urlTeamId]);

  // No valid team in the URL: write the resolved one there, so the header and
  // the page read the same `?teamId` from now on.
  useEffect(() => {
    if (!teamId || teamId === urlTeamId) return;
    const next = new URLSearchParams(query);
    next.set("teamId", teamId);
    writtenTeamIdRef.current = teamId;
    router.replace(`${pathname}?${next.toString()}${window.location.hash}`, { scroll: false });
  }, [teamId, urlTeamId, query, pathname, router]);

  return team;
}
