import type { Prisma } from "@prisma/client";
import { GroundingAccessError, unavailable } from "./grounding-context.js";

export async function groundingTaskHeld(db: Prisma.TransactionClient, taskId: string, projectId: string): Promise<boolean> {
  const state = await db.groundingMigrationState.findUnique({ where: { taskId } });
  if (state && (state.projectId !== projectId || !Number.isSafeInteger(state.revision) || state.revision < 1)) unavailable();
  return state?.held ?? false;
}

/** Check before cohort parsing and before any fallback to unprovisioned behavior. */
export async function assertGroundingNotHeld(db: Prisma.TransactionClient, taskId: string, projectId: string): Promise<void> {
  if (await groundingTaskHeld(db, taskId, projectId)) throw new GroundingAccessError("grounding_task_held", 409);
}
