/**
 * The deletion core shared by `DELETE /projects/:id` and the team sync prune.
 *
 * A project may only be removed while it carries no grounding history: the
 * cohort, binding and operation rows of its tasks are immutable evidence, and
 * a task with a reserved or dispatched operation is mid-finalization. Both
 * callers therefore go through one grounding transaction per project that
 * locks the project and its tasks, checks the reservation first and the
 * retention second, and only then deletes.
 *
 * Authorization is not decided here: the route passes an `admit` hook that
 * throws a `GroundingAccessError` for a caller who may not delete, the prune
 * passes one that re-checks the project is still stale.
 */
import { unlink } from "node:fs/promises";
import { Prisma, type PrismaClient, type Project } from "@prisma/client";
import { storedFilePath } from "./attachment-files.js";
import { GroundingAccessError } from "./grounding-context.js";
import { isGithubFenceConflict } from "./grounding-github-fence.js";
import {
  assertNoGroundingReservation,
  GroundingDecisionError,
  groundingTransaction,
  lockGroundingProjects,
  lockGroundingTaskUnderProject,
} from "./grounding-transaction.js";

export type ProjectDeletionRefusal =
  /** No project with that id (also a malformed id). */
  | "not_found"
  /** A task of the project has grounding history that must stay (found by the check or refused by a Restrict foreign key). */
  | "retained"
  /** A task of the project has a grounding operation that is still being finalized. */
  | "reservation_pending"
  /** The `admit` hook declined: the project no longer qualifies. Nothing was written. */
  | "not_eligible"
  /** An active repository fence refused the delete. Nothing was written. */
  | "fenced";

export type ProjectDeletionResult =
  | { ok: true; attachmentUrls: string[] }
  | { ok: false; reason: ProjectDeletionRefusal };

export interface ProjectDeletionOptions {
  /**
   * Runs inside the transaction after the project row is locked and loaded and
   * before any task is locked. Throw to refuse the whole request (the error
   * leaves `deleteProjectWithSafeguards` unchanged); return false to leave the
   * project alone.
   */
  admit?: (db: Prisma.TransactionClient, project: Project) => Promise<boolean>;
}

/** Carries a foreign-key restriction refusal out of the grounding transaction. */
class ProjectDeletionRetainedError extends GroundingAccessError {
  constructor() {
    super("bad_state", 409);
  }
}

/**
 * True when the database refused a delete because a row with `onDelete:
 * Restrict` still points at the project's tasks (Prisma `P2003`, or the raw
 * Postgres foreign-key violation `23503` when it arrives wrapped in `P2010`).
 */
function isForeignKeyRestriction(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return error.code === "P2003" || (error.code === "P2010" && String(error.meta?.code) === "23503");
}

/** Carries a repository-fence refusal out of the grounding transaction. */
class ProjectDeletionFenceError extends GroundingAccessError {
  constructor() {
    super("merge_in_progress", 409);
  }
}

/**
 * Deletes one project with its tasks, comments and artifacts in a grounding
 * transaction. The returned attachment urls name files that stay on disk until
 * the caller reclaims them with `removeStoredAttachments` after the commit.
 */
export async function deleteProjectWithSafeguards(
  client: PrismaClient,
  projectId: string,
  options: ProjectDeletionOptions = {},
): Promise<ProjectDeletionResult> {
  try {
    return await groundingTransaction<ProjectDeletionResult>(client, async (db) => {
      await lockGroundingProjects(db, [projectId]);
      const project = await db.project.findUnique({ where: { id: projectId } });
      if (!project) return { ok: false, reason: "not_found" };
      if (options.admit && !(await options.admit(db, project))) return { ok: false, reason: "not_eligible" };
      const taskIds = (await db.task.findMany({ where: { projectId }, select: { id: true } }))
        .map((task) => task.id)
        .sort();
      for (const taskId of taskIds) await lockGroundingTaskUnderProject(db, taskId, [projectId]);
      // Reservation denial deliberately precedes immutable-history denial.
      try {
        for (const taskId of taskIds) await assertNoGroundingReservation(db, taskId);
      } catch (error) {
        if (error instanceof GroundingDecisionError && error.code === "grounding_finalization_pending") {
          return { ok: false, reason: "reservation_pending" };
        }
        throw error;
      }
      const retained = await Promise.all(
        taskIds.map(
          async (taskId) =>
            (await db.groundingCohort.findUnique({ where: { taskId } })) ||
            (await db.groundingBinding.findUnique({ where: { taskId } })) ||
            (await db.groundingOperation.findFirst({ where: { taskId } })),
        ),
      );
      if (retained.some(Boolean)) return { ok: false, reason: "retained" };
      const attachments = await db.taskAttachment.findMany({
        where: { task: { projectId } },
        select: { url: true },
      });
      try {
        await db.project.delete({ where: { id: projectId } });
      } catch (error) {
        if (isGithubFenceConflict(error)) throw new ProjectDeletionFenceError();
        // Other history the explicit check above does not list (GitHub
        // observations, migration state and commands, merge groups) is kept
        // by Restrict foreign keys; the delete is refused, nothing is removed.
        if (isForeignKeyRestriction(error)) throw new ProjectDeletionRetainedError();
        throw error;
      }
      return { ok: true, attachmentUrls: attachments.map((attachment) => attachment.url) };
    });
  } catch (error) {
    if (error instanceof ProjectDeletionFenceError) return { ok: false, reason: "fenced" };
    if (error instanceof ProjectDeletionRetainedError) return { ok: false, reason: "retained" };
    if (error instanceof GroundingAccessError && error.code === "not_found") {
      return { ok: false, reason: "not_found" };
    }
    throw error;
  }
}

/** Reclaims disk only after the database transaction that removed the rows committed. */
export async function removeStoredAttachments(attachmentUrls: readonly string[]): Promise<void> {
  for (const url of attachmentUrls) {
    const abs = storedFilePath(url);
    if (abs) await unlink(abs).catch(() => {});
  }
}
