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
 * Every write here also refuses while another handler holds a live merge
 * reservation on the task (`mergeReservationAllows`, see
 * task-merge-reservation.ts): the claims the gates decided from must not move
 * between the gate and the GitHub merge. The handler that holds the
 * reservation passes it to the post-merge write, which clears it.
 *
 * A write that follows an irreversible step (the PR merge on GitHub) cannot
 * simply answer 409 when it loses: `casUpdateTaskStatusAfterMerge` handles the
 * one loss that is expected there, the PR-merge webhook of the system itself
 * moving the task to the same terminal status first.
 */
import { Prisma } from "@prisma/client";
import type { Actor } from "../types/auth.js";
import {
  MERGE_RESERVATION_CLEAR,
  andWhere,
  utcTimestampSql,
  isMergeReservationLive,
  mergeReservationAllows,
  mergeReservationLeaseCutoff,
  mergeReservationRetryAfterSeconds,
  type MergeReservation,
} from "./task-merge-reservation.js";

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

/**
 * The WHERE of the compare-and-swap: the row must still look as it was read
 * and carry no live merge reservation other than `reservation` (the caller's
 * own, for the post-merge write). An `AND` in `extra` is kept.
 */
export function taskStatusCasWhere(
  task: TaskStatusCasSnapshot,
  extra?: Prisma.TaskWhereInput,
  reservation?: MergeReservation | null,
): Prisma.TaskWhereInput {
  return andWhere(
    {
      ...extra,
      id: task.id,
      status: task.status,
      statusVersion: task.statusVersion,
      claimedByUserId: task.claimedByUserId,
      claimedByAgentId: task.claimedByAgentId,
      reviewClaimedByUserId: task.reviewClaimedByUserId,
      reviewClaimedByAgentId: task.reviewClaimedByAgentId,
    },
    mergeReservationAllows(reservation),
  );
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
  reservation?: MergeReservation | null,
): Promise<Prisma.TaskGetPayload<{ include: I }> | null> {
  const written = await db.task.updateMany({
    where: taskStatusCasWhere(snapshot, extraWhere, reservation),
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
 *   - `merge_in_progress`: the status and its version are as they were read
 *     and ANOTHER handler holds a live merge reservation (this handler's own
 *     lease had lapsed); the same request sent again passes once that merge
 *     has finished.
 */
export type MergedLossReason = "status_changed" | "claim_moved" | "merge_in_progress";

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

type LossRow = TaskStatusCasSnapshot & {
  mergeReservedAt?: Date | null;
  mergeReservedByUserId?: string | null;
  mergeReservedByAgentId?: string | null;
};

function lossReason(
  snapshot: TaskStatusCasSnapshot,
  row: LossRow | null,
  reservation?: MergeReservation | null,
): MergedLossReason {
  if (row && row.status === snapshot.status && row.statusVersion === snapshot.statusVersion) {
    const live = row.mergeReservedAt != null && isMergeReservationLive({ mergeReservedAt: row.mergeReservedAt });
    const own =
      reservation != null &&
      row.mergeReservedAt?.getTime() === reservation.at.getTime() &&
      (row.mergeReservedByUserId ?? null) === reservation.byUserId &&
      (row.mergeReservedByAgentId ?? null) === reservation.byAgentId;
    return live && !own ? "merge_in_progress" : "claim_moved";
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
  reservation?: MergeReservation | null,
): Promise<MergedStatusWrite<Prisma.TaskGetPayload<{ include: I }>>> {
  // The write that records the merge also releases the handler's reservation,
  // so the task never shows a finished merge together with a live reservation.
  data = { ...data, ...MERGE_RESERVATION_CLEAR };
  const written = await casUpdateTaskStatus(db, snapshot, data, include, undefined, reservation);
  if (written) return { kind: "written", task: written, webhookFirst: false };

  const current = await db.task.findUnique({ where: { id: snapshot.id } });
  if (!current) return { kind: "lost", currentStatus: null, reason: "status_changed" };
  if (current.status !== targetStatus) {
    return { kind: "lost", currentStatus: current.status, reason: lossReason(snapshot, current, reservation) };
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
    reservation,
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
      retried = await casUpdateTaskStatus(db, latest, withoutResult, include, undefined, reservation);
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
  return { kind: "lost", currentStatus: latest.status, reason: lossReason(snapshot, latest, reservation) };
}

export type ReserveOutcome =
  | { ok: true; reservation: MergeReservation }
  | { ok: false; reason: "merge_in_progress"; retryAfterSeconds: number }
  | { ok: false; reason: "changed" };

/**
 * Takes the merge reservation (see task-merge-reservation.ts) with one
 * conditional write: it lands only while the row still has the status, status
 * version, work claim and review lock the caller's gates decided from (the
 * columns of `taskStatusCasWhere`) AND no other reservation is live, so two
 * merges of one task cannot both reserve it. A write that matches no row is
 * classified with a second read: another live reservation is
 * `merge_in_progress`, anything else means the row changed after the caller's
 * read.
 *
 * Raw SQL on purpose: the reservation columns are operational bookkeeping,
 * not a change of the task, so the write must not bump `updatedAt` (a merge
 * that GitHub refuses leaves the row exactly as it was, and a reader that
 * syncs by `updatedAt` is not woken by a reserve/release round trip). Prisma's
 * `@updatedAt` cannot be switched off for one write.
 */
export async function reserveTaskForMerge(
  db: Pick<Prisma.TransactionClient, "task" | "$executeRaw">,
  snapshot: TaskStatusCasSnapshot,
  actor: Actor,
  now: Date = new Date(),
): Promise<ReserveOutcome> {
  const reservation: MergeReservation = {
    at: now,
    byUserId: actor.type === "human" ? actor.userId : null,
    byAgentId: actor.type === "agent" ? actor.tokenId : null,
  };
  const written = await db.$executeRaw`
    UPDATE "tasks"
    SET "mergeReservedByUserId" = ${reservation.byUserId},
        "mergeReservedByAgentId" = ${reservation.byAgentId},
        "mergeReservedAt" = ${utcTimestampSql(reservation.at)}
    WHERE "id" = ${snapshot.id}
      AND "status" = ${snapshot.status}
      AND "statusVersion" = ${snapshot.statusVersion}
      AND "claimedByUserId" IS NOT DISTINCT FROM ${snapshot.claimedByUserId}
      AND "claimedByAgentId" IS NOT DISTINCT FROM ${snapshot.claimedByAgentId}
      AND "reviewClaimedByUserId" IS NOT DISTINCT FROM ${snapshot.reviewClaimedByUserId}
      AND "reviewClaimedByAgentId" IS NOT DISTINCT FROM ${snapshot.reviewClaimedByAgentId}
      AND ("mergeReservedAt" IS NULL OR "mergeReservedAt" <= ${utcTimestampSql(mergeReservationLeaseCutoff(now))})`;
  if (written === 1) return { ok: true, reservation };

  const current = await db.task.findUnique({
    where: { id: snapshot.id },
    select: { mergeReservedAt: true },
  });
  if (current?.mergeReservedAt && isMergeReservationLive(current, now)) {
    return {
      ok: false,
      reason: "merge_in_progress",
      retryAfterSeconds: mergeReservationRetryAfterSeconds({ mergeReservedAt: current.mergeReservedAt }, now),
    };
  }
  return { ok: false, reason: "changed" };
}
