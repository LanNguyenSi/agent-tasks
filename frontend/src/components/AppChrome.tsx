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
import { getCurrentUser, getTeams, type Team } from "../lib/api";
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

export default function AppChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const showHeader = !isShellSuppressed(pathname);
  const [user, setUser] = useState<User | null>(null);
  // null = unknown (not loaded, or the lookup failed): the header then shows
  // no team switcher and no team-dependent menu entries.
  const [teams, setTeams] = useState<Team[] | null>(null);

  useEffect(() => {
    if (!showHeader) return;
    getCurrentUser()
      .then((u) => setUser(u ? { login: u.login, avatarUrl: u.avatarUrl } : null))
      .catch(() => setUser(null));
    // One team lookup per shell mount (the chrome outlives route changes).
    getTeams()
      .then(setTeams)
      .catch(() => setTeams(null));
  }, [showHeader]);

  return (
    <>
      {showHeader && (
        // The header reads ?teamId (useSearchParams), which needs a boundary.
        <Suspense fallback={null}>
          <AppHeader user={user} teams={teams} />
        </Suspense>
      )}
      {children}
    </>
  );
}
