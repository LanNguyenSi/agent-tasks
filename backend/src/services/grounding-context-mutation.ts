import { z } from "zod";
import type { Actor } from "../types/auth.js";
import { logGroundingContextMutation } from "./audit.js";
import { groundingActorId } from "./grounding-operations.js";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { GroundingTask } from "./grounding-context.js";
import { mismatch } from "./grounding-context.js";
import { groundingTransaction, lockGroundingProjects, lockGroundingTaskUnderProject, assertNoGroundingReservation, invalidateGroundingContext } from "./grounding-transaction.js";

/**
 * Trusted server code only. Scope selection and action-specific authorization run
 * in the transaction after all parent locks. Callbacks must use the supplied db,
 * mutate only their selected scope, and perform no remote effects. Enrollment and
 * task reassignment must join the same parent-before-task protocol.
 */
export async function mutateGroundingContext<T>(client: PrismaClient, input: {
  projectIds: readonly string[];
  audit: { actor: Actor; reason: string };
  selectAndAuthorize: (db: Prisma.TransactionClient) => Promise<readonly string[]>;
  mutate: (db: Prisma.TransactionClient, tasks: readonly GroundingTask[]) => Promise<T>;
  /** A CAS/no-op result must commit without superseding an active attempt. */
  didMutate?: (result: T) => boolean;
}): Promise<T> {
  return groundingTransaction(client, async db => {
    if (!input.projectIds.length || !z.string().trim().min(1).max(2000).safeParse(input.audit.reason).success) mismatch();
    await lockGroundingProjects(db, input.projectIds);
    const ids = [...new Set(await input.selectAndAuthorize(db))].sort();
    const tasks: GroundingTask[] = [];
    for (const id of ids) tasks.push(await lockGroundingTaskUnderProject(db, id, input.projectIds));
    for (const task of tasks) await assertNoGroundingReservation(db, task.id);
    const result = await input.mutate(db, tasks);
    if (input.didMutate?.(result) ?? true) {
      for (const task of tasks) await invalidateGroundingContext(db, task.id);
      for (const projectId of [...new Set(input.projectIds)].sort()) await logGroundingContextMutation(db, {
        projectId, actorType: input.audit.actor.type, actorId: groundingActorId(input.audit.actor), reason: input.audit.reason.trim(), taskIds: tasks.filter(t => t.projectId === projectId).map(t => t.id),
      });
    }
    return result;
  });
}
