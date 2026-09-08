import { logGroundingDecision } from "./audit.js";
import type { Actor } from "../types/auth.js";
import { GroundingCompletionService, groundingDecisionDigest, type GroundingCompletionDependencies, type GroundingDecision } from "./grounding-completion.js";
import { operationAccess, findOperation, operationRequest, type OperationInput } from "./grounding-operations.js";
import { lockGroundingTask, invalidateGroundingContext, GroundingDecisionError } from "./grounding-transaction.js";
import { canonicalGroundingJson, groundingWorkflow, projectGroundingContext, GroundingAccessError, mismatch } from "./grounding-context.js";
import { groundingMergeConsent, githubGroundingMergeProvider, matchesGroundingMerge, mergeIdentitySchema, type GroundingMergeProvider } from "./grounding-merge-provider.js";

/** Remote effects happen only after the durable dispatch claim commits. */
export class GroundingFinalizationService extends GroundingCompletionService {
  private readonly provider: GroundingMergeProvider;
  constructor(deps: GroundingCompletionDependencies & { mergeProvider?: GroundingMergeProvider }) {
    super(deps); this.provider = deps.mergeProvider ?? githubGroundingMergeProvider;
  }
  async dispatchMerge(taskId: string, actor: Actor, key: string) {
    const dispatch = await this.transaction(async db => {
      const task = await lockGroundingTask(db, taskId); await operationAccess(db, task, actor, this.authority);
      const operation = await findOperation(db, taskId, key, actor);
      if (!operation || operation.mergeMethod === null) mismatch();
      if (operation.state === "COMPLETED" || operation.state === "CANCELLED") return { historical: operation.result };
      const cohort = await db.groundingCohort.findUnique({ where: { taskId } });
      if (cohort?.reservationId !== operation.id) mismatch();
      if (operation.state === "DISPATCHED") return { pending: true };
      const request = operationRequest(operation.request as OperationInput);
      const decision = await this.decide(db, task, actor, request);
      if (canonicalGroundingJson(decision) !== canonicalGroundingJson(operation.decision)) mismatch();
      const token = await groundingMergeConsent(db, actor, task.project.teamId);
      const identity = mergeIdentitySchema.parse({ repo: operation.repo, prNumber: operation.prNumber, headSha: operation.headSha, method: operation.mergeMethod });
      const currentHead = await this.head({ actor, teamId: task.project.teamId, repo: identity.repo, prNumber: identity.prNumber, db });
      if (currentHead !== identity.headSha) mismatch();
      const changed = await db.groundingOperation.updateMany({ where: { id: operation.id, state: "RESERVED" }, data: { state: "DISPATCHED", dispatchedAt: new Date(this.time() * 1000) } });
      if (changed.count !== 1) mismatch();
      await db.groundingFinalization.updateMany({ where: { operationId: operation.id }, data: { state: "DISPATCHED" } });
      // The authorization sample is fresh through the last awaited dispatch write.
      if (decision.expiresAt !== null && this.time() >= decision.expiresAt) throw new GroundingDecisionError("grounding_finalization_pending");
      return { identity, token };
    });
    if ("historical" in dispatch) return dispatch.historical;
    if (!dispatch.identity) return this.recoverMerge(taskId, actor, key);
    try { await this.provider.merge(dispatch.identity, dispatch.token); }
    catch { return { state: "DISPATCHED", pending: true }; }
    // Any DB/read failure leaves the durable reservation available to read-only recovery.
    return this.recoverMerge(taskId, actor, key);
  }

