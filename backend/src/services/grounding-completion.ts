import { createHash } from "node:crypto";
import { Prisma, type GroundingCohort, type GroundingOperation, type PrismaClient } from "@prisma/client";
import type { Actor } from "../types/auth.js";
import { GroundingReceiptVerificationError, verifyGroundingReceipt } from "./grounding-receipt.js";
import { canonicalGroundingJson, fetchGroundingHead, groundingAuthority, groundingWorkflow, resolveGroundingTarget, projectGroundingContext, GroundingAccessError, mismatch, unavailable, type GroundingAuthority, type GroundingHeadProvider, type GroundingTask, type GroundingTarget } from "./grounding-context.js";
import { groundingSettings, groundingTime } from "./grounding-verification.js";
import type { GroundingAttemptsConfig } from "./grounding-attempts.js";
import { requireGroundingCohort } from "./grounding-cohort.js";
import { groundingTransaction, lockGroundingTask, assertNoGroundingReservation, invalidateGroundingContext, GroundingDecisionError } from "./grounding-transaction.js";
import { operationRequest, operationFingerprint, groundingActorId, operationAccess, findOperation, type OperationInput, type OperationRequest } from "./grounding-operations.js";
import { completionGates } from "./grounding-completion-gates.js";
import { evaluateGroundingGate } from "./gates/grounding-gate.js";
import { getGroundingClient, type GroundingClient } from "./grounding-client.js";
import { isReviewState, isWorkState, isTerminalState, requestChangesTarget } from "./default-workflow.js";
import { groundingMergeConsent, mergeIdentitySchema, type MergeIdentity } from "./grounding-merge-provider.js";
import { logGroundingDecision } from "./audit.js";

export interface GroundingCompletionDependencies {
  db: PrismaClient; config: GroundingAttemptsConfig; now?: () => number;
  headProvider?: GroundingHeadProvider; authority?: GroundingAuthority;
  legacyClient?: Pick<GroundingClient, "getLedgerSummary">;
}
export interface GroundingDecision {
  action: OperationRequest["action"]; mode: string; protected: boolean; from: string; to: string;
  target: GroundingTarget | null; data: { status: string; result?: string; claimedByUserId?: null; claimedByAgentId?: null; claimedAt?: null; reviewClaimedByUserId?: null; reviewClaimedByAgentId?: null; reviewClaimedAt?: null };
  localDigest: string; contextDigest: string; receiptId: string | null; attemptId: string | null; contextRevision: number | null;
  expiresAt: number | null; overrideReason: string | null; reason: string | null; skippedRules: string[]; ciHeadSha: string | null;
}
export const clearWork = { claimedByUserId: null, claimedByAgentId: null, claimedAt: null };
export const clearReview = { reviewClaimedByUserId: null, reviewClaimedByAgentId: null, reviewClaimedAt: null };
function stale(): never { throw new GroundingReceiptVerificationError("grounding_receipt_stale"); }
function forbidden(): never { throw new GroundingAccessError("forbidden", 403); }
function badState(): never { throw new GroundingAccessError("bad_state", 409); }

