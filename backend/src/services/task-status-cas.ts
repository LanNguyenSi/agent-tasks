/**
 * Compare-and-swap for task writes that set `status`.
 *
 * A handler reads the task, validates a transition against what it read (the
 * status, the work claim, the review lock) and then writes. Between the read
 * and the write another request can change any of those. The write is
 * therefore conditional on everything the validation looked at:
 *
 *   - `status`: the transition was validated from this status.
 *   - `statusVersion`: a counter bumped by every write that sets `status`,
 *     so a round trip back to the same status (review -> in_progress ->
 *     review) is still seen as a change; `status` alone cannot tell.
 *   - the work claim and the review lock: the distinct-reviewer gate decides
 *     from them, so a lock released (or re-pointed at the claimant) between
 *     the gate and the write must not let the approval through.
 *
 * Every Task write that sets `status` also bumps `statusVersion` (spread
 * `STATUS_VERSION_BUMP` into its `data`, or write through
 * `casUpdateTaskStatus`, which does it). A status write that skipped the bump
 * would reopen the round-trip window for the leg it performs. The writers
 * outside the request handlers bump it too: the GitHub webhook handlers, the
 * Grounding completion write and the Grounding webhook observation adapter.
 *
 * A write that follows an irreversible step (the PR merge on GitHub) cannot
 * simply answer 409 when it loses: `casUpdateTaskStatusAfterMerge` handles the
 * one loss that is expected there, the PR-merge webhook of the system itself
 * moving the task to the same terminal status first.
 */
import { Prisma } from "@prisma/client";

/** Spread into the `data` of every Task write that sets `status`. */
export const STATUS_VERSION_BUMP = {
  statusVersion: { increment: 1 },
} as const;

/** The task columns a status write's validation depends on. */
export interface TaskStatusCasSnapshot {
  id: string;
  status: string;
  statusVersion: number;
  claimedByUserId: string | null;
  claimedByAgentId: string | null;
  reviewClaimedByUserId: string | null;
  reviewClaimedByAgentId: string | null;
}

/** The WHERE of the compare-and-swap: the row must still look as it was read. */
export function taskStatusCasWhere(task: TaskStatusCasSnapshot): Prisma.TaskWhereInput {
  return {
    id: task.id,
    status: task.status,
    statusVersion: task.statusVersion,
    claimedByUserId: task.claimedByUserId,
    claimedByAgentId: task.claimedByAgentId,
    reviewClaimedByUserId: task.reviewClaimedByUserId,
    reviewClaimedByAgentId: task.reviewClaimedByAgentId,
  };
}

/**
 * Writes `data` (which sets `status`) only while the row still matches the
 * snapshot the caller validated against, bumping `statusVersion`. Returns the
 * fresh row, or `null` when another writer got there first (nothing was
 * written; the caller answers 409).
 */
export async function casUpdateTaskStatus<I extends Prisma.TaskInclude>(
  db: Pick<Prisma.TransactionClient, "task">,
  snapshot: TaskStatusCasSnapshot,
  data: Prisma.TaskUncheckedUpdateManyInput,
  include: I,
): Promise<Prisma.TaskGetPayload<{ include: I }> | null> {
  const written = await db.task.updateMany({
    where: taskStatusCasWhere(snapshot),
    data: { ...data, ...STATUS_VERSION_BUMP },
  });
  if (written.count === 0) return null;
  // updateMany cannot use `include`, so re-fetch the freshly written row.
  return (await db.task.findUnique({
    where: { id: snapshot.id },
    include,
  })) as Prisma.TaskGetPayload<{ include: I }> | null;
}

/** The outcome of a status write that follows an irreversible merge. */
export type MergedStatusWrite<T> =
  | { kind: "written"; task: T; webhookFirst: boolean }
  | { kind: "lost"; currentStatus: string | null };

/**
 * `casUpdateTaskStatus` for a write that runs AFTER the PR was merged on
 * GitHub. The merge cannot be undone, so a lost compare-and-swap is not
 * simply "reload and retry":
 *
 *   - The system's own PR-merge webhook (`pull_request` closed + merged) can
 *     move the task to the terminal status between the merge and this write.
 *     When the fresh row is already in the status this write targets, the
 *     write is completed against the fresh row (claims cleared, merge sha and
 *     result stored) and reported as `written` with `webhookFirst: true`, so
 *     the caller answers the normal success.
 *   - Any other change (the task moved elsewhere, or the retry loses again)
 *     is `lost`: nothing was written and the caller answers a distinct 409
 *     that tells the operator the PR is merged, with the merge sha recorded.
 */
export async function casUpdateTaskStatusAfterMerge<I extends Prisma.TaskInclude>(
  db: Pick<Prisma.TransactionClient, "task">,
  snapshot: TaskStatusCasSnapshot,
  data: Prisma.TaskUncheckedUpdateManyInput,
  targetStatus: string,
  include: I,
): Promise<MergedStatusWrite<Prisma.TaskGetPayload<{ include: I }>>> {
  const written = await casUpdateTaskStatus(db, snapshot, data, include);
  if (written) return { kind: "written", task: written, webhookFirst: false };

  const current = await db.task.findUnique({ where: { id: snapshot.id } });
  if (!current) return { kind: "lost", currentStatus: null };
  if (current.status !== targetStatus) return { kind: "lost", currentStatus: current.status };

  const retried = await casUpdateTaskStatus(db, current, data, include);
  if (retried) return { kind: "written", task: retried, webhookFirst: true };
  return { kind: "lost", currentStatus: current.status };
}
