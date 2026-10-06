/**
 * Status write that runs AFTER a PR was merged on GitHub, shared by every
 * handler that merges and then records the result on the task (`/merge`, the
 * autoMerge forms of `/finish`, `POST /github/pull-requests/:n/merge`).
 *
 * The write is a compare-and-swap (`casUpdateTaskStatusAfterMerge`). A lost
 * race after an irreversible merge is reported the same way everywhere: the
 * system's own PR-merge webhook (or another writer) having already moved the
 * task to the target status completes the write against the fresh row and
 * leaves a `task.merge_webhook_first` audit event; any other change writes
 * nothing, leaves a `task.merged_status_conflict` audit event carrying the
 * merge sha, and returns the `merged_but_status_changed` body for a 409.
 */
import type { Prisma } from "@prisma/client";
import { logAuditEvent } from "./audit.js";
import {
  casUpdateTaskStatusAfterMerge,
  type TaskStatusCasSnapshot,
} from "./task-status-cas.js";
import type { MergeReservation } from "./task-merge-reservation.js";
import type { Actor } from "../types/auth.js";

export interface MergedButStatusChangedBody {
  error: "merged_but_status_changed";
  message: string;
  mergeSha: string | null;
  currentStatus: string | null;
}

export async function writeStatusAfterMerge<I extends Prisma.TaskInclude>(
  db: Pick<Prisma.TransactionClient, "task">,
  actor: Actor,
  task: TaskStatusCasSnapshot & { projectId: string },
  data: Prisma.TaskUncheckedUpdateManyInput,
  targetStatus: string,
  include: I,
  merge: { sha: string | null; via: string },
  reservation?: MergeReservation | null,
): Promise<
  | { ok: true; task: Prisma.TaskGetPayload<{ include: I }>; resultKept: boolean }
  | { ok: false; body: MergedButStatusChangedBody }
> {
  const outcome = await casUpdateTaskStatusAfterMerge(db, task, data, targetStatus, include, reservation);
  const actorId = actor.type === "human" ? actor.userId : undefined;
  if (outcome.kind === "written") {
    if (outcome.webhookFirst) {
      void logAuditEvent({
        action: "task.merge_webhook_first",
        actorId,
        projectId: task.projectId,
        taskId: task.id,
        payload: {
          via: merge.via,
          mergeSha: merge.sha,
          status: targetStatus,
          actorType: actor.type,
          // The state the retry completed against: the other writer's status
          // and version, and whether its stored result was kept.
          priorStatus: outcome.prior?.status ?? null,
          priorStatusVersion: outcome.prior?.statusVersion ?? null,
          resultKept: outcome.prior?.resultKept ?? false,
        },
      });
    }
    return { ok: true, task: outcome.task, resultKept: outcome.prior?.resultKept ?? false };
  }
  void logAuditEvent({
    action: "task.merged_status_conflict",
    actorId,
    projectId: task.projectId,
    taskId: task.id,
    payload: {
      via: merge.via,
      mergeSha: merge.sha,
      expectedFrom: task.status,
      targetStatus,
      currentStatus: outcome.currentStatus,
      reason: outcome.reason,
      actorType: actor.type,
    },
  });
  const mergedPrefix = `The pull request was merged${merge.sha ? ` (${merge.sha})` : ""}`;
  const message =
    outcome.reason === "merge_in_progress"
      ? `${mergedPrefix}, but another merge holds the task right now, so this request could not record it; the ` +
        `status is still '${outcome.currentStatus ?? "unknown"}'. The task was not updated. Retrying the same request is safe.`
      : outcome.reason === "claim_moved"
      ? `${mergedPrefix}, but a claim on the task moved before this request could record it; the status ` +
        `is still '${outcome.currentStatus ?? "unknown"}'. The task was not updated. Retrying the same request is safe.`
      : `${mergedPrefix}, but the task status changed to '${outcome.currentStatus ?? "unknown"}' before this ` +
        "request could record it. The task was not updated; reconcile it by hand.";
  return {
    ok: false,
    body: {
      error: "merged_but_status_changed",
      message,
      mergeSha: merge.sha,
      currentStatus: outcome.currentStatus,
    },
  };
}
