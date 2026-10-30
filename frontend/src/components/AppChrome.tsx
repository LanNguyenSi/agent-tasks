/**
 * AppChrome: shared authenticated shell, rendered once from the root layout.
 *
 * Layout choice (documented per Stage C spec): route-group layout
 * (app/(app)/layout.tsx) was considered but rejected because it requires
 * physically moving all authenticated page directories, which is invasive and
 * risks breaking Next.js file-system routing in non-obvious ways. Instead, a
 * lightweight client component reads the current pathname and renders
 * AppHeader only for authenticated routes, leaving the root layout untouched
 * beyond a single wrapper insertion. URLs are unchanged.
 *
 * Routes that suppress the header: /, /auth/*, /onboarding/*, /invite/*,
 * /dev/*.
 */
"use client";

import { Suspense, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import AppHeader from "./AppHeader";
import { getCurrentUser } from "../lib/api";
import { TeamListProvider, useTeamList } from "../lib/teamList";
import type { ReactNode } from "react";

interface User {
  login: string;
  avatarUrl?: string | null;
}

/** Pathnames where the app shell (header) must NOT appear. */
function isShellSuppressed(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/onboarding") ||
    pathname.startsWith("/invite") ||
    pathname.startsWith("/dev")
  );
}

/**
 * The header with the shell's team list. `teams` is null while unknown (not
 * loaded, or the first lookup failed): the header then shows no team
 * switcher and no team-dependent menu entries. A team id the URL names that
 * the list lacks makes the provider reload the list once.
 */
function ShellHeader({ user }: { user: User | null }) {
  const { teams, refreshForTeam } = useTeamList();
  return <AppHeader user={user} teams={teams} onMissingTeam={refreshForTeam} />;
}

export default function AppChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const showHeader = !isShellSuppressed(pathname);
  const [user, setUser] = useState<User | null>(null);

  // Shell suppressed (for example after logout to /): drop the previous
  // account's identity so a later login on this mounted shell never shows it
  // while its own lookup is in flight. The team list is dropped by its
  // provider on the same condition.
  if (!showHeader && user !== null) setUser(null);

  useEffect(() => {
    if (!showHeader) return;
    // A response that arrives after the shell was suppressed again (or the
    // component unmounted) must not write state.
    let cancelled = false;
    getCurrentUser()
      .then((u) => {
        if (!cancelled) setUser(u ? { login: u.login, avatarUrl: u.avatarUrl } : null);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      });
    return () => {
      cancelled = true;
    };
  }, [showHeader]);

  // The provider outlives route changes: one team lookup per shell mount,
  // shared by the header and the team-scoped pages below it.
  return (
    <TeamListProvider enabled={showHeader}>
      {showHeader && (
        // The header reads ?teamId (useSearchParams), which needs a boundary.
        <Suspense fallback={null}>
          <ShellHeader user={user} />
        </Suspense>
      )}
      {children}
    </TeamListProvider>
  );
}
