// The stored workflows of the projects on the /tasks page, so the scope
// presets and the status chips can follow the team's workflow vocabulary
// (see workflowStatusNames in home/widgetFilters.ts). Lives beside the route
// file because a Next.js page module cannot carry extra named exports.

import { useEffect, useRef, useState } from "react";
import type { TeamTasksProject, Workflow } from "../../../lib/api";
import { loadMissingProjectWorkflows } from "../../home/projectWorkflows";

const NO_WORKFLOWS: ReadonlyMap<string, readonly Workflow[]> = new Map();

/**
 * Workflow rows by project for the current team's projects. Each project is
 * read once per team: a project whose list answers 403 is not asked again, any
 * other failure (network, 5xx) is retried when `projects` changes (every list
 * refresh hands over a new array). A project that is not readable reads as the
 * built-in workflow, so the built-in names are the fallback. A team switch
 * drops everything held for the team that was left.
 */
export function useProjectWorkflows(
  teamId: string | null,
  projects: readonly TeamTasksProject[],
): ReadonlyMap<string, readonly Workflow[]> {
  const teamRef = useRef<string | null>(null);
  const cacheRef = useRef<Map<string, Workflow[]>>(new Map());
  const forbiddenRef = useRef<Set<string>>(new Set());
  // Projects with a request on the way, so a list refresh while it runs does
  // not ask for the same project twice.
  const inFlightRef = useRef<Set<string>>(new Set());
  const [byProject, setByProject] = useState<ReadonlyMap<string, readonly Workflow[]>>(NO_WORKFLOWS);

  useEffect(() => {
    if (teamRef.current !== teamId) {
      teamRef.current = teamId;
      cacheRef.current = new Map();
      forbiddenRef.current = new Set();
      inFlightRef.current = new Set();
      setByProject(NO_WORKFLOWS);
    }
    if (!teamId) return;
    const cache = cacheRef.current;
    const inFlight = inFlightRef.current;
    const ids = projects.map((p) => p.id).filter((id) => !inFlight.has(id));
    if (ids.length === 0) return;
    for (const id of ids) inFlight.add(id);
    void loadMissingProjectWorkflows(ids, cache, forbiddenRef.current).then((gained) => {
      for (const id of ids) inFlight.delete(id);
      // The cache of a team that was left is a different map: its late answer
      // is dropped here.
      if (gained && cacheRef.current === cache) setByProject(new Map(cache));
    });
  }, [teamId, projects]);

  return byProject;
}
