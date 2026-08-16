/**
 * Client-side task-id prefix resolution (task e7911cdd).
 *
 * `tasks get`/`start`/`finish`/`comment` accept either a full task UUID or a
 * short prefix (e.g. copied from the ID column `tasks list` now prints). A
 * full UUID resolves with zero network calls -- the common case for scripted
 * callers stays exactly as fast as before. A non-UUID value is treated as a
 * prefix and matched, case-insensitively, against `api.searchTaskPool` (see
 * api.ts for why that endpoint is the search surface). Zero matches or more
 * than one match is a hard error listing the candidates: this never silently
 * guesses which task was meant.
 */
import type { Config } from "./config.js";
import * as api from "./api.js";

export async function resolveTaskId(config: Config, idOrPrefix: string): Promise<string> {
  if (api.isUuid(idOrPrefix)) return idOrPrefix;

  const pool = await api.searchTaskPool(config);
  const match = api.matchTaskIdPrefix(pool, idOrPrefix);

  if (match.kind === "unique") return match.id;

  if (match.kind === "none") {
    console.error(`Error: no task found matching id prefix '${idOrPrefix}'.`);
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
