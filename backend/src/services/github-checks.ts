/**
 * GitHub Check Runs query — used by the `ciGreen` transition gate.
 *
 * Intentionally minimal: one entry point `fetchCheckRunStatus` that takes
 * (owner, repo, prNumber, token) and returns a classified status. The
 * caller (transition-rules.ts) decides what to do with a `failing` or
 * `pending` result.
 *
 * ## Fail-closed semantics
 *
 * Any network/API error propagates up to the caller as a thrown
 * `GithubChecksError`. The rule evaluator catches and treats an error as
 * blocking — i.e. if GitHub is unreachable or the token expired, the
 * transition is blocked with a clear message and the admin force path
 * is still available. Fail-open would silently bypass the gate, which
 * defeats the purpose of enforcing "green CI before done".
 *
 * ## Caching
 *
 * Responses are cached in-memory for 60 seconds keyed by (repo, sha).
 * CI status changes frequently during PR iteration but rarely within
 * the window of a single transition attempt, and this keeps us clear of
 * GitHub's 5000-req/hr rate limit for interactive UIs. Max 1000 cached
 * SHAs — simple LRU-ish eviction (oldest insertion first). In-memory is
 * fine until we shard the backend; when we do, promote to Redis.
 */

export interface CheckRunStatus {
  /** One of: success, failing, pending, empty, unknown.
   *  - `success`: every check run ended in success (or neutral/skipped)
   *  - `failing`: at least one check run ended in a failure state
   *  - `pending`: at least one check run is still queued or in_progress
   *  - `empty`: no check runs are configured for this commit
   *  - `unknown`: unexpected conclusion value from GitHub (fail-safe)
   */
  state: "success" | "failing" | "pending" | "empty" | "unknown";
  total: number;
  successful: number;
  failing: number;
  pending: number;
  /** The commit SHA the status was computed against. */
  sha: string;
}

export class GithubChecksError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "GithubChecksError";
  }
}

interface CheckRunsResponse {
  total_count: number;
  check_runs: Array<{
    status: "queued" | "in_progress" | "completed";
    conclusion:
      | "success"
      | "failure"
      | "neutral"
      | "cancelled"
      | "skipped"
      | "timed_out"
      | "action_required"
      | "stale"
      | null;
  }>;
}

interface PullResponse {
  head: { sha: string };
}

// ── Cache ───────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 1000;

interface CacheEntry {
  status: CheckRunStatus;
  insertedAt: number;
}

// Exported for tests only. Do not mutate from product code.
export const _checkCache = new Map<string, CacheEntry>();

function cacheKey(owner: string, repo: string, sha: string): string {
  return `${owner}/${repo}@${sha}`;
}

function cacheGet(key: string, now: number): CheckRunStatus | undefined {
  const hit = _checkCache.get(key);
  if (!hit) return undefined;
  if (now - hit.insertedAt > CACHE_TTL_MS) {
    _checkCache.delete(key);
    return undefined;
  }
  return hit.status;
}

function cachePut(key: string, status: CheckRunStatus, now: number): void {
  // Cheap LRU: drop the oldest insertion when full. Map iteration order is
  // insertion order in JS, so this is O(1).
  if (_checkCache.size >= CACHE_MAX_ENTRIES) {
    const firstKey = _checkCache.keys().next().value;
    if (firstKey !== undefined) _checkCache.delete(firstKey);
  }
  _checkCache.set(key, { status, insertedAt: now });
}

export function _clearCheckCache(): void {
  _checkCache.clear();
}

// ── Classifier ──────────────────────────────────────────────────────────────

/**
 * Reduce a list of check runs to a single state.
 *
 * Precedence (high → low): pending > failing > empty > success.
 * Rationale: if anything is still running, the CI result isn't final —
 * block until it settles. If anything failed, block immediately even if
 * others succeeded.
 */
export function classifyCheckRuns(runs: CheckRunsResponse["check_runs"], sha: string): CheckRunStatus {
  let successful = 0;
  let failing = 0;
  let pending = 0;
  let unknown = 0;

  for (const run of runs) {
    if (run.status === "queued" || run.status === "in_progress") {
      pending += 1;
      continue;
    }
    // status === "completed"
    switch (run.conclusion) {
      case "success":
      case "neutral":
      case "skipped":
        successful += 1;
        break;
      case "failure":
      case "cancelled":
      case "timed_out":
      case "action_required":
      case "stale":
        failing += 1;
        break;
      case null:
        // A completed run with no conclusion is GitHub-side weirdness; treat
        // as pending so we don't accidentally pass.
        pending += 1;
        break;
      default:
        unknown += 1;
    }
  }

  const total = runs.length;
  if (total === 0) {
    return { state: "empty", total: 0, successful: 0, failing: 0, pending: 0, sha };
  }
  if (pending > 0) {
    return { state: "pending", total, successful, failing, pending, sha };
  }
  if (failing > 0) {
    return { state: "failing", total, successful, failing, pending, sha };
  }
  if (unknown > 0) {
    // Conservative: unrecognized conclusion → fail closed.
    return { state: "unknown", total, successful, failing, pending, sha };
  }
  return { state: "success", total, successful, failing, pending, sha };
}

// ── GitHub API calls ────────────────────────────────────────────────────────

async function githubGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    // Don't include response body in the error — it can contain tokens on
    // some endpoints, and we pass this message back to users via the
    // transition error response. Keep it to status + path.
    throw new GithubChecksError(
      `GitHub API ${res.status} on ${path}`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

/**
 * Fetch the HEAD SHA of a PR and the check runs for that SHA. Returns a
 * classified status. Cache is keyed by (owner, repo, sha) — not by PR
 * number — so a force-push that moves the head gets a fresh lookup on the
 * next call even if the previous SHA was still warm in the cache.
 *
 * Throws `GithubChecksError` on any API failure. The caller is expected
 * to translate that into a blocked transition.
 */
export async function fetchCheckRunStatus(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  now: number = Date.now(),
): Promise<CheckRunStatus> {
  const pull = await githubGet<PullResponse>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`,
    token,
  );
  // Validate the unchecked field access across the network boundary.
  // Without this guard, a malformed response propagates an `undefined`
  // SHA into the cache key and the check-runs URL, producing a stable
  // `o/r@undefined` entry that sticks for 60s — a latent fail-open if
  // anything downstream ever starts treating `empty` check runs as pass.
  const sha = pull?.head?.sha;
  if (typeof sha !== "string" || sha.length === 0) {
    throw new GithubChecksError("Malformed PR response: missing head.sha");
  }
  const key = cacheKey(owner, repo, sha);

  const cached = cacheGet(key, now);
  if (cached) return cached;

  const checks = await githubGet<CheckRunsResponse>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${sha}/check-runs?per_page=100`,
    token,
  );
  const status = classifyCheckRuns(checks.check_runs, sha);
  cachePut(key, status, now);
  return status;
}