/** Shared service boundary only; existing HTTP callers are not enrolled or wired here. */
export class GroundingCompletionService {
  protected readonly now: () => number;
  protected readonly head: GroundingHeadProvider;
  protected readonly authority: GroundingAuthority;
  private legacy?: Pick<GroundingClient, "getLedgerSummary">;
  constructor(protected readonly deps: GroundingCompletionDependencies) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.head = deps.headProvider ?? fetchGroundingHead;
    this.authority = deps.authority ?? groundingAuthority;
    this.legacy = deps.legacyClient;
  }
  protected time() { return groundingTime(this.now); }
  protected transaction<T>(run: (db: Prisma.TransactionClient) => Promise<T>) { return groundingTransaction(this.deps.db, run); }

  protected async decide(db: Prisma.TransactionClient, task: GroundingTask, actor: Actor, request: OperationRequest): Promise<GroundingDecision> {
    const cohort = await requireGroundingCohort(db, task.id, task.projectId);
    const success = ["finish", "approve", "merge"].includes(request.action);
    const scope = request.action === "creator_abandon" ? "tasks:update" : ["abandon", "release"].includes(request.action) ? "tasks:claim" : "tasks:transition";
    if (actor.type === "agent" && !actor.scopes.includes(scope)) forbidden();
    await operationAccess(db, task, actor, this.authority);
    if (request.overrideReason !== null && (actor.type !== "human" || !request.overrideReason.trim() || !await this.authority.hasRole(actor, task.projectId, "ADMIN", db))) forbidden();
    const holdsWork = actor.type === "human" ? task.claimedByUserId === actor.userId : task.claimedByAgentId === actor.tokenId;
    const holdsReview = actor.type === "human" ? task.reviewClaimedByUserId === actor.userId : task.reviewClaimedByAgentId === actor.tokenId;
    const { definition, def, workflowId } = await groundingWorkflow(db, task);
    let target: GroundingTarget | null = null;
    let data: GroundingDecision["data"] = { status: task.status };
    let skippedRules: string[] = [];
    let ciHeadSha: string | null = null;
    if (success) {
      const resolved = await resolveGroundingTarget(db, task, actor, request.action as "finish" | "approve" | "merge", this.authority);
      target = resolved.target;
      ({ skippedRules, ciHeadSha } = await completionGates(db, task, actor, target, definition, this.authority, request.action === "merge", this.head));
      data = { status: target.to, ...clearReview, ...(isTerminalState(def, target.to) ? clearWork : {}), ...(request.result !== null ? { result: request.result } : {}) };
    } else if (request.action === "request_changes") {
      if (!isReviewState(def, task.status)) badState();
      if (!holdsReview) forbidden();
      const to = requestChangesTarget(def, task.status);
      if (!to || isTerminalState(def, to) || isReviewState(def, to)) badState();
      const edge = { workflowId, from: task.status, to, action: "approve" as const };
      ({ skippedRules, ciHeadSha } = await completionGates(db, task, actor, edge, definition, this.authority, false, this.head));
      data = { status: to, ...clearReview };
    } else if (request.action === "creator_abandon") {
      if (actor.type !== "agent" || task.createdByAgentId !== actor.tokenId) forbidden();
      if (!["open", "backlog"].includes(task.status) || task.claimedByUserId || task.claimedByAgentId || task.reviewClaimedByUserId || task.reviewClaimedByAgentId) badState();
      data = { status: "abandoned" };
    } else if (request.action === "reopen") {
      if (actor.type !== "human" || !await this.authority.hasRole(actor, task.projectId, "ADMIN", db)) forbidden();
      if (task.status !== "abandoned" || task.claimedByUserId || task.claimedByAgentId || task.reviewClaimedByUserId || task.reviewClaimedByAgentId) badState();
      data = { status: def.initialState };
    } else if (request.action === "release") {
      if (!holdsWork) forbidden();
      // A release cannot orphan a live reviewer; the review disposition owns that edge.
      if (isReviewState(def, task.status) || task.reviewClaimedByUserId || task.reviewClaimedByAgentId) badState();
      data = { status: def.initialState, ...clearWork };
    } else {
      if (!holdsWork && !holdsReview) forbidden();
      if (holdsWork && !holdsReview && isReviewState(def, task.status)) badState();
      data = { status: holdsWork && isWorkState(def, task.status) ? def.initialState : task.status, ...(holdsWork ? clearWork : {}), ...(holdsReview ? clearReview : {}) };
    }
    const decision: GroundingDecision = { action: request.action, mode: cohort.mode, protected: cohort.protected, from: task.status, to: data.status,
      target, data, localDigest: groundingDecisionDigest(task, cohort, definition, target), contextDigest: groundingDecisionDigest(task, cohort, definition, target),
      receiptId: null, attemptId: null, contextRevision: null, expiresAt: null, overrideReason: request.overrideReason, reason: request.reason, skippedRules, ciHeadSha };
    if (!success || request.overrideReason !== null || !cohort.protected) return decision;
    if (cohort.mode === "LEGACY_LOCAL") {
      this.legacy ??= getGroundingClient();
      const summary = await this.legacy.getLedgerSummary(cohort.legacySessionId!);
      const gate = evaluateGroundingGate({ metadata: { debugFlavor: true, groundingSessionId: cohort.legacySessionId! }, project: { requireGroundingForDebug: true }, ledgerSummary: summary, currentPhase: cohort.legacyPhase });
      if (!Number.isSafeInteger(summary.entryCount) || summary.entryCount < 1 || !gate.allowed) throw new GroundingReceiptVerificationError("grounding_required");
      return decision;
    }
    if (cohort.mode !== "EXTERNAL_V1" || !target) unavailable();
    const settings = groundingSettings(this.deps.config, task.projectId);
    const binding = await db.groundingBinding.findUnique({ where: { taskId: task.id } });
    if (!binding || binding.audience !== settings.audience) unavailable();
    if (!binding.activeAttemptId) throw new GroundingReceiptVerificationError("grounding_required");
    const attempt = await db.groundingAttempt.findUnique({ where: { id: binding.activeAttemptId }, include: { receipt: true } });
    if (!attempt || attempt.state !== "ACTIVE") stale();
    if (!attempt.receipt) throw new GroundingReceiptVerificationError("grounding_required");
    if (attempt.actorType !== actor.type || attempt.actorId !== groundingActorId(actor)) forbidden();
    const projected = await projectGroundingContext(task, binding, target, definition, actor, this.head, db);
    if (binding.contextRevision !== attempt.contextRevision || projected.digest !== attempt.contextDigest || !projected.bytes.equals(attempt.contextBytes)) mismatch();
    if (ciHeadSha !== null && binding.subjectMode === "CODE_HEAD" && JSON.parse(projected.bytes.toString("utf8")).deliverable.headSha !== ciHeadSha)
      throw new GroundingDecisionError("precondition_failed");
    if (!attempt.sessionId || !attempt.sessionRevision) unavailable();
    const evidence = verifyGroundingReceipt(attempt.receipt.wireBytes, { trust: settings.trust, now: this.time(), expected: {
      audience: binding.audience, projectId: task.projectId, taskId: task.id, attemptId: attempt.id, nonce: attempt.nonce,
      contextRevision: attempt.contextRevision, target, subjectDigest: projected.digest,
      session: { id: attempt.sessionId, revision: attempt.sessionRevision }, attemptCreatedAt: attempt.createdAt.getTime() / 1000, attemptExpiresAt: attempt.expiresAt.getTime() / 1000,
    } });
    if (evidence.receiptId !== attempt.receipt.id || createHash("sha256").update(attempt.receipt.wireBytes).digest("hex") !== attempt.receipt.wireSha256) mismatch();
    return { ...decision, contextDigest: projected.digest, receiptId: evidence.receiptId, attemptId: attempt.id, contextRevision: attempt.contextRevision, expiresAt: Math.min(attempt.expiresAt.getTime() / 1000, evidence.expiresAt) };
  }

  protected async record(db: Prisma.TransactionClient, task: GroundingTask, actor: Actor, key: string, request: OperationRequest, decision: GroundingDecision, remote?: MergeIdentity) {
    const operation = await db.groundingOperation.create({ data: { taskId: task.id, key, actorType: actor.type, actorId: groundingActorId(actor), fingerprint: operationFingerprint(request), request,
      decision: decision as unknown as Prisma.InputJsonValue, state: remote ? "RESERVED" : "COMPLETED", ...(remote ? { repo: remote.repo, prNumber: remote.prNumber, headSha: remote.headSha, mergeMethod: remote.method } : {}) } });
    if (decision.receiptId && decision.attemptId && decision.target && decision.contextRevision) await db.groundingFinalization.create({ data: {
      operationId: operation.id, taskId: task.id, attemptId: decision.attemptId, receiptId: decision.receiptId, target: decision.target,
      contextRevision: decision.contextRevision, contextDigest: decision.contextDigest, state: remote ? "RESERVED" : "CONSUMED", ...(remote ? { repo: remote.repo, prNumber: remote.prNumber, headSha: remote.headSha } : {}),
    } });
    return operation;
  }

  protected async applyDecision(db: Prisma.TransactionClient, task: GroundingTask, operation: GroundingOperation, mergeCommitSha?: string) {
    const decision = operation.decision as unknown as GroundingDecision;
    const changed = await db.task.updateMany({ where: { id: task.id, status: decision.from, claimedByUserId: task.claimedByUserId, claimedByAgentId: task.claimedByAgentId, reviewClaimedByUserId: task.reviewClaimedByUserId, reviewClaimedByAgentId: task.reviewClaimedByAgentId }, data: { ...decision.data, ...(mergeCommitSha ? { autoMergeSha: mergeCommitSha } : {}) } });
    if (changed.count !== 1) mismatch();
    if (decision.attemptId) {
      const consumed = await db.groundingAttempt.updateMany({ where: { id: decision.attemptId, taskId: task.id, state: "ACTIVE" }, data: { state: "CONSUMED" } });
      if (consumed.count !== 1) mismatch();
      await db.groundingBinding.update({ where: { taskId: task.id }, data: { activeAttemptId: null } });
    } else await invalidateGroundingContext(db, task.id);
    const result = { operationId: operation.id, taskId: task.id, action: decision.action, status: decision.to, mode: decision.mode, receiptId: decision.receiptId, mergeCommitSha: mergeCommitSha ?? null, overrideReason: decision.overrideReason };
    await logGroundingDecision(db, { taskId: task.id, projectId: task.projectId, actorType: operation.actorType, actorId: operation.actorId, operationId: operation.id,
      action: decision.overrideReason !== null ? "task.grounding.overridden" : ["finish", "approve", "merge"].includes(decision.action) ? "task.grounding.completed" : "task.grounding.disposed", decision: { ...result, from: decision.from, reason: decision.reason, skippedRules: decision.skippedRules, ciHeadSha: decision.ciHeadSha } });
    await db.groundingOperation.update({ where: { id: operation.id }, data: { state: "COMPLETED", result, completedAt: new Date(this.time() * 1000) } });
    await db.groundingFinalization.updateMany({ where: { operationId: operation.id }, data: { state: "CONSUMED", result, completedAt: new Date(this.time() * 1000) } });
    if (operation.state === "DISPATCHED") await db.groundingCohort.update({ where: { taskId: task.id }, data: { reservationId: null } });
    // Local acceptance stays fresh through all awaited writes; authorized remote recovery is historical.
    if (operation.state !== "DISPATCHED" && decision.expiresAt !== null && this.time() >= decision.expiresAt) stale();
    return result;
  }

  async complete(taskId: string, actor: Actor, key: string, input: OperationInput) {
    const request = operationRequest(input);
    if (!["finish", "approve"].includes(request.action)) badState();
    return this.local(taskId, actor, key, request);
  }
  async dispose(taskId: string, actor: Actor, key: string, input: OperationInput) {
    const request = operationRequest(input);
    if (["finish", "approve", "merge"].includes(request.action)) badState();
    return this.local(taskId, actor, key, request);
  }
  private async local(taskId: string, actor: Actor, key: string, request: OperationRequest) {
    return this.transaction(async db => {
      const task = await lockGroundingTask(db, taskId); await operationAccess(db, task, actor, this.authority);
      const previous = await findOperation(db, taskId, key, actor, request);
      if (previous?.state === "COMPLETED") return previous.result;
      if (previous) throw new GroundingDecisionError("grounding_finalization_pending");
      await assertNoGroundingReservation(db, taskId);
      const decision = await this.decide(db, task, actor, request);
      const operation = await this.record(db, task, actor, key, request, decision);
      return this.applyDecision(db, task, operation);
    });
  }
  async reserveMerge(taskId: string, actor: Actor, key: string, input: Omit<OperationInput, "action"> = {}) {
    const request = operationRequest({ ...input, action: "merge" });
    return this.transaction(async db => {
      const task = await lockGroundingTask(db, taskId); await operationAccess(db, task, actor, this.authority);
      const previous = await findOperation(db, taskId, key, actor, request);
      if (previous) return { operationId: previous.id, state: previous.state, result: previous.result };
      await assertNoGroundingReservation(db, taskId);
      const decision = await this.decide(db, task, actor, request);
      await groundingMergeConsent(db, actor, task.project.teamId);
      const repo = task.deliverableRepo ?? task.project.githubRepo;
      if (!repo || task.prUrl !== `https://github.com/${repo}/pull/${task.prNumber}`) unavailable();
      const remote = mergeIdentitySchema.parse({ repo, prNumber: task.prNumber, headSha: await this.head({ actor, teamId: task.project.teamId, repo, prNumber: task.prNumber!, db }), method: request.method });
      if (decision.ciHeadSha !== null && decision.ciHeadSha !== remote.headSha) throw new GroundingDecisionError("precondition_failed");
      if (decision.attemptId) {
        const attempt = await db.groundingAttempt.findUniqueOrThrow({ where: { id: decision.attemptId } });
        const context = JSON.parse(attempt.contextBytes.toString("utf8"));
        if (context.deliverable.headSha !== remote.headSha) mismatch();
      }
      const operation = await this.record(db, task, actor, key, request, decision, remote);
      const changed = await db.groundingCohort.updateMany({ where: { taskId, reservationId: null }, data: { reservationId: operation.id } });
      if (changed.count !== 1) mismatch();
      if (decision.expiresAt !== null && this.time() >= decision.expiresAt) stale();
      return { operationId: operation.id, state: operation.state, result: operation.result };
    });
  }
}

