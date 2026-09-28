import { Prisma, type PrismaClient } from "@prisma/client";
import type { Context } from "hono";
import type { AppVariables } from "../types/hono.js";
import { canonicalGithubRepo } from "./grounding-github-fence.js";
import { logger } from "../lib/logger.js";

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

/** Whether a task's own project is enforced. A missing scope enforces every project. */
export function groundingProjectEnforced(scope: GroundingEnforcedScope | undefined, projectId: string): boolean {
  return !scope || scope.projectIds.has(projectId);
}

/**
 * The exact GitHub target a legacy remote handler is about to send: the
 * repository string exactly as it goes into the GitHub URL, the PR number
 * exactly as it goes into the URL (none for a PR create), and the kind of
 * write.
 */
export interface GroundingRemoteTarget {
  repo: string;
  prNumber?: number;
  kind: "merge" | "create" | "comment";
  taskId: string;
}
export type GroundingRemoteRefusalCode = "grounding_enrollment_required" | "grounding_finalization_pending";
export interface GroundingRemoteRefusal {
  error: GroundingRemoteRefusalCode;
  status: 409;
  message: string;
}
/** Resolves to a refusal when the target must not be written by a legacy handler, else null. */
export type GroundingRemoteTargetGuard = (target: GroundingRemoteTarget) => Promise<GroundingRemoteRefusal | null>;

const refusalMessages: Record<GroundingRemoteRefusalCode, string> = {
  grounding_enrollment_required: "This GitHub target is under Grounding enforcement; the task must be enrolled before this operation can run.",
  grounding_finalization_pending: "Another Grounding operation owns this repository; retry after it finishes.",
};
function refusal(error: GroundingRemoteRefusalCode): GroundingRemoteRefusal {
  return { error, status: 409, message: refusalMessages[error] };
}

/**
 * Canonical identity of exactly the repository string a legacy handler sends
 * to GitHub, or null when that string is not one: surrounding whitespace, a
 * dot segment, an escaped or percent-encoded name, or an owner containing
 * '/' may all resolve on GitHub to a repository the guard cannot name, so the
 * caller fails closed on it.
 */
export function exactGithubRepo(raw: string): string | null {
  if (raw.length === 0 || raw !== raw.trim()) return null;
  try { return canonicalGithubRepo(raw); } catch { return null; }
}

/**
 * Ids of every peer-class task: protected or EXTERNAL_V1 cohort, bound, or
 * held. Shared by the merge grouping discovery and the effect-boundary guard,
 * so both read the enrollment and hold tables first and then the tasks by id,
 * never every task.
 */
export const groundingPeerTaskIds = Prisma.sql`ARRAY(
  SELECT "taskId" FROM grounding_cohorts WHERE protected OR mode = 'EXTERNAL_V1'
  UNION SELECT "taskId" FROM grounding_bindings
  UNION SELECT "taskId" FROM grounding_migration_states WHERE held)`;

/**
 * The effect-boundary check a legacy remote handler runs immediately before
 * its GitHub write, on exactly the repository and PR number it sends. A
 * missing scope refuses every target. Otherwise the target is refused with
 * `grounding_enrollment_required` when its repository string is not a
 * canonical identity, when the repository belongs to an enforced project, or
 * when the PR is a peer's: a protected, EXTERNAL_V1, bound or held task
 * (including the requesting task itself, should it have become one) whose
 * effective repository or PR URL repository is the target repository and
 * whose own PR number or PR URL number is the target number, or such a task
 * whose repository string is not canonical (so it could be an alias of the
 * target repository) sharing the number. A merge or create whose repository
 * fence another operation owns is refused with `grounding_finalization_pending`,
 * because the legacy task write would then fail on the fence after the GitHub
 * effect. Comments take no fence. Peer and fence are read in one statement,
 * so the only window before the GitHub call is that one round trip.
 */
export async function groundingRemoteTargetRefusal(db: PrismaClient | Prisma.TransactionClient, scope: GroundingEnforcedScope | undefined, target: GroundingRemoteTarget): Promise<GroundingRemoteRefusal | null> {
  if (!scope) return refusal("grounding_enrollment_required");
  const repo = exactGithubRepo(target.repo);
  if (repo === null) return refusal("grounding_enrollment_required");
  if (scope.repos.has(repo)) return refusal("grounding_enrollment_required");
  const pr = target.prNumber === undefined ? null : String(target.prNumber);
  const fenced = target.kind !== "comment";
  const [row] = await db.$queryRaw<{ peer: boolean; fenced: boolean }[]>`
    SELECT
      (${pr}::numeric IS NOT NULL AND EXISTS (
        SELECT 1 FROM tasks t JOIN projects p ON p.id = t."projectId"
        WHERE t.id = ANY (${groundingPeerTaskIds})
          AND (t."prNumber"::numeric = ${pr}::numeric
            OR substring(t."prUrl" from '/pull/([0-9]+)')::numeric = ${pr}::numeric)
          AND (grounding_github_repo(coalesce(t."deliverableRepo", p."githubRepo")) = ${repo}
            OR grounding_github_pr_repo(t."prUrl") = ${repo}
            OR (coalesce(t."deliverableRepo", p."githubRepo") <> '' AND grounding_github_repo(coalesce(t."deliverableRepo", p."githubRepo")) IS NULL)
            OR (t."prUrl" ~* 'github[.]com/[^/]+/[^/]+/pull/' AND grounding_github_pr_repo(t."prUrl") IS NULL)))) AS peer,
      (${fenced} AND EXISTS (
        SELECT 1 FROM grounding_github_repository_fences WHERE repo = ${repo} AND "ownerId" IS NOT NULL)) AS fenced
  `;
  if (!row) return refusal("grounding_enrollment_required");
  if (row.peer) return refusal("grounding_enrollment_required");
  if (row.fenced) return refusal("grounding_finalization_pending");
  return null;
}

/** The guard an enabled runtime installs for every legacy remote handler. */
export function createGroundingRemoteTargetGuard(deps: { db: PrismaClient; scope: GroundingEnforcedScope | undefined }): GroundingRemoteTargetGuard {
  return async target => {
    const refused = await groundingRemoteTargetRefusal(deps.db, deps.scope, target);
    if (refused) logger.info({ taskId: target.taskId, kind: target.kind, refusal: refused.error }, "grounding remote target refused");
    return refused;
  };
}

/**
 * The guard a legacy handler consults at its effect boundary. The
 * application sets it for every request: the enabled runtime's guard, or null
 * in the unconfigured application, whose legacy handlers then make no guard
 * call at all. A handler mounted without that wiring cannot tell the two
 * apart, so it fails closed: its guard throws before any GitHub call.
 */
export function groundingRemoteGuardFor(c: Context<{ Variables: AppVariables }>): GroundingRemoteTargetGuard | null {
  const guard = c.get("groundingRemoteTargetGuard");
  return guard === undefined ? unwiredRemoteTargetGuard : guard;
}
const unwiredRemoteTargetGuard: GroundingRemoteTargetGuard = async () => { throw new Error("Grounding remote target guard is not wired"); };
