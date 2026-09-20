import type { Prisma } from "@prisma/client";
import { mismatch, type GroundingTask } from "./grounding-context.js";
import { assertNoGroundingReservation, invalidateGroundingContext } from "./grounding-transaction.js";

export type GithubObservedContextChange = {
  task: GroundingTask;
  patch: Partial<Pick<GroundingTask, "status" | "prNumber" | "prUrl" | "branchName">>;
  headChanged?: boolean;
};

/** Internal DB-only observation adapter. The caller holds sorted project/task locks.
 * This identity attributes an external observation; it grants no Actor authority.
 */
export async function applyGithubObservedContext(tx: Prisma.TransactionClient, changes: GithubObservedContextChange[], event: { deliveryId: string; reason: string }) {
  const actual = changes.filter(({ task, patch, headChanged }) => headChanged || Object.entries(patch).some(([key, value]) => task[key as keyof typeof patch] !== value));
  for (const change of actual) await assertNoGroundingReservation(tx, change.task.id);
  for (const { task, patch } of actual) {
    if (Object.keys(patch).length) {
      const updated = await tx.task.updateMany({ where: { id: task.id, status: task.status, prNumber: task.prNumber, prUrl: task.prUrl, branchName: task.branchName }, data: patch });
      if (updated.count !== 1) mismatch();
    }
    await invalidateGroundingContext(tx, task.id);
    await tx.auditLog.create({ data: { taskId: task.id, projectId: task.projectId, actorId: null, action: "task.grounding.context_observed", payload: { source: "github_webhook", actorType: "system_observation", deliveryId: event.deliveryId, reason: event.reason, changedFields: Object.keys(patch) } } });
  }
  return actual.length;
}
