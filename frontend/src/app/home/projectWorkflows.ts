// Loads the stored workflows of the projects the home dashboard shows, so the
// widgets can tell a custom terminal state from a custom open one (see
// terminalStatesResolver in widgetFilters.ts).

import { getWorkflows, type Workflow } from "../../lib/api";

/**
 * Fills `cache` with the workflow rows of every project in `projectIds` that it
 * does not hold yet. A project whose list cannot be read (no access, a failed
 * request) is left out of the cache, so it reads as the built-in workflow and
 * is tried again on the next call. Returns true when `cache` gained a project.
 */
export async function loadMissingProjectWorkflows(
  projectIds: readonly string[],
  cache: Map<string, Workflow[]>,
): Promise<boolean> {
  const missing = projectIds.filter((id) => !cache.has(id));
  const results = await Promise.all(
    missing.map(async (id) => {
      try {
        return [id, await getWorkflows(id)] as const;
      } catch {
        return null;
      }
    }),
  );
  let added = false;
  for (const r of results) {
    if (!r) continue;
    cache.set(r[0], r[1]);
    added = true;
  }
  return added;
}
