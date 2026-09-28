import type { Prisma, PrismaClient } from "@prisma/client";
import { canonicalGithubRepo } from "./grounding-github-fence.js";
import { protectedGithubPeerIds } from "./grounding-github-merge.js";

/**
 * The enforced scope of an enabled runtime configuration: the projects whose
 * fresh remote operations must be enrolled, plus the canonical GitHub
 * repositories those same projects own. Both sets are computed once at
 * startup from the frozen creationPolicy and never change for the process
 * lifetime (see composeGroundingRuntime).
 */
export interface GroundingEnforcedScope {
  projectIds: ReadonlySet<string>;
  repos: ReadonlySet<string>;
}

export interface GroundingScopeTask {
  id: string;
  projectId: string;
  deliverableRepo: string | null;
  prNumber: number | null;
  prUrl: string | null;
  project: { githubRepo: string | null };
}

/**
 * Targets a request itself supplies, on top of the ones stored on the task.
 * A legacy handler may act on either, so the guard checks every one.
 */
export interface GroundingRemoteTargets {
  /** Request-supplied repositories as the legacy handler would join them, for
   * example `${owner}/${repo}` from body fields; not pre-canonicalized. */
  repos?: readonly (string | null | undefined)[];
  /** Request-supplied PR numbers, for example the merge route's path parameter. */
  prNumbers?: readonly (number | null | undefined)[];
  /** Request-supplied PR URLs; each contributes its repository and its number. */
  prUrls?: readonly (string | null | undefined)[];
}

// The same extraction the legacy handlers apply to a PR URL: the cross-repo
// gate reads owner/repo with the first pattern, and finish Mode A reads the
// PR number with the second. Matching case-insensitively only widens the set
// of candidates the guard checks.
const legacyPrUrlRepo = /github\.com\/([^/]+)\/([^/]+)\/pull\//i;
const legacyPrUrlNumber = /\/pull\/(\d+)/;

/**
 * Canonical form of a repository string. A non-empty string that is not a
 * canonical `owner/repo` identity (a dot segment, a percent-encoded or
 * otherwise escaped name, an owner containing '/') is `unresolved`: the
 * legacy handlers pass such strings to GitHub verbatim, and GitHub may
 * resolve them to a repository the guard cannot name, so the caller fails
 * closed on it.
 */
function canonicalCandidate(value: string | null | undefined): { repo: string | null; unresolved: boolean } {
  if (typeof value !== "string" || value.length === 0) return { repo: null, unresolved: false };
  try { return { repo: canonicalGithubRepo(value), unresolved: false }; } catch { return { repo: null, unresolved: true }; }
}

/**
 * Repository and PR number a PR URL names, each null when it names none.
 * `unresolved` is true when the URL names a repository in the legacy shape
 * that is not a canonical identity.
 */
export function prUrlTarget(url: string | null | undefined): { repo: string | null; prNumber: number | null; unresolved: boolean } {
  if (!url) return { repo: null, prNumber: null, unresolved: false };
  const repoMatch = legacyPrUrlRepo.exec(url);
  const numberMatch = legacyPrUrlNumber.exec(url);
  const prNumber = numberMatch ? Number(numberMatch[1]) : null;
  const repo = repoMatch ? canonicalCandidate(`${repoMatch[1]}/${repoMatch[2]}`) : { repo: null, unresolved: false };
  return { ...repo, prNumber: prNumber !== null && Number.isSafeInteger(prNumber) ? prNumber : null };
}

/**
 * Every repository and PR number a legacy remote handler could act on for
 * this task and request. Legacy merges derive the repository from the
 * project and the PR number from the task (or the request when the task has
 * none), but the task's deliverable repository, its stored PR URL and the
 * request's own fields are included too, so a request that names one target
 * while the handler acts on another is still checked against both.
 * `unresolved` is true when any of those repository strings is non-empty but
 * not canonical (see canonicalCandidate).
 */
export function remoteOperationCandidates(task: GroundingScopeTask, targets: GroundingRemoteTargets = {}) {
  const stored = prUrlTarget(task.prUrl);
  const requested = (targets.prUrls ?? []).map(prUrlTarget);
  const repos = new Set<string>();
  let unresolved = false;
  for (const value of [...(targets.repos ?? []), task.deliverableRepo, task.project.githubRepo]) {
    const candidate = canonicalCandidate(value);
    if (candidate.repo !== null) repos.add(candidate.repo);
    if (candidate.unresolved) unresolved = true;
  }
  for (const target of [stored, ...requested]) {
    if (target.repo !== null) repos.add(target.repo);
    if (target.unresolved) unresolved = true;
  }
  const prNumbers = new Set<number>();
  for (const value of [...(targets.prNumbers ?? []), task.prNumber, stored.prNumber, ...requested.map(target => target.prNumber)]) {
    if (typeof value === "number" && Number.isSafeInteger(value)) prNumbers.add(value);
  }
  return { repos, prNumbers, unresolved };
}

