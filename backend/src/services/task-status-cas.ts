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
export function taskStatusCasWhere(
  task: TaskStatusCasSnapshot,
  extra?: Prisma.TaskWhereInput,
): Prisma.TaskWhereInput {
  return {
    ...extra,
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
 * The status half of the compare-and-swap, for the writers that already carry
 * their own claim guard in the WHERE (a claim taken only while the row is
 * unclaimed, a release only for the claim holder): the write also lands only
 * while the row still has the status and status version the handler read, so
 * a status change (or a round trip back to the same status) between the read
 * and the write matches no row. Spread it into the `where` next to the
 * writer's own claim conditions.
 */
export function taskStatusVersionWhere(
  task: Pick<TaskStatusCasSnapshot, "status" | "statusVersion">,
): Prisma.TaskWhereInput {
  return { status: task.status, statusVersion: task.statusVersion };
}

/**
 * Writes `data` (which sets `status`) only while the row still matches the
 * snapshot the caller validated against, bumping `statusVersion`. Returns the
 * fresh row, or `null` when another writer got there first (nothing was
 * written; the caller answers 409). `extraWhere` adds a condition the write
 * must also satisfy (for example `{ result: null }`).
 */
export async function casUpdateTaskStatus<I extends Prisma.TaskInclude>(
  db: Pick<Prisma.TransactionClient, "task">,
  snapshot: TaskStatusCasSnapshot,
  data: Prisma.TaskUncheckedUpdateManyInput,
  include: I,
  extraWhere?: Prisma.TaskWhereInput,
): Promise<Prisma.TaskGetPayload<{ include: I }> | null> {
  const written = await db.task.updateMany({
    where: taskStatusCasWhere(snapshot, extraWhere),
    data: { ...data, ...STATUS_VERSION_BUMP },
  });
  if (written.count === 0) return null;
  // updateMany cannot use `include`, so re-fetch the freshly written row.
  return (await db.task.findUnique({
    where: { id: snapshot.id },
    include,
  })) as Prisma.TaskGetPayload<{ include: I }> | null;
}

/**
 * Why a post-merge write lost, so the caller can word the 409 truthfully:
 *
 *   - `status_changed`: the row is in another status (or went through a status
 *     round trip, which the status version shows), so the transition this
 *     request validated no longer applies.
 *   - `claim_moved`: the status and its version are as they were read and only
 *     a work claim or review lock moved; the same request sent again passes
 *     the compare-and-swap.
 */
export type MergedLossReason = "status_changed" | "claim_moved";

/** The outcome of a status write that follows an irreversible merge. */
export type MergedStatusWrite<T> =
  | {
      kind: "written";
      task: T;
      webhookFirst: boolean;
      /**
       * Set with `webhookFirst`: the status and status version of the row the
       * retry completed against (the state another writer left), and whether
       * that row already carried a result, which the retry then kept.
       */
      prior?: { status: string; statusVersion: number; resultKept: boolean };
    }
  | { kind: "lost"; currentStatus: string | null; reason: MergedLossReason };

function lossReason(
  snapshot: TaskStatusCasSnapshot,
  row: TaskStatusCasSnapshot | null,
): MergedLossReason {
  if (row && row.status === snapshot.status && row.statusVersion === snapshot.statusVersion) {
    return "claim_moved";
  }
  return "status_changed";
}

/**
 * `casUpdateTaskStatus` for a write that runs AFTER the PR was merged on
 * GitHub. The merge cannot be undone, so a lost compare-and-swap is not
 * simply "reload and retry":
 *
 *   - Another writer can move the task to the terminal status between the
 *     merge and this write: typically the system's own PR-merge webhook
 *     (`pull_request` closed + merged), but a concurrent approval or admin
 *     write qualifies as well. When the fresh
 *     row is already in the status this write targets, the write is completed
 *     against the fresh row (claims cleared, merge sha stored) and reported as
 *     `written` with `webhookFirst: true`, so the caller answers the normal
 *     success. A `result` the other writer already stored is kept: the retry
 *     writes `result` only while the fresh row has none.
 *   - Any other change (the task moved elsewhere, or the retry loses again)
 *     is `lost`: nothing was written and the caller answers a distinct 409
 *     that tells the operator the PR is merged, with the merge sha recorded.
 *     The loss reports the status the row has after the last failed write, so
 *     the row is read again once the retry has lost.
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
  if (!current) return { kind: "lost", currentStatus: null, reason: "status_changed" };
  if (current.status !== targetStatus) {
    return { kind: "lost", currentStatus: current.status, reason: lossReason(snapshot, current) };
  }

  const resultKept = current.result !== null && current.result !== undefined;
  const retryData: Prisma.TaskUncheckedUpdateManyInput = { ...data };
  if (resultKept) delete retryData.result;
  // Writing `result` is conditional on it still being null: a result stored
  // between the fresh-row read and this write must not be overwritten.
  const writesResult = !resultKept && retryData.result !== undefined;
  let retried = await casUpdateTaskStatus(
    db,
    current,
    retryData,
    include,
    writesResult ? { result: null } : undefined,
  );
  let kept = resultKept;
  let prior = current;
  // The freshest read of the row once the retry has lost.
  let latest: typeof current | null | undefined;
  if (!retried && writesResult) {
    // The guard may be what missed: re-read once and retry without `result`
    // if another writer stored one meanwhile.
    latest = await db.task.findUnique({ where: { id: snapshot.id } });
    if (latest && latest.status === targetStatus && latest.result !== null && latest.result !== undefined) {
      const withoutResult = { ...retryData };
      delete withoutResult.result;
      retried = await casUpdateTaskStatus(db, latest, withoutResult, include);
      kept = true;
      prior = latest;
      latest = undefined;
    }
  }
  if (retried) {
    return {
      kind: "written",
      task: retried,
      webhookFirst: true,
      prior: { status: prior.status, statusVersion: prior.statusVersion, resultKept: kept },
    };
  }
  // The retry lost too: `current` is stale (the row moved again after it was
  // read), so read it again before reporting a status.
  if (latest === undefined) latest = await db.task.findUnique({ where: { id: snapshot.id } });
  if (!latest) return { kind: "lost", currentStatus: null, reason: "status_changed" };
  return { kind: "lost", currentStatus: latest.status, reason: lossReason(snapshot, latest) };
}
