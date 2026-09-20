import { randomUUID } from "node:crypto";
import { Prisma, type GroundingGithubMergeGroup, type GroundingOperation } from "@prisma/client";
import type { Actor } from "../types/auth.js";
import { GroundingFinalizationService } from "./grounding-finalization.js";
import { groundingDecisionDigest, type GroundingAfterCommit, type GroundingCompletionDependencies, type GroundingDecision } from "./grounding-completion.js";
import { canonicalGroundingJson, groundingWorkflow, projectGroundingContext, mismatch, GroundingAccessError, type GroundingTask } from "./grounding-context.js";
import { requireGroundingCohort } from "./grounding-cohort.js";
import { findOperation, groundingActorId, operationFingerprint, operationRequest, routeTransportFingerprint, type GroundingRouteTransport, type OperationInput, type OperationRequest } from "./grounding-operations.js";
import { assertNoGroundingReservation, GroundingDecisionError, invalidateGroundingContext, lockGroundingProjects, lockGroundingTaskUnderProject } from "./grounding-transaction.js";
import { acquireGithubFence, assertGithubFenceOwned, canonicalGithubRepo, releaseGithubFence, withGithubFenceWrites, type GithubFenceOwner } from "./grounding-github-fence.js";
import { githubGroundingMergeProvider, groundingMergeConsent, mergeIdentitySchema, type GroundingMergeProvider, type MergeIdentity, type MergeProof } from "./grounding-merge-provider.js";
import { isTerminalState } from "./default-workflow.js";
import { logGroundingDecision } from "./audit.js";

function binding(task: GroundingTask) {
  const repo = task.deliverableRepo ?? task.project.githubRepo;
  const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/.exec(task.prUrl ?? "");
  if (!repo || !Number.isSafeInteger(task.prNumber) || !task.prNumber || task.prNumber > 2147483647 || !url || Number(url[2]) !== task.prNumber || canonicalGithubRepo(url[1]!) !== canonicalGithubRepo(repo)) mismatch();
  return { repo, canonicalRepo: canonicalGithubRepo(repo), prNumber: task.prNumber };
}
function owner(group: GroundingGithubMergeGroup): GithubFenceOwner { return { id: group.id, repo: group.repo, kind: "MERGE", taskId: group.seedTaskId }; }
function identity(group: GroundingGithubMergeGroup) { return mergeIdentitySchema.parse({ repo: group.dispatchRepo, prNumber: group.prNumber, headSha: group.headSha, method: group.mergeMethod }); }
function exactProof(remote: MergeIdentity, proof: MergeProof) {
  return proof.merged === true && proof.repo === remote.repo && proof.prNumber === remote.prNumber && proof.headSha === remote.headSha && typeof proof.mergeCommitSha === "string" && /^[0-9a-f]{40}$/.test(proof.mergeCommitSha);
}
function pending() { return { state: "DISPATCHED", pending: true }; }
const completed = (state: string) => state === "COMPLETED" || state === "CANCELLED";

/** Configured opt-in service. A peer authorizes the shared merge, never its own completion effects. */
export class GroundingGithubMergeService extends GroundingFinalizationService {
  private readonly groupProvider: GroundingMergeProvider;
  constructor(deps: GroundingCompletionDependencies & { mergeProvider?: GroundingMergeProvider }) {
    super(deps); this.groupProvider = deps.mergeProvider ?? githubGroundingMergeProvider;
  }