/**
 * Whether another operation currently owns the repository fence of any
 * candidate repository. A legacy handler that performed its GitHub effect in
 * such a repository would then fail its own task write on the fence, leaving
 * the effect without its recorded outcome, so the caller refuses before the
 * effect instead. This is a point-in-time read: a fence acquired after it is
 * not seen.
 */
export async function candidateRepositoryFenceOwned(db: PrismaClient | Prisma.TransactionClient, task: GroundingScopeTask, targets: GroundingRemoteTargets = {}): Promise<boolean> {
  const { repos } = remoteOperationCandidates(task, targets);
  if (repos.size === 0) return false;
  const owned = await db.groundingGithubRepositoryFence.findFirst({ where: { repo: { in: [...repos] }, ownerId: { not: null } }, select: { repo: true } });
  return owned !== null;
}

/**
 * Whether a peer-class task (protected or EXTERNAL_V1 cohort, bound, or held)
 * other than `excludeTaskId` stores its repository as a string the peer
 * lookup cannot canonicalize (its effective repository, or the repository of
 * a PR URL in the legacy shape) while sharing one of these PR numbers (its
 * own, or its PR URL's). protectedGithubPeerIds matches canonical
 * repositories only, so such a peer could be an alias of a candidate
 * repository without being seen; the caller fails closed on it. The query is
 * driven from the enrollment and hold tables, so it reads peer-class tasks
 * only, never every task, and stops at the first match.
 */
export async function nonCanonicalPeerSharesPr(db: PrismaClient | Prisma.TransactionClient, input: { prNumbers: Iterable<number>; excludeTaskId: string }): Promise<boolean> {
  const numbers = [...input.prNumbers].map(String);
  if (numbers.length === 0) return false;
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT t.id FROM tasks t JOIN projects p ON p.id = t."projectId"
    WHERE t.id IN (
        SELECT "taskId" FROM grounding_cohorts WHERE protected OR mode = 'EXTERNAL_V1'
        UNION SELECT "taskId" FROM grounding_bindings
        UNION SELECT "taskId" FROM grounding_migration_states WHERE held)
      AND t.id <> ${input.excludeTaskId}
      AND (t."prNumber"::numeric = ANY(${numbers}::numeric[])
        OR substring(t."prUrl" from '/pull/([0-9]+)')::numeric = ANY(${numbers}::numeric[]))
      AND ((coalesce(t."deliverableRepo", p."githubRepo") <> '' AND grounding_github_repo(coalesce(t."deliverableRepo", p."githubRepo")) IS NULL)
        OR (t."prUrl" ~* 'github[.]com/[^/]+/[^/]+/pull/' AND grounding_github_pr_repo(t."prUrl") IS NULL))
    LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * Whether a fresh remote operation on an UNPROVISIONED task must still be
 * enrolled: the task's own project is in the enforced scope, OR any candidate
 * repository (see remoteOperationCandidates) belongs to an enforced project,
 * OR any candidate (repository, PR number) pair is shared with a protected,
 * EXTERNAL_V1 or held peer (reusing protectedGithubPeerIds rather than
 * duplicating that SQL), OR any candidate repository string is not a
 * canonical identity (it cannot be compared, so it fails closed), OR a
 * peer-class task whose own repository string is not canonical shares a
 * candidate PR number (see nonCanonicalPeerSharesPr). A missing scope fails
 * closed too: everything is enforced.
 */
export async function isEnforcedRemoteOperation(
  db: PrismaClient | Prisma.TransactionClient,
  scope: GroundingEnforcedScope | undefined,
  task: GroundingScopeTask,
  targets: GroundingRemoteTargets = {},
): Promise<boolean> {
  if (!scope) return true;
  if (scope.projectIds.has(task.projectId)) return true;
  const { repos, prNumbers, unresolved } = remoteOperationCandidates(task, targets);
  if (unresolved) return true;
  for (const repo of repos) if (scope.repos.has(repo)) return true;
  if (prNumbers.size === 0) return false;
  if (await nonCanonicalPeerSharesPr(db, { prNumbers, excludeTaskId: task.id })) return true;
  const peerIds = new Set<string>();
  for (const repo of repos) {
    for (const peer of await protectedGithubPeerIds(db, { repo, excludeTaskId: task.id })) peerIds.add(peer.id);
  }
  if (peerIds.size === 0) return false;
  const peers = await db.task.findMany({ where: { id: { in: [...peerIds] } }, select: { prNumber: true, prUrl: true } });
  return peers.some(peer => {
    if (peer.prNumber !== null && prNumbers.has(peer.prNumber)) return true;
    const fromUrl = prUrlTarget(peer.prUrl).prNumber;
    return fromUrl !== null && prNumbers.has(fromUrl);
  });
}
