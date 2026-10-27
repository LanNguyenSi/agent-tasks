"use client";

/**
 * The one team list of the authenticated shell.
 *
 * AppChrome owns it (`TeamListProvider`): one `getTeams()` request per shell
 * mount, read by the header (through AppChrome) and by the team-scoped pages
 * (/home, /projects, /tasks, /settings/team) through `usePageTeams`. Pages no
 * longer fetch their own copy, so the header and a page always resolve the
 * current team from the same list.
 *
 * The list can be older than the URL: after a membership change (an invite
 * accepted in another tab, a team created elsewhere) `?teamId` can name a
 * team the list lacks. Whoever is asked for such an id calls
 * `refreshForTeam(id)`: the provider reloads the list once per missing id
 * (a second ask for the same id, from the header or a page, is a no-op), so
 * there is no loop when the id is still missing afterwards. Until that
 * refresh settles, `usePageTeams` reports `held`, so a page does not write
 * the fallback team it resolves into the URL (that write would replace the
 * team the refresh may be about to bring). A failed refresh keeps the list
 * that was already there.
 *
 * A first lookup that failed leaves the list in `error`. A team-scoped page
 * that mounts in that state retries it once (`usePageTeams`), so the next
 * navigation recovers like each page's own lookup did; a persistent failure
 * costs one request per page mount, never a loop.
 *
 * Actions that change membership in the app call `refreshTeams()`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { getTeams, type Team } from "./api";
import { retrySharedProjects, type AccessContext } from "./access";

/** `loading`: no answer yet; `error`: the first lookup failed (no list). */
export type TeamListStatus = "loading" | "ready" | "error";

interface TeamListState {
  /** null until the first answer (and after a failed first lookup). */
  teams: Team[] | null;
  status: TeamListStatus;
  error: Error | null;
  /** True while any lookup is in flight. */
  refreshing: boolean;
  /** Ids a refresh was already started for and that the list still lacks. */
  asked: ReadonlySet<string>;
}

export interface TeamListValue extends TeamListState {
  /**
   * Reload the list. Never rejects: a failure keeps the list that is there.
   * A no-op while the shell is suppressed (no provider data to refresh).
   */
  refreshTeams: () => Promise<void>;
  /**
   * Reload the list because `teamId` is missing from it. At most one reload
   * per id for as long as the list lacks it.
   */
  refreshForTeam: (teamId: string) => void;
}

const NO_ASKED: ReadonlySet<string> = new Set<string>();
const INITIAL: TeamListState = {
  teams: null,
  status: "loading",
  error: null,
  refreshing: false,
  asked: NO_ASKED,
};
const NO_TEAMS: Team[] = [];

const TeamListContext = createContext<TeamListValue | null>(null);

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error("Failed to load teams.");
}

/**
 * Owns the list. `enabled` is false while the shell is suppressed (public
 * routes): nothing is fetched and the previous account's list is dropped, so
 * a later login on this mounted shell never sees it.
 */
export function TeamListProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  const [state, setState] = useState<TeamListState>(INITIAL);
  // The newest lookup wins; bumped when the shell is suppressed or unmounted,
  // which also drops answers that arrive late.
  const seqRef = useRef(0);
  const askedRef = useRef<Set<string>>(new Set());

  const load = useCallback((): Promise<void> => {
    const seq = ++seqRef.current;
    setState((s) => ({ ...s, refreshing: true, asked: new Set(askedRef.current) }));
    return getTeams().then(
      (teams) => {
        if (seq !== seqRef.current) return;
        // An id the list now has is no longer missing; it may be asked for
        // again if it goes missing later.
        for (const id of [...askedRef.current]) {
          if (teams.some((t) => t.id === id)) askedRef.current.delete(id);
        }
        setState({
          teams,
          status: "ready",
          error: null,
          refreshing: false,
          asked: new Set(askedRef.current),
        });
      },
      (err: unknown) => {
        if (seq !== seqRef.current) return;
        // Keep the list that is there; only a first lookup has none.
        setState((s) =>
          s.teams
            ? { ...s, refreshing: false }
            : { ...s, status: "error", error: toError(err), refreshing: false },
        );
      },
    );
  }, []);

  useEffect(() => {
    if (!enabled) {
      seqRef.current += 1;
      askedRef.current = new Set();
      setState(INITIAL);
      return;
    }
    void load();
    return () => {
      seqRef.current += 1;
    };
  }, [enabled, load]);

  const refreshTeams = useCallback(
    () => (enabled ? load() : Promise.resolve()),
    [enabled, load],
  );

  const refreshForTeam = useCallback(
    (teamId: string) => {
      if (!enabled || askedRef.current.has(teamId)) return;
      askedRef.current.add(teamId);
      void load();
    },
    [enabled, load],
  );

  const value = useMemo<TeamListValue>(
    () => ({ ...state, refreshTeams, refreshForTeam }),
    [state, refreshTeams, refreshForTeam],
  );

  return <TeamListContext.Provider value={value}>{children}</TeamListContext.Provider>;
}

