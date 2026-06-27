// PR-number derivation from a pull-request URL, for the human edit form.
// The backend's prPresent gate requires BOTH prUrl and prNumber; agents set
// the number explicitly (task_submit_pr), the UI derives it from the
// canonical URL instead so a human never has to type it.

/**
 * Extract the pull-request number from a GitHub PR URL, or null when the
 * URL does not contain a `/pull/<n>` segment. Slightly stricter than the
 * backend's task_finish parser (`/\/pull\/(\d+)/`): the number must end the
 * segment, so hand-typed near-misses like `/pull/123abc` are rejected
 * instead of silently truncated.
 */
export function parsePrNumberFromUrl(url: string): number | null {
  const match = url.match(/\/pull\/(\d+)(?:$|[/?#])/);
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * True only for http(s) URLs. Guard a user/agent-supplied URL (e.g. task.prUrl)
 * with this before rendering it as an `<a href>`: a `javascript:` / `data:` URL
 * would otherwise execute on click (stored XSS). The backend allowlists the
 * scheme too — this is defense in depth at the render boundary.
 */
export function isHttpUrl(value: string | null | undefined): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}
