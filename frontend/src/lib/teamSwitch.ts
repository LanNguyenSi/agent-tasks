"use client";

/**
 * Team switching glue between the header switcher and the pages.
 *
 * The header owns team switching. A switch does three things (see
 * AppHeader): `rememberTeam` (lib/currentTeam), `announceTeamChange` (the
 * `window` event below) and, for the sections that show team-scoped data,
 * a navigation to that section's root with `?teamId=` (`teamSwitchHref`).
 *
 * Pages that resolve the team once in a bootstrap effect (/home, /projects,
 * /settings/team) cannot react to the URL change alone, so they subscribe
 * with `useTeamChange` and re-resolve from the event. /tasks re-syncs from
 * `?teamId` itself.
 */

import { useEffect, useRef } from "react";
import { projectsHref, teamSettingsHref } from "./routes";

/** `window` event name carrying `{ teamId }` in `CustomEvent.detail`. */
export const TEAM_CHANGE_EVENT = "agent-tasks:team-change";

/** Tell every mounted page that the current team changed. */
export function announceTeamChange(teamId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TEAM_CHANGE_EVENT, { detail: { teamId } }));
}

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
 * Subscribe to team switches for the lifetime of the component. The latest
 * `handler` is always called (no stale closures), the listener is attached
 * once.
 */
export function useTeamChange(handler: (teamId: string) => void): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => {
    function onChange(e: Event) {
      const teamId = (e as CustomEvent<{ teamId?: string }>).detail?.teamId;
      if (teamId) handlerRef.current(teamId);
    }
    window.addEventListener(TEAM_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(TEAM_CHANGE_EVENT, onChange);
  }, []);
}
