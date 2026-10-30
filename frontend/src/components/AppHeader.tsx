"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { logout, type Team } from "../lib/api";
import { rememberTeam } from "../lib/currentTeam";
import { FROM_BOARD, settingsHref, teamSettingsHref } from "../lib/routes";
import { sectionHref, teamSwitchHref, useResolvedTeam } from "../lib/teamSwitch";
import CreateTeamDialog from "./CreateTeamDialog";
import DropdownMenu from "./ui/DropdownMenu";
import { Icon } from "./ui/Icon";

interface AppHeaderProps {
  user?: {
    login: string;
    avatarUrl?: string | null;
  } | null;
  /**
   * The caller's teams. `undefined`/`null` means unknown (not loaded yet, or
   * the lookup failed): no switcher and no team-dependent menu entries. An
   * empty list means the user has no team.
   */
  teams?: Team[] | null;
  /**
   * Called with the team id the URL (or a pending switch) names when the
   * known `teams` lack it, so the owner of the list can reload it. The owner
   * decides how often (AppChrome's provider: once per id).
   */
  onMissingTeam?: (teamId: string) => void;
}

export default function AppHeader({ user, teams, onMissingTeam }: AppHeaderProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const teamTriggerRef = useRef<HTMLButtonElement | null>(null);
  const checkedTeamItemRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [teamMenuOpen, setTeamMenuOpen] = useState(false);
  const [createTeamOpen, setCreateTeamOpen] = useState(false);

  const isHome = pathname.startsWith("/home");
  // A task page opened from the board modal ("Open as full page") belongs to
  // Projects, not to the Tasks list.
  const fromBoard =
    pathname.startsWith("/tasks/") && searchParams?.getAll("from").join(",") === FROM_BOARD;
  const isTasks = pathname.startsWith("/tasks") && !fromBoard;
  // Projects is current on the list and on every project hub route below it
  // (`/projects/<id>/board`, members, settings, workflow).
  const isProjects = pathname === "/projects" || pathname.startsWith("/projects/") || fromBoard;

  // The current team follows the single current-team rule (?teamId, then the
  // remembered team, then the first team) through `useResolvedTeam`, the
  // hook every team-scoped page resolves through (useCurrentTeam). Those
  // pages write the team they resolved into the URL, so on them the header
  // and the page read the same `?teamId`. A switch made here is held in
  // `switchedTeamId` until the URL changes (the navigation it triggered, or
  // the browser's back/forward), so the label never lags behind the click.
  const urlTeamId = searchParams?.get("teamId") ?? null;
  const [switchedTeamId, setSwitchedTeamId] = useState<string | null>(null);
  // The pending switch is dropped in the render that sees a new location, so
  // no frame shows the old pick with the new URL.
  const locationKey = JSON.stringify([pathname, urlTeamId]);
  const [seenLocationKey, setSeenLocationKey] = useState(locationKey);
  if (seenLocationKey !== locationKey) {
    setSeenLocationKey(locationKey);
    setSwitchedTeamId(null);
  }
  const targetTeamId = switchedTeamId ?? urlTeamId;
  const currentTeam = useResolvedTeam(teams, targetTeamId);
  // The list may be older than the URL (a membership change since it was
  // loaded): ask its owner to reload, so the header resolves the team the
  // page resolves instead of a fallback.
  const targetMissing =
    !!teams && !!targetTeamId && !teams.some((t) => t.id === targetTeamId);
  useEffect(() => {
    if (targetMissing && targetTeamId) onMissingTeam?.(targetTeamId);
  }, [targetMissing, targetTeamId, onMissingTeam]);
  // The team the URL names (or the pending switch navigates to), if it is one
  // of the caller's teams. Picking it changes nothing; picking any other team,
  // including one shown only through the remembered-team fallback, switches.
  const urlTeam = teams?.find((t) => t.id === targetTeamId) ?? null;
  // The nav and brand links carry the team the header shows, so the page
  // they open already names its team and never writes it into the URL (that
  // write is a navigation and would cancel a click on another section made
  // while the page loads). Bare while the header knows no team.
  const navTeamId = currentTeam?.id ?? null;

  // Opening the team menu puts focus on the checked (current) team. The
  // DropdownMenu focuses its first item in a zero-delay timeout from its own
  // effect; this later timeout wins.
  useEffect(() => {
    if (!teamMenuOpen) return;
    const id = window.setTimeout(() => checkedTeamItemRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [teamMenuOpen]);

  const teamCount = teams?.length ?? 0;

  // Open the "New team" dialog from a menu entry. The entry unmounts with its
  // menu, so focus moves to the button that opened the menu first; the dialog
  // restores focus to it on close.
  function openCreateTeam(trigger: HTMLButtonElement | null) {
    setTeamMenuOpen(false);
    setMenuOpen(false);
    trigger?.focus();
    setCreateTeamOpen(true);
  }

  function switchTeam(teamId: string) {
    setTeamMenuOpen(false);
    if (teamId === urlTeam?.id) return;
    setSwitchedTeamId(teamId);
    rememberTeam(teamId);
    const href = teamSwitchHref(pathname, teamId);
    if (href) router.push(href);
    // The picked item unmounts with the menu; keep keyboard focus on the
    // switcher instead of dropping it to the document body.
    teamTriggerRef.current?.focus();
  }

  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <Link href={sectionHref("home", navTeamId)} className="app-brand" aria-label="agent-tasks">
            <Icon name="board" size={15} />
            <span className="app-brand-text">agent-tasks</span>
          </Link>

          {teams && teamCount === 1 && currentTeam && (
            <span className="app-team-label" title={currentTeam.name}>
              <span className="sr-only">Team: </span>
              {currentTeam.name}
            </span>
          )}
          {teams && teamCount > 1 && currentTeam && (
            <>
              <button
                ref={teamTriggerRef}
                type="button"
                className="app-team-trigger"
                onClick={() => setTeamMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={teamMenuOpen}
                aria-label={`Switch team, current team ${currentTeam.name}`}
                title={currentTeam.name}
              >
                <span className="app-team-name">{currentTeam.name}</span>
                <Icon name="chevron-down" size={12} />
              </button>
              <DropdownMenu
                anchorRef={teamTriggerRef}
                open={teamMenuOpen}
                onClose={() => setTeamMenuOpen(false)}
                align="start"
                minWidth={180}
              >
                <div role="menu" aria-label="Teams">
                  {teams.map((team) => (
                    <button
                      key={team.id}
                      ref={team.id === currentTeam.id ? checkedTeamItemRef : undefined}
                      type="button"
                      role="menuitemradio"
                      aria-checked={team.id === currentTeam.id}
                      onClick={() => switchTeam(team.id)}
                      className="app-dropdown-item app-team-option"
                    >
                      <span className="app-team-option-name">{team.name}</span>
                      {team.id === currentTeam.id && <Icon name="check" size={12} />}
                    </button>
                  ))}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => openCreateTeam(teamTriggerRef.current)}
                    className="app-dropdown-item app-team-new"
                  >
                    + New team
                  </button>
                </div>
              </DropdownMenu>
            </>
          )}

          <nav className="app-nav-links" aria-label="Main">
            <Link
              href={sectionHref("home", navTeamId)}
              className="app-nav-link"
              aria-current={isHome ? "page" : undefined}
            >
              Home
            </Link>
            <Link
              href={sectionHref("projects", navTeamId)}
              className="app-nav-link"
              aria-current={isProjects ? "page" : undefined}
            >
              Projects
            </Link>
            <Link
              href={sectionHref("tasks", navTeamId)}
              className="app-nav-link"
              aria-current={isTasks ? "page" : undefined}
            >
              Tasks
            </Link>
          </nav>

          <div className="app-nav-spacer" />

          {user && (
            <>
              <button
                ref={triggerRef}
                type="button"
                className="app-user-trigger"
                onClick={() => setMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={`Account menu for ${user.login}`}
              >
                {user.avatarUrl ? (
                  <img
                    src={user.avatarUrl}
                    alt={user.login}
                    className="app-avatar"
                  />
                ) : (
                  <span className="app-avatar">
                    {user.login.slice(0, 2).toUpperCase()}
                  </span>
                )}
                <span className="app-user-name">{user.login}</span>
                <Icon name="chevron-down" size={12} />
              </button>

              <DropdownMenu
                anchorRef={triggerRef}
                open={menuOpen}
                onClose={() => setMenuOpen(false)}
                align="end"
                minWidth={190}
              >
                <div role="menu">
                  <Link
                    href={settingsHref()}
                    role="menuitem"
                    onClick={() => setMenuOpen(false)}
                    className="app-dropdown-item"
                  >
                    Settings
                  </Link>
                  {teams && teamCount > 0 && (
                    <Link
                      href={navTeamId ? `${teamSettingsHref()}?teamId=${navTeamId}` : teamSettingsHref()}
                      role="menuitem"
                      onClick={() => setMenuOpen(false)}
                      className="app-dropdown-item"
                    >
                      Team settings
                    </Link>
                  )}
                  {teams && teamCount === 0 && (
                    <Link
                      href="/onboarding"
                      role="menuitem"
                      onClick={() => setMenuOpen(false)}
                      className="app-dropdown-item"
                    >
                      Create a team
                    </Link>
                  )}
                  {teams && teamCount > 0 && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => openCreateTeam(triggerRef.current)}
                      className="app-dropdown-item"
                    >
                      New team
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      void logout().then(() => {
                        router.replace("/");
                      });
                    }}
                    className="app-dropdown-item app-dropdown-item-danger"
                  >
                    Logout
                  </button>
                </div>
              </DropdownMenu>
            </>
          )}
        </div>
      </header>
      {teams && teamCount > 0 && (
        <CreateTeamDialog open={createTeamOpen} onClose={() => setCreateTeamOpen(false)} />
      )}
    </>
  );
}
