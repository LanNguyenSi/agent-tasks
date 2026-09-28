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
  /** Request-supplied repositories, for example owner/repo body fields. */
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

function canonicalOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  try { return canonicalGithubRepo(value); } catch { return null; }
}

/** Repository and PR number a PR URL names, each null when it names none. */
export function prUrlTarget(url: string | null | undefined): { repo: string | null; prNumber: number | null } {
  if (!url) return { repo: null, prNumber: null };
  const repoMatch = legacyPrUrlRepo.exec(url);
  const numberMatch = legacyPrUrlNumber.exec(url);
  const prNumber = numberMatch ? Number(numberMatch[1]) : null;
  return {
    repo: repoMatch ? canonicalOrNull(`${repoMatch[1]}/${repoMatch[2]}`) : null,
    prNumber: prNumber !== null && Number.isSafeInteger(prNumber) ? prNumber : null,
  };
}

/**
 * Every repository and PR number a legacy remote handler could act on for
 * this task and request. Legacy merges derive the repository from the
 * project and the PR number from the task (or the request when the task has
 * none), but the task's deliverable repository, its stored PR URL and the
 * request's own fields are included too, so a request that names one target
 * while the handler acts on another is still checked against both.
 */
export function remoteOperationCandidates(task: GroundingScopeTask, targets: GroundingRemoteTargets = {}) {
  const stored = prUrlTarget(task.prUrl);
  const requested = (targets.prUrls ?? []).map(prUrlTarget);
  const repos = new Set<string>();
  for (const value of [...(targets.repos ?? []), task.deliverableRepo, task.project.githubRepo]) {
    const repo = canonicalOrNull(value);
    if (repo !== null) repos.add(repo);
  }
  for (const target of [stored, ...requested]) if (target.repo !== null) repos.add(target.repo);
  const prNumbers = new Set<number>();
  for (const value of [...(targets.prNumbers ?? []), task.prNumber, stored.prNumber, ...requested.map(target => target.prNumber)]) {
    if (typeof value === "number" && Number.isSafeInteger(value)) prNumbers.add(value);
  }
  return { repos, prNumbers };
}

/**
 * Whether a fresh remote operation on an UNPROVISIONED task must still be
 * enrolled: the task's own project is in the enforced scope, OR any candidate
 * repository (see remoteOperationCandidates) belongs to an enforced project,
 * OR any candidate (repository, PR number) pair is shared with a protected,
 * EXTERNAL_V1 or held peer (reusing protectedGithubPeerIds rather than
 * duplicating that SQL). A missing scope fails closed: everything is
 * enforced.
 */
export async function isEnforcedRemoteOperation(
  db: PrismaClient | Prisma.TransactionClient,
  scope: GroundingEnforcedScope | undefined,
  task: GroundingScopeTask,
  targets: GroundingRemoteTargets = {},
): Promise<boolean> {
  if (!scope) return true;
  if (scope.projectIds.has(task.projectId)) return true;
  const { repos, prNumbers } = remoteOperationCandidates(task, targets);
  for (const repo of repos) if (scope.repos.has(repo)) return true;
  if (prNumbers.size === 0) return false;
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
