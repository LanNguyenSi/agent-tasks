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

export const emptyGroundingScope: GroundingEnforcedScope = Object.freeze({ projectIds: new Set<string>(), repos: new Set<string>() });

export interface GroundingScopeTask {
  id: string;
  projectId: string;
  deliverableRepo: string | null;
  prNumber: number | null;
  prUrl: string | null;
  project: { githubRepo: string | null };
}

const prUrlPattern = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([0-9]+)(?:[/?#]|$)/i;

/**
 * The operation's effective repository, resolved the same way the merge path
 * resolves it: an explicit request repo first (owner/repo body fields on the
 * direct GitHub routes), then the task's own deliverable/project repo, then a
 * repo parsed out of a pre-existing PR URL. Returns null when nothing on the
 * task identifies a repository at all.
 */
export function resolveEffectiveGithubRepo(task: GroundingScopeTask, explicitRepo?: string): string | null {
  const candidates = [explicitRepo, task.deliverableRepo, task.project.githubRepo];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { return canonicalGithubRepo(candidate); } catch { /* try the next candidate */ }
  }
  const match = task.prUrl ? prUrlPattern.exec(task.prUrl.trim()) : null;
  if (match) { try { return canonicalGithubRepo(match[1]!); } catch { /* an unparseable PR URL identifies no repo */ } }
  return null;
}

/**
 * Whether a fresh remote operation on an UNPROVISIONED task must still be
 * enrolled: the task's own project is in the enforced scope, OR its effective
 * repository belongs to an enforced project, OR it shares a repo+PR with a
 * protected/EXTERNAL_V1/held peer (reusing protectedGithubPeerIds rather than
 * duplicating that SQL). Callers pass the explicit repo/prNumber a direct
 * GitHub route resolves from its own request body/path, when it has one.
 */
export async function isEnforcedRemoteOperation(
  db: PrismaClient | Prisma.TransactionClient,
  scope: GroundingEnforcedScope,
  task: GroundingScopeTask,
  explicit?: { repo?: string; prNumber?: number },
): Promise<boolean> {
  if (scope.projectIds.has(task.projectId)) return true;
  const repo = resolveEffectiveGithubRepo(task, explicit?.repo);
  if (repo !== null && scope.repos.has(repo)) return true;
  const prNumber = explicit?.prNumber ?? task.prNumber ?? null;
  if (repo === null || prNumber === null) return false;
  const peers = await protectedGithubPeerIds(db, { repo, excludeTaskId: task.id });
  if (peers.length === 0) return false;
  const candidates = await db.task.findMany({ where: { id: { in: peers.map(peer => peer.id) } }, select: { prNumber: true, prUrl: true } });
  return candidates.some(candidate => {
    if (candidate.prNumber === prNumber) return true;
    const url = candidate.prUrl ? prUrlPattern.exec(candidate.prUrl.trim()) : null;
    return url !== null && Number(url[2]) === prNumber;
  });
}
