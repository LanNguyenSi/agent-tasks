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

/** Shape of what we consume from GitHub's `GET /repos/:o/:r/pulls/:n`.
 *  We only read the fields we actually use — `merged`, `state`, and
 *  `head.sha` — but typed conservatively so a missing field throws
 *  instead of silently producing nonsense. */
export interface PullResponse {
  head: { sha: string };
  state: "open" | "closed";
  merged: boolean;
}

// ── Caches ──────────────────────────────────────────────────────────────────
//
// Two independent caches, both 60s TTL:
//
// - `_prCache`: keyed by (owner, repo, prNumber). Shared between
//   fetchCheckRunStatus and fetchPullRequestStatus so a task with both
//   `ciGreen` and `prMerged` gates only makes one PR fetch per 60s.
// - `_checkCache`: keyed by (owner, repo, sha). Sha-keyed so a force-push
//   invalidates naturally; a PR-number key would return stale check runs
//   after a force push.

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 1000;

interface GenericCacheEntry<T> {
  value: T;
  insertedAt: number;
}

function genericCacheGet<T>(
  cache: Map<string, GenericCacheEntry<T>>,
  key: string,
  now: number,
): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (now - hit.insertedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function genericCachePut<T>(
  cache: Map<string, GenericCacheEntry<T>>,
  key: string,
  value: T,
  now: number,
): void {
  // Cheap FIFO: drop the oldest insertion when full. Map iteration order
  // is insertion order in JS, so this is O(1) — acceptable for a 60s TTL
  // and a 1000-entry budget.
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, { value, insertedAt: now });
}

// Exported for tests only. Do not mutate from product code.
export const _checkCache = new Map<string, GenericCacheEntry<CheckRunStatus>>();
export const _prCache = new Map<string, GenericCacheEntry<PullResponse>>();

function checkCacheKey(owner: string, repo: string, sha: string): string {
  return `${owner}/${repo}@${sha}`;
}

function prCacheKey(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}#${prNumber}`;
}

export function _clearCheckCache(): void {
  _checkCache.clear();
  _prCache.clear();
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
 * Fetch a PR and cache the result for 60s. Used by both
 * `fetchCheckRunStatus` (reads `head.sha`) and `fetchPullRequestStatus`
 * (reads `merged` + `state`), so a task with both gates active only
 * makes one network call per 60s.
 *
 * Validates the unchecked cross-network fields. Without these guards,
 * a malformed GitHub response propagates `undefined` into downstream
 * cache keys and URLs, producing stable-but-wrong cache entries.
 *
 * Throws `GithubChecksError` on any API failure.
 */
export async function fetchPullRequest(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  now: number = Date.now(),
): Promise<PullResponse> {
  const key = prCacheKey(owner, repo, prNumber);
  const cached = genericCacheGet(_prCache, key, now);
  if (cached) return cached;

  const pull = await githubGet<PullResponse>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`,
    token,
  );

  const sha = pull?.head?.sha;
  if (typeof sha !== "string" || sha.length === 0) {
    throw new GithubChecksError("Malformed PR response: missing head.sha");
  }
  if (pull.state !== "open" && pull.state !== "closed") {
    throw new GithubChecksError(`Malformed PR response: unexpected state "${pull.state}"`);
  }
  if (typeof pull.merged !== "boolean") {
    throw new GithubChecksError("Malformed PR response: missing merged flag");
  }

  genericCachePut(_prCache, key, pull, now);
  return pull;
}

/**
 * Fetch the HEAD SHA of a PR and the check runs for that SHA. Returns a
 * classified status. Cache is keyed by (owner, repo, sha) — not by PR
 * number — so a force-push that moves the head gets a fresh lookup on
 * the next call even if the previous SHA was still warm.
 *
 * Throws `GithubChecksError` on any API failure.
 */
export async function fetchCheckRunStatus(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  now: number = Date.now(),
): Promise<CheckRunStatus> {
  const pull = await fetchPullRequest(owner, repo, prNumber, token, now);
  const sha = pull.head.sha;
  const key = checkCacheKey(owner, repo, sha);

  const cached = genericCacheGet(_checkCache, key, now);
  if (cached) return cached;

  const checks = await githubGet<CheckRunsResponse>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${sha}/check-runs?per_page=100`,
    token,
  );
  const status = classifyCheckRuns(checks.check_runs, sha);
  genericCachePut(_checkCache, key, status, now);
  return status;
}

// ── Pull request merge status ───────────────────────────────────────────────

export interface PullRequestStatus {
  /** One of:
   *  - `merged`: PR was merged into the base branch
   *  - `open`: PR is still open
   *  - `closed_unmerged`: PR was closed without merging (rejected)
   *  - `unknown`: GitHub returned an unexpected combination of state/merged
   */
  state: "merged" | "open" | "closed_unmerged" | "unknown";
  /** Head commit SHA — useful for log correlation with check-runs status. */
  sha: string;
}

/**
 * Classify a fetched PR object into a single merge state. Pure — exposed
 * for testability. Separate from `fetchPullRequest` so tests can exercise
 * the classification without mocking fetch.
 */
export function classifyPullRequest(pull: PullResponse): PullRequestStatus {
  const sha = pull.head.sha;
  if (pull.state === "open") {
    if (pull.merged) {
      // GitHub shouldn't produce this combination, but fail closed if it does.
      return { state: "unknown", sha };
    }
    return { state: "open", sha };
  }
  // state === "closed"
  if (pull.merged) return { state: "merged", sha };
  return { state: "closed_unmerged", sha };
}

/**
 * Fetch the PR and classify its merge state. Fail-closed on malformed
 * response or API error — caller treats anything non-`merged` as a
 * failed rule evaluation.
 */
export async function fetchPullRequestStatus(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  now: number = Date.now(),
): Promise<PullRequestStatus> {
  const pull = await fetchPullRequest(owner, repo, prNumber, token, now);
  return classifyPullRequest(pull);
}