/** The shell's team list. Throws outside a `TeamListProvider`. */
export function useTeamList(): TeamListValue {
  const value = useContext(TeamListContext);
  if (!value) throw new Error("useTeamList must be used inside TeamListProvider");
  return value;
}

/**
 * Like `useTeamList`, but `null` outside any provider (isolated component
 * tests). The onboarding page does render inside the shell's provider, which
 * is disabled there, so `refreshTeams` is a no-op on it.
 */
export function useOptionalTeamList(): TeamListValue | null {
  return useContext(TeamListContext);
}

/**
 * What a team-scoped page reads instead of fetching teams itself.
 *
 * - `teams`: the shell's list (`[]` while there is none yet, and until the
 *   page's session check answered: `userReady` false);
 * - `status`: `loading` / `ready` / `error` of the shell's lookup (`loading`
 *   while the one retry of a failed list is in flight);
 * - `held`: `?teamId` names a team the list lacks and the one refresh for it
 *   is still to start or in flight. The page passes `held` to
 *   `useCurrentTeam`, which then holds back the URL write of the fallback.
 *
 * Also asks the provider to refresh for a missing `?teamId`, and retries a
 * list that is in `error` when the page mounts (at most once per mount).
 *
 * `userReady`: the page's session check answered with a user. Without a
 * session the page only redirects to /auth: it resolves no team, writes
 * nothing into the URL and asks for nothing.
 */
export function usePageTeams(userReady = true): {
  teams: Team[];
  status: TeamListStatus;
  error: Error | null;
  held: boolean;
} {
  const list = useTeamList();
  const searchParams = useSearchParams();
  const urlTeamId = searchParams?.get("teamId") || null;
  const teams = userReady ? (list.teams ?? NO_TEAMS) : NO_TEAMS;
  const missing =
    userReady &&
    list.status === "ready" &&
    urlTeamId !== null &&
    !teams.some((t) => t.id === urlTeamId);
  const { refreshForTeam, refreshTeams } = list;
  useEffect(() => {
    if (missing && urlTeamId) refreshForTeam(urlTeamId);
  }, [missing, urlTeamId, refreshForTeam]);

  // A list that failed before this page mounted is retried once, so a
  // transient failure does not outlive the page it hit. A failure that
  // arrives after the mount is not retried here (the next page does).
  const [retryPending, setRetryPending] = useState(() => list.status === "error");
  useEffect(() => {
    if (!retryPending || !userReady) return;
    void refreshTeams().then(() => setRetryPending(false));
  }, [retryPending, userReady, refreshTeams]);

  const held = missing && urlTeamId !== null && (!list.asked.has(urlTeamId) || list.refreshing);
  const status: TeamListStatus =
    retryPending && list.status === "error" ? "loading" : list.status;
  return { teams, status, error: list.error, held };
}

/**
 * The page-side access decision for a user whose teams are already known
 * (the shell's list), same outcome as `getAccessContext` in lib/access:
 * the unscoped project listing is only requested for a user without teams,
 * and a failing listing counts as "no shared projects".
 */
export async function accessContextForTeams(teams: Team[]): Promise<AccessContext> {
  if (teams.length > 0) return { teams, sharedProjects: [] };
  return { teams, ...(await retrySharedProjects()) };
}
