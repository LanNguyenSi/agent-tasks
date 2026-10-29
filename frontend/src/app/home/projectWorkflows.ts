// Loads the stored workflows of the projects the home dashboard shows, so the
// widgets can tell a custom terminal state from a custom open one (see
// terminalStatesResolver in widgetFilters.ts).

import { getWorkflows, type Workflow } from "../../lib/api";

/** A 403 from the workflow list: the caller may not read this project's workflows. */
function isForbidden(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: unknown }).status === 403;
}

/**
 * Fills `cache` with the workflow rows of every project in `projectIds` that it
 * does not hold yet. A project whose list cannot be read is left out of the
 * cache, so it reads as the built-in workflow. When `forbidden` is given, a
 * project that answered 403 is remembered there and not requested again by
 * later calls with the same set (the caller clears it on a team switch); any
 * other failure (network, 5xx) is tried again on the next call. Returns true
 * when `cache` gained a project.
 */
export async function loadMissingProjectWorkflows(
  projectIds: readonly string[],
  cache: Map<string, Workflow[]>,
  forbidden?: Set<string>,
): Promise<boolean> {
  const missing = projectIds.filter((id) => !cache.has(id) && !forbidden?.has(id));
  const results = await Promise.all(
    missing.map(async (id) => {
      try {
        return [id, await getWorkflows(id)] as const;
      } catch (err) {
        if (isForbidden(err)) forbidden?.add(id);
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
