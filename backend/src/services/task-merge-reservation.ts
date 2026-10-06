/**
 * Persisted, leased merge reservation (agent-tasks eb08742f).
 *
 * The paths that merge a PR on GitHub (`POST /tasks/:id/merge`, the autoMerge
 * forms of `POST /tasks/:id/finish`, `POST /github/pull-requests/:n/merge`)
 * read the task, evaluate the distinct-reviewer / self-merge gates against the
 * claims they read, call the GitHub merge (irreversible) and only then write.
 * A review lock released, or a claim moved, between the gate and the merge
 * used to let the merge land anyway; the compare-and-swap of the post-merge
 * write can only report that afterwards (`merged_but_status_changed`).
 *
 * The reservation closes that window. Before the merge call the handler takes
 * it with ONE conditional write bound to the status, the status version and
 * the claim columns the gates decided from (`reserveTaskForMerge` in
 * task-status-cas.ts). While it is
 * live every claim and status writer refuses with `409 merge_in_progress`,
 * enforced in the WHERE of the writer's own conditional write
 * (`noLiveMergeReservation`), so the check is atomic with the write and not a
 * read followed by a write.
 *
 * Release: the post-merge status write clears the columns in the same write
 * that records the result (`MERGE_RESERVATION_CLEAR`), and the handler exit
 * releases whatever it still holds (`releaseMergeReservation`), which covers a
 * failed or refused merge and a lost post-merge write.
 *
 * Lease: `mergeReservedAt` is the lease start. A reservation older than
 * `MERGE_RESERVATION_TTL_MS` is treated as absent by every reader and writer
 * (lazy expiry, no sweeper), so a handler that dies between the reserve and
 * the release cannot lock the task for good. The TTL is 120 s: a GitHub merge
 * API call answers in seconds, so the lease has a wide margin over a normal
 * merge, while a crashed handler locks claim writers out for two minutes at
 * most. A merge that outlives the lease loses the protection for the rest of
 * its call and falls back to the compare-and-swap of the post-merge write
 * (`merged_but_status_changed`), the behavior before the reservation existed.
 *
 * Not covered, on purpose: the system's own GitHub webhook writers (they
 * record a fact that already happened on GitHub and must land; their race with
 * a merge is the `merge_webhook_first` path of the post-merge write) and
 * writers that touch neither a claim nor the status.
 */
import type { Prisma } from "@prisma/client";

/** Lease length of a merge reservation, in milliseconds. */
export const MERGE_RESERVATION_TTL_MS = 120_000;

/** Spread into the `data` of the write that releases a reservation. */
export const MERGE_RESERVATION_CLEAR = {
  mergeReservedByUserId: null,
  mergeReservedByAgentId: null,
  mergeReservedAt: null,
} as const;

/** The columns of a merge reservation as stored on the task. */
export interface MergeReservation {
  at: Date;
  byUserId: string | null;
  byAgentId: string | null;
}

/** The reservation columns of a task row. */
export interface MergeReservationColumns {
  mergeReservedAt: Date | null;
}

/** Reservations whose lease started at or before this instant have lapsed. */
export function mergeReservationLeaseCutoff(now: Date): Date {
  return new Date(now.getTime() - MERGE_RESERVATION_TTL_MS);
}

/**
 * WHERE fragment: the task has no LIVE merge reservation (none, or one whose
 * lease has lapsed). Spread into the WHERE of every claim or status write so
 * the write matches no row while a merge holds the task. Uses `AND` so it
 * cannot collide with an `OR` another condition of the same WHERE carries.
 */
export function noLiveMergeReservation(now: Date = new Date()): Prisma.TaskWhereInput {
  return {
    AND: [{ OR: [{ mergeReservedAt: null }, { mergeReservedAt: { lte: mergeReservationLeaseCutoff(now) } }] }],
  };
}

/**
 * WHERE fragment for the post-merge write of the handler that holds
 * `reservation`: it may write while no reservation is live or while the live
 * one is its own. After an irreversible merge the write must not fail only
 * because the handler's own reservation is still set.
 */
export function mergeReservationAllows(
  reservation: MergeReservation | null | undefined,
  now: Date = new Date(),
): Prisma.TaskWhereInput {
  if (!reservation) return noLiveMergeReservation(now);
  return {
    AND: [
      {
        OR: [
          { mergeReservedAt: null },
          { mergeReservedAt: { lte: mergeReservationLeaseCutoff(now) } },
          {
            mergeReservedAt: reservation.at,
            mergeReservedByUserId: reservation.byUserId,
            mergeReservedByAgentId: reservation.byAgentId,
          },
        ],
      },
    ],
  };
}

/** True while `task` carries a merge reservation whose lease has not lapsed. */
export function isMergeReservationLive(
  task: MergeReservationColumns,
  now: Date = new Date(),
): boolean {
  return task.mergeReservedAt !== null && task.mergeReservedAt.getTime() > mergeReservationLeaseCutoff(now).getTime();
}

/** Whole seconds until the lease of `task`'s reservation lapses (at least 1). */
export function mergeReservationRetryAfterSeconds(
  task: { mergeReservedAt: Date },
  now: Date = new Date(),
): number {
  const remainingMs = task.mergeReservedAt.getTime() + MERGE_RESERVATION_TTL_MS - now.getTime();
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

/**
 * Releases `reservation` if the task still carries exactly that one (the
 * holder and the lease start are the token). A reservation that lapsed and was
 * taken by another merge meanwhile is left alone, and so is a row whose
 * post-merge write already cleared it. Raw SQL for the same reason as
 * `reserveTaskForMerge`: releasing is bookkeeping and must not bump
 * `updatedAt`. Returns the number of rows released (0 or 1).
 */
export async function releaseMergeReservation(
  db: Pick<Prisma.TransactionClient, "$executeRaw">,
  taskId: string,
  reservation: MergeReservation,
): Promise<number> {
  return db.$executeRaw`
    UPDATE "tasks"
    SET "mergeReservedByUserId" = NULL, "mergeReservedByAgentId" = NULL, "mergeReservedAt" = NULL
    WHERE "id" = ${taskId}
      AND "mergeReservedAt" = ${reservation.at}
      AND "mergeReservedByUserId" IS NOT DISTINCT FROM ${reservation.byUserId}
      AND "mergeReservedByAgentId" IS NOT DISTINCT FROM ${reservation.byAgentId}`;
}
