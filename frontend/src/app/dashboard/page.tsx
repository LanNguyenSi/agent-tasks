"use client";

// Legacy entry point: the board lives at /projects/<id>/board (boardHref in
// lib/routes.ts). This page only forwards old links, bookmarks and the bare
// /dashboard link:
//   - ?projectId=P   -> /projects/P/board; `teamId` and `projectId` are
//                       consumed, every other parameter (e.g. taskId) is kept.
//   - bare / ?teamId=X -> the last board opened in this browser, read from
//                       the `dashboard:lastProject:<teamId>` key the board
//                       page writes: team X's when a teamId is given, else
//                       the last team the Projects page selected, else any
//                       team's. Nothing stored -> the Projects page.
// It runs client-side because the last board is only known to localStorage.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { SkeletonList } from "../../components/ui/Skeleton";
import { boardHref, projectsHref } from "../../lib/routes";

const LAST_PROJECT_KEY_PREFIX = "dashboard:lastProject:";
// Written by the Projects page (app/teams/page.tsx).
const LAST_TEAM_KEY = "agent-tasks:lastTeamId";

// A project id is a UUID or a short slug-like id; anything else (path
// separators, `..`, encoded fragments) must never reach the board URL.
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function validProjectId(value: string | null): string | null {
  return value && PROJECT_ID_PATTERN.test(value) ? value : null;
}

function readStoredLastProjectId(teamId: string | null): string | null {
  try {
    const storage = window.localStorage;
    if (teamId) return validProjectId(storage.getItem(LAST_PROJECT_KEY_PREFIX + teamId));
    const lastTeamId = storage.getItem(LAST_TEAM_KEY);
    const lastTeamProject = lastTeamId
      ? validProjectId(storage.getItem(LAST_PROJECT_KEY_PREFIX + lastTeamId))
      : null;
    if (lastTeamProject) return lastTeamProject;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      const projectId = key?.startsWith(LAST_PROJECT_KEY_PREFIX)
        ? validProjectId(storage.getItem(key))
        : null;
      if (projectId) return projectId;
    }
  } catch {
    // Blocked storage: nothing to resume.
  }
  return null;
}

export default function DashboardRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const teamId = params.get("teamId") || null;
    const projectId = validProjectId(params.get("projectId")) ?? readStoredLastProjectId(teamId);
    if (!projectId) {
      router.replace(projectsHref({ teamId: teamId ?? undefined }));
      return;
    }
    params.delete("teamId");
    params.delete("projectId");
    const rest = params.toString();
    const board = boardHref({ projectId });
    router.replace(rest ? `${board}?${rest}` : board);
  }, [router]);

  return (
    <main className="db-state-wrap">
      <SkeletonList rows={5} rowHeight="4.5rem" label="Opening the board" />
    </main>
  );
}
