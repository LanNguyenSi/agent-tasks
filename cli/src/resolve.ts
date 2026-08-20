/**
 * Client-side task-id prefix resolution (task e7911cdd).
 *
 * `tasks get`/`start`/`finish`/`comment` and friends accept either a full
 * task UUID or a short prefix (e.g. copied from the ID column `tasks list`
 * now prints). A full UUID resolves with zero network calls -- the common
 * case for scripted callers stays exactly as fast as before. A non-UUID
 * value is treated as a prefix and matched, case-insensitively, against
 * `api.searchTaskPool` (see api.ts for why that endpoint is the search
 * surface, its newest-first sort, and its page cap). Zero matches or more
 * than one match is a hard error listing the candidates: this never
 * silently guesses which task was meant.
 *
 * The search pool includes `backlog` tasks (D18 revision), so a backlog
 * task's id-prefix resolves the same as any other. Resolving the id is pure
 * discovery, not a claim grant -- a claim-oriented command (`start`,
 * `claim`, ...) still gets the server's 403 `backlog_not_promoted` if the
 * resolved task hasn't been promoted out of backlog by a human.
 */
import type { Config } from "./config.js";
import * as api from "./api.js";

export async function resolveTaskId(config: Config, idOrPrefix: string): Promise<string> {
  if (api.isUuid(idOrPrefix)) return idOrPrefix;

  let result: api.SearchTaskPoolResult;
  try {
    result = await api.searchTaskPool(config, idOrPrefix);
  } catch (err) {
    // A raw `API error 400: ...` from the top-level handler doesn't tell a
    // multi-team human caller that it was the *prefix search* that failed
    // (e.g. `resolveTeamId` 400ing because they belong to more than one
    // team and passed no --team-id). Name the failing step and offer the
    // escape hatch that always works: the full UUID skips this search
    // entirely (see the isUuid short-circuit above).
    if (err instanceof api.ApiError) {
      console.error(
        `Error: could not resolve id prefix '${idOrPrefix}': task-id prefix search failed (${err.message}). Pass the full task UUID instead.`,
      );
      process.exit(1);
    }
    throw err;
  }

  const { match, searched, capped } = result;

  if (match.kind === "unique") return match.id;

  if (match.kind === "none") {
    const detail = capped
      ? ` in the ${searched} tasks searched (capped; pass the full UUID)`
      : "";
    console.error(`Error: no task found matching id prefix '${idOrPrefix}'${detail}.`);
    process.exit(1);
  }

  console.error(
    [
      `Error: ambiguous id prefix '${idOrPrefix}' matches ${match.matches.length} tasks:`,
      ...match.matches.map((t) => `  ${t.id}  ${t.title}`),
    ].join("\n"),
  );
  process.exit(1);
}