/** Local snapshot is independent of mutable display metadata and remote receipt TTL. */
export function groundingDecisionDigest(task: GroundingTask, cohort: GroundingCohort, definition: unknown, target: GroundingTarget | null) {
  return createHash("sha256").update(canonicalGroundingJson({
    task: {
      title: task.title, description: task.description, templateData: task.templateData,
      projectId: task.projectId, status: task.status, workflowId: task.workflowId,
      claimedByUserId: task.claimedByUserId, claimedByAgentId: task.claimedByAgentId,
      reviewClaimedByUserId: task.reviewClaimedByUserId, reviewClaimedByAgentId: task.reviewClaimedByAgentId,
      branchName: task.branchName, prUrl: task.prUrl, prNumber: task.prNumber, deliverableRepo: task.deliverableRepo,
    },
    project: {
      teamId: task.project.teamId, githubRepo: task.project.githubRepo, taskTemplate: task.project.taskTemplate,
      governanceMode: task.project.governanceMode, soloMode: task.project.soloMode, requireDistinctReviewer: task.project.requireDistinctReviewer,
    },
    cohort: {
      mode: cohort.mode, protected: cohort.protected, provenance: cohort.provenance,
      legacySessionId: cohort.legacySessionId, legacyPhase: cohort.legacyPhase,
    },
    definition, target,
  })).digest("hex");
}
