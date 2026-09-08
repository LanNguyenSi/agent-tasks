import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { GroundingAccessError, mismatch, unavailable, type GroundingTask } from "./grounding-context.js";
import { GroundingReceiptVerificationError } from "./grounding-receipt.js";

export class GroundingDecisionError extends GroundingAccessError {
  constructor(readonly code: "grounding_finalization_pending" | "grounding_operation_conflict" | "precondition_failed") { super(code, 409); }
}
export async function groundingTransaction<T>(client: PrismaClient, run: (db: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let retry = 0; retry < 3; retry++) {
    try { return await client.$transaction(run, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10000, timeout: 20000 }); }
    catch (error) {
      if (error instanceof GroundingAccessError || error instanceof GroundingReceiptVerificationError || error instanceof GroundingDecisionError) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && retry < 2 &&
          (error.code === "P2034" || (error.code === "P2010" && ["40001", "40P01"].includes(String(error.meta?.code))))) continue;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") mismatch();
      unavailable();
    }
  }
  return unavailable();
}

/** Participating writers lock every parent first, then tasks in stable order. */
export async function lockGroundingProjects(db: Prisma.TransactionClient, projectIds: readonly string[]) {
  for (const id of [...new Set(projectIds)].sort()) {
    if (!z.string().uuid().safeParse(id).success) throw new GroundingAccessError("not_found", 404);
    const rows = await db.$queryRaw<{ id: string }[]>`SELECT id FROM projects WHERE id = ${id} FOR UPDATE`;
    if (!rows.length) throw new GroundingAccessError("not_found", 404);
  }
}
export async function lockGroundingTask(db: Prisma.TransactionClient, taskId: string): Promise<GroundingTask> {
  if (!z.string().uuid().safeParse(taskId).success) throw new GroundingAccessError("not_found", 404);
  const before = await db.task.findUnique({ where: { id: taskId }, include: { project: true } });
  if (!before) throw new GroundingAccessError("not_found", 404);
  await lockGroundingProjects(db, [before.projectId]);
  return lockGroundingTaskUnderProject(db, taskId, [before.projectId]);
}
export async function lockGroundingTaskUnderProject(db: Prisma.TransactionClient, taskId: string, projectIds: readonly string[]): Promise<GroundingTask> {
  await db.$queryRaw`SELECT id FROM tasks WHERE id = ${taskId} FOR UPDATE`;
  const task = await db.task.findUnique({ where: { id: taskId }, include: { project: true } });
  if (!task || !projectIds.includes(task.projectId)) mismatch();
  await db.$queryRaw`SELECT "taskId" FROM grounding_bindings WHERE "taskId" = ${taskId} FOR UPDATE`;
  await db.$queryRaw`SELECT "taskId" FROM grounding_cohorts WHERE "taskId" = ${taskId} FOR UPDATE`;
  return task;
}
export async function assertNoGroundingReservation(db: Prisma.TransactionClient, taskId: string) {
  const cohort = await db.groundingCohort.findUnique({ where: { taskId } });
  if (cohort?.reservationId) throw new GroundingDecisionError("grounding_finalization_pending");
}
export async function invalidateGroundingContext(db: Prisma.TransactionClient, taskId: string) {
  await db.groundingAttempt.updateMany({ where: { taskId, state: "ACTIVE" }, data: { state: "SUPERSEDED" } });
  await db.groundingBinding.updateMany({ where: { taskId }, data: { activeAttemptId: null, contextDigest: null, contextRevision: { increment: 1 } } });
}