  private async discover(db: Prisma.TransactionClient, seed: GroundingTask) {
    const remote = binding(seed);
    const relevant = await db.$queryRaw<{ id: string }[]>`
      SELECT t.id FROM tasks t JOIN projects p ON p.id = t."projectId"
      LEFT JOIN grounding_cohorts c ON c."taskId" = t.id LEFT JOIN grounding_bindings b ON b."taskId" = t.id
      WHERE t.id = ${seed.id} OR ((c.protected OR c.mode = 'EXTERNAL_V1' OR b."taskId" IS NOT NULL) AND (
        grounding_github_repo(coalesce(t."deliverableRepo", p."githubRepo")) = ${remote.canonicalRepo} OR grounding_github_pr_repo(t."prUrl") = ${remote.canonicalRepo}
      ))
    `;
    const candidates = await db.task.findMany({ where: { id: { in: relevant.map(task => task.id) } }, include: { project: true, groundingCohort: true, groundingBinding: true }, orderBy: { id: "asc" } });
    const result: GroundingTask[] = [];
    for (const task of candidates) {
      if (task.id !== seed.id && !task.groundingCohort?.protected && !task.groundingBinding && task.groundingCohort?.mode !== "EXTERNAL_V1") continue;
      const effective = task.deliverableRepo ?? task.project.githubRepo;
      // Recognition includes malformed suffixes solely to reject ambiguous membership.
      // Strict binding() below remains the authorization input.
      const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([0-9]+)(?:[/?#]|$)/i.exec((task.prUrl ?? "").trim());
      let effectiveRepo: string | null = null;
      try { effectiveRepo = effective === null ? null : canonicalGithubRepo(effective); } catch { /* A matching PR URL still forces strict validation below. */ }
      const effectiveMatch = effectiveRepo === remote.canonicalRepo && task.prNumber === remote.prNumber;
      const urlMatch = url !== null && canonicalGithubRepo(url[1]!) === remote.canonicalRepo && Number(url[2]) === remote.prNumber;
      if (task.id !== seed.id && !effectiveMatch && !urlMatch) continue;
      const linked = binding(task);
      if (linked.canonicalRepo !== remote.canonicalRepo || linked.prNumber !== remote.prNumber) mismatch();
      // Partial enrollment is a protected failure, never a legacy fallback.
      if (task.id !== seed.id) await requireGroundingCohort(db, task.id, task.projectId);
      result.push(task);
    }
    return result;
  }

  /** Informational admission only. An empty result never authorizes an unfenced legacy merge. */
  async protectedMergeParticipants(taskId: string, actor: Actor) {
    return this.transaction(async db => {
      const seed = await db.task.findUnique({ where: { id: taskId }, include: { project: true } });
      if (!seed) throw new GroundingAccessError("not_found", 404);
      await this.requestAccess(db, seed, actor, operationRequest({ action: "merge" }));
      const tasks = await this.discover(db, seed);
      const seedCohort = await db.groundingCohort.findUnique({ where: { taskId } });
      if (seedCohort || await db.groundingBinding.findUnique({ where: { taskId } })) await requireGroundingCohort(db, taskId, seed.projectId);
      return { seedProvisioned: seedCohort !== null, taskIds: tasks.filter(task => task.id !== taskId || seedCohort?.protected).map(task => task.id) };
    });
  }

  private async lockTasks(db: Prisma.TransactionClient, tasks: GroundingTask[]) {
    const projects = tasks.map(task => task.projectId);
    await lockGroundingProjects(db, projects);
    const locked: GroundingTask[] = [];
    for (const task of [...tasks].sort((a, b) => a.id.localeCompare(b.id))) locked.push(await lockGroundingTaskUnderProject(db, task.id, projects));
    return locked;
  }

  private async load(db: Prisma.TransactionClient, taskId: string, actor: Actor, key: string, transport?: GroundingRouteTransport) {
    const operation = await findOperation(db, taskId, key, actor);
    const group = await db.groundingGithubMergeGroup.findUnique({ where: { seedTaskId_key: { seedTaskId: taskId, key } }, include: { members: { include: { operation: true }, orderBy: { taskId: "asc" } } } });
    if (!group || !operation) mismatch();
    if (group.actorType !== actor.type || group.actorId !== groundingActorId(actor)) throw new GroundingAccessError("forbidden", 403);
    if (transport && group.fingerprint !== routeTransportFingerprint(transport)) throw new GroundingDecisionError("grounding_operation_conflict");
    if (group.fingerprint !== operation.fingerprint || canonicalGroundingJson(group.request) !== canonicalGroundingJson(operation.request)) mismatch();
    if (!completed(group.state)) await assertGithubFenceOwned(db, owner(group));
    const tasks = await db.task.findMany({ where: { id: { in: group.members.map(member => member.taskId) } }, include: { project: true } });
    if (tasks.length !== group.members.length || group.members.filter(m => m.role === "SEED" && m.taskId === taskId && m.operationId === operation.id).length !== 1) mismatch();
    const locked = await this.lockTasks(db, tasks);
    const members = group.members.map(member => ({ ...member, task: locked.find(task => task.id === member.taskId)! }));
    for (const member of members) {
      if ((member.role === "SEED") !== (member.taskId === taskId) || member.operation.actorType !== actor.type || member.operation.actorId !== groundingActorId(actor) || member.operation.state !== group.state) mismatch();
      await this.requestAccess(db, member.task, actor, operationRequest(member.operation.request as OperationInput));
      await groundingMergeConsent(db, actor, member.task.project.teamId);
      if (!completed(group.state)) {
        const cohort = await requireGroundingCohort(db, member.taskId, member.task.projectId);
        if (cohort.reservationId !== member.operationId || member.operation.headSha !== group.headSha || member.operation.prNumber !== group.prNumber || member.operation.mergeMethod !== group.mergeMethod || !member.operation.repo || canonicalGithubRepo(member.operation.repo) !== group.repo) mismatch();
      }
    }
    return { group, members, operation };
  }

  /** Durable replay is resolved before mutable route status/claim gates. */
  async lookupGroupOperation(taskId: string, actor: Actor, key: string, transport?: GroundingRouteTransport) {
    return this.transaction(async db => {
      const previous = await findOperation(db, taskId, key, actor);
      if (!previous) return null;
      const { group, operation } = await this.load(db, taskId, actor, key, transport);
      return { operationId: operation.id, groupId: group.id, state: group.state, result: group.result };
    });
  }
  override async lookupRouteOperation(taskId: string, actor: Actor, key: string, transport: GroundingRouteTransport) {
    // Local completion operations keep their original replay behavior.
    const group = await this.deps.db.groundingGithubMergeGroup.findUnique({ where: { seedTaskId_key: { seedTaskId: taskId, key } } });
    return group ? this.lookupGroupOperation(taskId, actor, key, transport) : super.lookupRouteOperation(taskId, actor, key, transport);
  }

  override async reserveMerge(taskId: string, actor: Actor, key: string, input: Omit<OperationInput, "action"> & { action?: "finish" | "approve" | "merge" } = {}) {
    const request = operationRequest({ ...input, action: input.action ?? "merge" });
    if (!["finish", "approve", "merge"].includes(request.action)) throw new GroundingAccessError("bad_state", 409);
    if (request.route?.kind === "github_merge" && request.route.transport.body.idempotencyKey !== key) throw new GroundingDecisionError("grounding_operation_conflict");
    return this.transaction(async db => {
      const previous = await findOperation(db, taskId, key, actor, request);
      if (previous) {
        if (canonicalGroundingJson(previous.request) !== canonicalGroundingJson(request)) throw new GroundingDecisionError("grounding_operation_conflict");
        if (!await db.groundingGithubMergeGroup.findUnique({ where: { seedTaskId_key: { seedTaskId: taskId, key } } })) {
          if (previous.state === "RESERVED") throw new GroundingDecisionError("grounding_finalization_pending");
          await this.requestAccess(db, (await db.task.findUniqueOrThrow({ where: { id: taskId }, include: { project: true } })), actor, request);
          return { operationId: previous.id, state: previous.state, result: previous.result };
        }
        const { group, operation } = await this.load(db, taskId, actor, key);
        return { operationId: operation.id, groupId: group.id, state: group.state, result: group.result };
      }
      const seed = await db.task.findUnique({ where: { id: taskId }, include: { project: true } });
      if (!seed) throw new GroundingAccessError("not_found", 404);
      await this.requestAccess(db, seed, actor, request);
      // An unprovisioned seed cannot express a protected decision for its linked peers.
      await requireGroundingCohort(db, seed.id, seed.projectId);
      const remote = binding(seed);
      const fence = await acquireGithubFence(db, { id: randomUUID(), repo: remote.canonicalRepo, kind: "MERGE", taskId });
      const tasks = await this.lockTasks(db, await this.discover(db, seed));
      const reservations = [];
      let sharedHead: string | undefined;
      for (const task of tasks) {
        await assertNoGroundingReservation(db, task.id);
        const linked = binding(task);
        if (linked.canonicalRepo !== remote.canonicalRepo || linked.prNumber !== remote.prNumber) mismatch();
        const childRequest = task.id === taskId ? request : operationRequest({ action: "merge", method: request.method, route: { kind: "task_merge", transport: { endpoint: "merge", body: { mergeMethod: request.method } } } });
        await this.requestAccess(db, task, actor, childRequest);
        const decision = await this.decide(db, task, actor, childRequest, true);
        const { def } = await groundingWorkflow(db, task);
        if (!isTerminalState(def, decision.to)) throw new GroundingAccessError("bad_state", 409);
        await groundingMergeConsent(db, actor, task.project.teamId);
        const memberIdentity = mergeIdentitySchema.parse({ repo: linked.repo, prNumber: linked.prNumber, headSha: await this.requestHead(childRequest)({ actor, teamId: task.project.teamId, repo: linked.repo, prNumber: linked.prNumber, db }), method: request.method });
        if (sharedHead !== undefined && memberIdentity.headSha !== sharedHead) mismatch();
        sharedHead = memberIdentity.headSha;
        if (decision.ciHeadSha !== null && decision.ciHeadSha !== sharedHead) mismatch();
        if (decision.attemptId) {
          const attempt = await db.groundingAttempt.findUniqueOrThrow({ where: { id: decision.attemptId } });
          if (JSON.parse(attempt.contextBytes.toString("utf8")).deliverable.headSha !== sharedHead) mismatch();
        }
        reservations.push({ task, request: childRequest, decision, identity: memberIdentity });
      }
      if (!sharedHead || !reservations.some(row => row.task.id === taskId)) mismatch();
      const group = await db.groundingGithubMergeGroup.create({ data: { id: fence.id, seedTaskId: taskId, key, actorType: actor.type, actorId: groundingActorId(actor), fingerprint: operationFingerprint(request), request: request as Prisma.InputJsonObject, repo: remote.canonicalRepo, dispatchRepo: remote.repo, prNumber: remote.prNumber, headSha: sharedHead, mergeMethod: request.method } });
      let operationId = "";
      for (const row of reservations) {
        await withGithubFenceWrites(db, fence, row.task.id, async tx => {
          const guard = row.task.id !== taskId;
          const operation = await this.record(tx, row.task, actor, guard ? `github-group:${group.id}` : key, row.request, row.decision, row.identity, guard);
          await tx.groundingGithubMergeMember.create({ data: { groupId: group.id, taskId: row.task.id, operationId: operation.id, role: guard ? "GUARD" : "SEED" } });
          const changed = await tx.groundingCohort.updateMany({ where: { taskId: row.task.id, reservationId: null }, data: { reservationId: operation.id } });
          if (changed.count !== 1) mismatch();
          if (!guard) operationId = operation.id;
        });
      }
      for (const row of reservations) if (row.decision.expiresAt !== null && this.time() >= row.decision.expiresAt) throw new GroundingDecisionError("grounding_finalization_pending");
      return { operationId, groupId: group.id, state: group.state, result: group.result };
    });
  }

  override async dispatchMerge(taskId: string, actor: Actor, key: string, afterCommit?: GroundingAfterCommit) {
    if (!await this.deps.db.groundingGithubMergeGroup.findUnique({ where: { seedTaskId_key: { seedTaskId: taskId, key } } })) return super.recoverMerge(taskId, actor, key, afterCommit);
    const dispatch = await this.transaction(async db => {
      const { group, members } = await this.load(db, taskId, actor, key);
      if (completed(group.state)) return { historical: group.result };
      if (group.state === "DISPATCHED") return { pending: true };
      const remote = identity(group);
      const decisions: GroundingDecision[] = [];
      for (const member of members) {
        const request = operationRequest(member.operation.request as OperationInput);
        const decision = await this.decide(db, member.task, actor, request, true);
        const { routePlan: _plan, ...reserved } = member.operation.decision as unknown as GroundingDecision;
        if (canonicalGroundingJson(decision) !== canonicalGroundingJson(reserved)) mismatch();
        const linked = binding(member.task);
        if (linked.canonicalRepo !== group.repo || linked.prNumber !== group.prNumber) mismatch();
        const head = await this.requestHead(request)({ actor, teamId: member.task.project.teamId, repo: linked.repo, prNumber: linked.prNumber, db });
        if (head !== remote.headSha || (decision.ciHeadSha !== null && decision.ciHeadSha !== head)) mismatch();
        decisions.push(decision);
      }
      const seed = members.find(member => member.role === "SEED")!;
      const token = await groundingMergeConsent(db, actor, seed.task.project.teamId);
      const before = await this.groupProvider.read(remote, token);
      if (before.repo !== remote.repo || before.prNumber !== remote.prNumber || before.headSha !== remote.headSha) mismatch();
      const alreadyMerged = exactProof(remote, before);
      if (before.merged && !alreadyMerged) mismatch();
      for (const member of members) await withGithubFenceWrites(db, owner(group), member.taskId, async tx => {
        const decision = member.operation.decision as unknown as GroundingDecision;
        const updated = await tx.groundingOperation.updateMany({ where: { id: member.operationId, state: "RESERVED" }, data: { state: "DISPATCHED", dispatchedAt: new Date(this.time() * 1000), ...(decision.routePlan ? { decision: { ...decision, routePlan: { ...decision.routePlan, alreadyMerged } } as unknown as Prisma.InputJsonValue } : {}) } });
        if (updated.count !== 1) mismatch();
        await tx.groundingFinalization.updateMany({ where: { operationId: member.operationId }, data: { state: "DISPATCHED" } });
      });
      const claimed = await db.groundingGithubMergeGroup.updateMany({ where: { id: group.id, state: "RESERVED", dispatchedAt: null }, data: { state: "DISPATCHED", dispatchedAt: new Date(this.time() * 1000) } });
      if (claimed.count !== 1) mismatch();
      // No awaited dispatch writes may follow this final expiry sample.
      for (const decision of decisions) if (decision.expiresAt !== null && this.time() >= decision.expiresAt) throw new GroundingDecisionError("grounding_finalization_pending");
      return { remote, token, alreadyMerged };
    });
    if ("historical" in dispatch) return dispatch.historical;
    if (!dispatch.remote) return this.recoverMerge(taskId, actor, key, afterCommit);
    try { if (!dispatch.alreadyMerged) await this.groupProvider.merge(dispatch.remote, dispatch.token); }
    catch { return pending(); }
    return this.recoverMerge(taskId, actor, key, afterCommit);
  }

  private async historicalDecision(db: Prisma.TransactionClient, task: GroundingTask, operation: GroundingOperation, remote: MergeIdentity, actor: Actor) {
    const decision = operation.decision as unknown as GroundingDecision;
    const cohort = await requireGroundingCohort(db, task.id, task.projectId);
    const linked = binding(task);
    if (task.status !== decision.from || linked.canonicalRepo !== canonicalGithubRepo(remote.repo) || linked.prNumber !== remote.prNumber) mismatch();
    const { definition } = await groundingWorkflow(db, task);
    if (groundingDecisionDigest(task, cohort, definition, decision.target) !== decision.localDigest) mismatch();
    if (decision.attemptId && decision.target) {
      const currentBinding = await db.groundingBinding.findUnique({ where: { taskId: task.id } });
      const attempt = await db.groundingAttempt.findUnique({ where: { id: decision.attemptId } });
      if (!currentBinding || !attempt || currentBinding.activeAttemptId !== attempt.id || attempt.state !== "ACTIVE" || currentBinding.contextRevision !== decision.contextRevision) mismatch();
      const projected = await projectGroundingContext(task, currentBinding, decision.target, definition, actor, async () => remote.headSha, db);
      if (projected.digest !== decision.contextDigest || !projected.bytes.equals(attempt.contextBytes)) mismatch();
    }
  }

  private async consumeGuard(db: Prisma.TransactionClient, task: GroundingTask, operation: GroundingOperation, groupId: string, mergeCommitSha: string) {
    const decision = operation.decision as unknown as GroundingDecision;
    if (decision.routePlan) mismatch();
    if (decision.attemptId) {
      const consumed = await db.groundingAttempt.updateMany({ where: { id: decision.attemptId, taskId: task.id, state: "ACTIVE" }, data: { state: "CONSUMED" } });
      if (consumed.count !== 1) mismatch();
      await db.groundingBinding.update({ where: { taskId: task.id }, data: { activeAttemptId: null } });
    } else await invalidateGroundingContext(db, task.id);
    // The receipt authorizes this merge only. Later task completion needs fresh evidence.
    const result = { operationId: operation.id, taskId: task.id, groupId, role: "GUARD", status: task.status, mergeCommitSha, receiptId: decision.receiptId, freshAttemptRequired: Boolean(decision.attemptId) };
    await logGroundingDecision(db, { taskId: task.id, projectId: task.projectId, actorType: operation.actorType, actorId: operation.actorId, operationId: operation.id, action: "task.grounding.merge_guard_consumed", decision: result });
    await db.groundingOperation.update({ where: { id: operation.id }, data: { state: "COMPLETED", result, completedAt: new Date(this.time() * 1000) } });
    await db.groundingFinalization.updateMany({ where: { operationId: operation.id }, data: { state: "CONSUMED", result, completedAt: new Date(this.time() * 1000) } });
    await db.groundingCohort.update({ where: { taskId: task.id }, data: { reservationId: null } });
  }

  override async recoverMerge(taskId: string, actor: Actor, key: string, afterCommit?: GroundingAfterCommit) {
    if (!await this.deps.db.groundingGithubMergeGroup.findUnique({ where: { seedTaskId_key: { seedTaskId: taskId, key } } })) return super.recoverMerge(taskId, actor, key, afterCommit);
    const recovery = await this.transaction(async db => {
      const { group, members } = await this.load(db, taskId, actor, key);
      if (completed(group.state)) return { historical: group.result };
      if (group.state !== "DISPATCHED") throw new GroundingDecisionError("grounding_finalization_pending");
      const token = await groundingMergeConsent(db, actor, members.find(member => member.role === "SEED")!.task.project.teamId);
      return { groupId: group.id, remote: identity(group), token };
    });
    if ("historical" in recovery) return recovery.historical;
    let proof: MergeProof;
    try { proof = await this.groupProvider.read(recovery.remote, recovery.token); }
    catch { return pending(); }
    if (!exactProof(recovery.remote, proof)) return pending();
    const commit = await this.transaction(async db => {
      const { group, members } = await this.load(db, taskId, actor, key);
      if (group.id !== recovery.groupId) mismatch();
      if (completed(group.state)) return { result: group.result, signals: [], fresh: false };
      if (group.state !== "DISPATCHED") mismatch();
      for (const member of members) await this.historicalDecision(db, member.task, member.operation, recovery.remote, actor);
      let seedCommit: Awaited<ReturnType<typeof this.applyDecision>> | undefined;
      for (const member of members) await withGithubFenceWrites(db, owner(group), member.taskId, async tx => {
        if (member.role === "GUARD") await this.consumeGuard(tx, member.task, member.operation, group.id, proof.mergeCommitSha!);
        else seedCommit = await this.applyDecision(tx, member.task, member.operation, proof.mergeCommitSha!);
      });
      if (!seedCommit) mismatch();
      await db.groundingGithubMergeGroup.update({ where: { id: group.id }, data: { state: "COMPLETED", result: seedCommit.result, completedAt: new Date(this.time() * 1000) } });
      await releaseGithubFence(db, owner(group));
      return seedCommit;
    });
    return this.committed(commit, afterCommit);
  }

  override async cancelMerge(taskId: string, actor: Actor, key: string, reason: string) {
    if (!await this.deps.db.groundingGithubMergeGroup.findUnique({ where: { seedTaskId_key: { seedTaskId: taskId, key } } } )) return super.cancelMerge(taskId, actor, key, reason);
    const normalized = operationRequest({ action: "merge", reason }).reason;
    if (normalized === null) throw new GroundingAccessError("bad_state", 409);
    return this.transaction(async db => {
      const { group, members, operation } = await this.load(db, taskId, actor, key);
      if (group.state === "CANCELLED") {
        if ((group.result as { reason?: unknown }).reason !== normalized) throw new GroundingDecisionError("grounding_operation_conflict");
        return group.result;
      }
      if (group.state !== "RESERVED" || group.dispatchedAt !== null) throw new GroundingDecisionError("grounding_finalization_pending");
      const result = { operationId: operation.id, taskId, groupId: group.id, state: "CANCELLED", reason: normalized };
      for (const member of members) await withGithubFenceWrites(db, owner(group), member.taskId, async tx => {
        const changed = await tx.groundingOperation.updateMany({ where: { id: member.operationId, state: "RESERVED", dispatchedAt: null }, data: { state: "CANCELLED", result, completedAt: new Date(this.time() * 1000) } });
        if (changed.count !== 1) mismatch();
        await invalidateGroundingContext(tx, member.taskId);
        await tx.groundingFinalization.updateMany({ where: { operationId: member.operationId }, data: { state: "CANCELLED", result, completedAt: new Date(this.time() * 1000) } });
        await tx.groundingCohort.update({ where: { taskId: member.taskId }, data: { reservationId: null } });
        await logGroundingDecision(tx, { taskId: member.taskId, projectId: member.task.projectId, actorType: group.actorType, actorId: group.actorId, operationId: member.operationId, action: "task.grounding.cancelled", decision: { ...result, role: member.role } });
      });
      const cancelled = await db.groundingGithubMergeGroup.updateMany({ where: { id: group.id, state: "RESERVED", dispatchedAt: null }, data: { state: "CANCELLED", result, completedAt: new Date(this.time() * 1000) } });
      if (cancelled.count !== 1) mismatch();
      await releaseGithubFence(db, owner(group));
      return result;
    });
  }
}