  /** Cancel only a provably undispatched decision; uncertain dispatch is never unlocked. */
  async cancelMerge(taskId: string, actor: Actor, key: string, reason: string) {
    const normalized = operationRequest({ action: "merge", reason }).reason;
    if (normalized === null) throw new GroundingAccessError("bad_state", 409);
    return this.transaction(async db => {
      const task = await lockGroundingTask(db, taskId); await operationAccess(db, task, actor, this.authority);
      const operation = await findOperation(db, taskId, key, actor);
      if (!operation || operation.mergeMethod === null) mismatch();
      if (operation.state === "CANCELLED") {
        const result = operation.result as { reason?: unknown };
        if (result.reason !== normalized) throw new GroundingDecisionError("grounding_operation_conflict");
        return operation.result;
      }
      if (operation.state !== "RESERVED") throw new GroundingDecisionError("grounding_finalization_pending");
      const cohort = await db.groundingCohort.findUnique({ where: { taskId } });
      if (cohort?.reservationId !== operation.id) mismatch();
      const result = { operationId: operation.id, taskId, state: "CANCELLED", reason: normalized };
      const changed = await db.groundingOperation.updateMany({ where: { id: operation.id, state: "RESERVED", dispatchedAt: null }, data: { state: "CANCELLED", completedAt: new Date(this.time() * 1000), result } });
      if (changed.count !== 1) mismatch();
      await invalidateGroundingContext(db, taskId);
      await db.groundingFinalization.updateMany({ where: { operationId: operation.id }, data: { state: "CANCELLED", completedAt: new Date(this.time() * 1000), result } });
      await db.groundingCohort.update({ where: { taskId }, data: { reservationId: null } });
      await logGroundingDecision(db, { taskId, projectId: task.projectId, actorType: operation.actorType, actorId: operation.actorId, operationId: operation.id, action: "task.grounding.cancelled", decision: result });
      return result;
    });
  }

  async recoverMerge(taskId: string, actor: Actor, key: string) {
    const recovery = await this.transaction(async db => {
      const task = await lockGroundingTask(db, taskId); await operationAccess(db, task, actor, this.authority);
      const operation = await findOperation(db, taskId, key, actor);
      if (!operation || operation.mergeMethod === null) mismatch();
      if (operation.state === "COMPLETED" || operation.state === "CANCELLED") return { historical: operation.result };
      if (operation.state !== "DISPATCHED") throw new GroundingDecisionError("grounding_finalization_pending");
      const cohort = await db.groundingCohort.findUnique({ where: { taskId } });
      if (cohort?.reservationId !== operation.id) mismatch();
      const token = await groundingMergeConsent(db, actor, task.project.teamId);
      const identity = mergeIdentitySchema.parse({ repo: operation.repo, prNumber: operation.prNumber, headSha: operation.headSha, method: operation.mergeMethod });
      return { operationId: operation.id, identity, token };
    });
    if ("historical" in recovery) return recovery.historical;
    let proof;
    try { proof = await this.provider.read(recovery.identity, recovery.token); }
    catch { return { state: "DISPATCHED", pending: true }; }
    if (!matchesGroundingMerge(recovery.identity, proof)) return { state: "DISPATCHED", pending: true };
    return this.transaction(async db => {
      const task = await lockGroundingTask(db, taskId); await operationAccess(db, task, actor, this.authority);
      const operation = await findOperation(db, taskId, key, actor);
      if (!operation || operation.id !== recovery.operationId) mismatch();
      if (operation.state === "COMPLETED" || operation.state === "CANCELLED") return operation.result;
      const cohort = await db.groundingCohort.findUnique({ where: { taskId } });
      if (operation.state !== "DISPATCHED" || cohort?.reservationId !== operation.id) mismatch();
      const decision = operation.decision as unknown as GroundingDecision;
      // Participating writers cannot alter this snapshot while it is reserved.
      // State disagreement from an old/nonparticipating writer stays unresolved.
      if (task.status !== decision.from || (task.deliverableRepo ?? task.project.githubRepo) !== recovery.identity.repo || task.prNumber !== recovery.identity.prNumber || task.prUrl !== `https://github.com/${recovery.identity.repo}/pull/${recovery.identity.prNumber}`) mismatch();
      const { definition } = await groundingWorkflow(db, task);
      if (groundingDecisionDigest(task, cohort, definition, decision.target) !== decision.localDigest) mismatch();
      if (decision.attemptId && decision.target) {
        const binding = await db.groundingBinding.findUnique({ where: { taskId } });
        const attempt = await db.groundingAttempt.findUnique({ where: { id: decision.attemptId } });
        if (!binding || !attempt || binding.activeAttemptId !== attempt.id || binding.contextRevision !== decision.contextRevision) mismatch();
        const projected = await projectGroundingContext(task, binding, decision.target, definition, actor, async () => recovery.identity.headSha, db);
        if (projected.digest !== decision.contextDigest || !projected.bytes.equals(attempt.contextBytes)) mismatch();
      }
      return this.applyDecision(db, task, operation, proof.mergeCommitSha!);
    });
  }
}
