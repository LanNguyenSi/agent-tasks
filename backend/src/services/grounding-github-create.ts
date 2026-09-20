import { createHash, randomUUID } from "node:crypto";
import { Prisma, type GroundingGithubCreateOperation, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { Actor, AgentActor } from "../types/auth.js";
import { canonicalGroundingJson, GroundingAccessError, groundingAuthority, type GroundingTask } from "./grounding-context.js";
import { groundingTransaction, lockGroundingTask, assertNoGroundingReservation, invalidateGroundingContext, GroundingDecisionError } from "./grounding-transaction.js";
import { acquireGithubFence, assertGithubFenceOwned, releaseGithubFence, withGithubFenceWrites, canonicalGithubRepo, GithubFenceError, type GithubFenceOwner } from "./grounding-github-fence.js";
import { findDelegationUser } from "./github-delegation.js";
import { logGroundingContextMutation } from "./audit.js";
import { normalizeGithubCreateRequest, githubCreateProof, hasGithubCreateCorrelation, githubGroundingCreateProvider, type GithubCreateRequest, type GithubCreateProof, type GroundingGithubCreateProvider } from "./grounding-github-create-provider.js";

const storedProof = z.object({ repo: z.string(), number: z.number().int().positive().max(2147483647), url: z.string(), title: z.string().max(4096), sourceRepo: z.string(), headRef: z.string(), headSha: z.string().regex(/^[0-9a-f]{40}$/), baseRef: z.string() }).strict();
function fingerprint(request: GithubCreateRequest) { return createHash("sha256").update(canonicalGroundingJson(request)).digest("hex"); }
function agent(actor: Actor): AgentActor {
  if (actor.type !== "agent" || !actor.scopes.includes("tasks:update") || !actor.scopes.includes("github:pr_create")) throw new GroundingAccessError("forbidden", 403);
  return actor;
}
function conflict(): never { throw new GroundingDecisionError("grounding_operation_conflict"); }
function fence(operation: GroundingGithubCreateOperation, request: GithubCreateRequest): GithubFenceOwner { return { id: operation.id, repo: `${request.owner}/${request.repo}`, kind: "PR_CREATE", taskId: operation.taskId }; }
function sameLogical(a: GithubCreateProof, b: GithubCreateProof) {
  return a.repo === b.repo && a.number === b.number && a.url === b.url && a.sourceRepo === b.sourceRepo && a.headRef === b.headRef && a.baseRef === b.baseRef;
}
function success(taskId: string, request: GithubCreateRequest, proof: GithubCreateProof) {
  return { pullRequest: { number: proof.number, url: proof.url, title: proof.title }, task: { id: taskId, branchName: request.head, prUrl: proof.url, prNumber: proof.number } };
}
export type GithubCreateResult = { status: 201; body: ReturnType<typeof success>; replayed?: boolean } | { status: 202; body: { error: "grounding_github_create_pending"; operationId: string; state?: GroundingGithubCreateOperation["state"] } | { error: "grounding_github_create_conflict"; operationId: string }; replayed?: boolean };

export class GroundingGithubCreateService {
  private readonly provider: GroundingGithubCreateProvider;
  constructor(private readonly deps: { db: PrismaClient; provider?: GroundingGithubCreateProvider }) { this.provider = deps.provider ?? githubGroundingCreateProvider; }
  private transaction<T>(run: (db: Prisma.TransactionClient) => Promise<T>) {
    return groundingTransaction(this.deps.db, async db => {
      try { return await run(db); }
      catch (error) { if (error instanceof GithubFenceError) throw new GroundingDecisionError("grounding_finalization_pending"); throw error; }
    });
  }
  private match(operation: GroundingGithubCreateOperation, actor: AgentActor, request: GithubCreateRequest) {
    if (operation.actorId !== actor.tokenId || operation.actorUserId !== actor.userId || operation.actorTeamId !== actor.teamId) throw new GroundingAccessError("forbidden", 403);
    if (operation.fingerprint !== fingerprint(request) || canonicalGroundingJson(operation.request) !== canonicalGroundingJson(request)) conflict();
  }
  private async authorize(db: Prisma.TransactionClient, task: GroundingTask, actor: AgentActor, request: GithubCreateRequest, delegateId?: string) {
    if (!await groundingAuthority.canWrite(actor, task.projectId, db)) throw new GroundingAccessError("forbidden", 403);
    const effective = task.deliverableRepo ?? task.project.githubRepo;
    if (effective !== null && canonicalGithubRepo(effective) !== `${request.owner}/${request.repo}`) throw new GroundingDecisionError("precondition_failed");
    const chosenId = delegateId ?? (await findDelegationUser(task.project.teamId, "allowAgentPrCreate", { preferUserId: actor.userId, db }))?.userId;
    if (!chosenId) throw new GroundingAccessError("forbidden", 403);
    await db.$queryRaw`SELECT id FROM users WHERE id = ${chosenId} FOR SHARE`;
    await db.$queryRaw`SELECT id FROM team_members WHERE "teamId" = ${task.project.teamId} AND "userId" = ${chosenId} FOR SHARE`;
    const member = await db.teamMember.findUnique({ where: { teamId_userId: { teamId: task.project.teamId, userId: chosenId } }, include: { user: true } });
    if (!member?.user.allowAgentPrCreate || !member.user.githubConnectedAt || !member.user.githubAccessToken) throw new GroundingAccessError("forbidden", 403);
    return { id: chosenId, token: member.user.githubAccessToken };
  }
  private async load(db: Prisma.TransactionClient, taskId: string, actor: AgentActor, key: string, request: GithubCreateRequest) {
    const operation = await db.groundingGithubCreateOperation.findUnique({ where: { taskId_key: { taskId, key } } });
    if (!operation) conflict();
    this.match(operation, actor, request);
    if (operation.state !== "COMPLETED") await assertGithubFenceOwned(db, fence(operation, request));
    const task = await lockGroundingTask(db, taskId);
    if (task.projectId !== operation.projectId) conflict();
    const delegate = await this.authorize(db, task, actor, request, operation.delegateUserId);
    return { operation, task, delegate };
  }
  private replay(operation: GroundingGithubCreateOperation, request: GithubCreateRequest): GithubCreateResult {
    if (operation.proofConflict) return this.proofConflict(operation.id);
    const proof = storedProof.parse(operation.observed);
    const body = success(operation.taskId, request, proof);
    if (canonicalGroundingJson(operation.result) !== canonicalGroundingJson(body)) conflict();
    return { status: 201, body, replayed: true };
  }
  private async pending(operationId: string, replayed = false): Promise<GithubCreateResult> {
    // Proof may be unavailable after another invocation already completed and
    // released its fence. Report stored state, never invent a new dispatch.
    const current = await this.deps.db.groundingGithubCreateOperation.findUnique({ where: { id: operationId }, select: { state: true } }).catch(() => null);
    return { status: 202, body: { error: "grounding_github_create_pending", operationId, ...(current ? { state: current.state } : {}) }, replayed };
  }

  private proofConflict(operationId: string): GithubCreateResult {
    return { status: 202, body: { error: "grounding_github_create_conflict", operationId }, replayed: true };
  }

  private async recordConflict(db: Prisma.TransactionClient, operation: GroundingGithubCreateOperation, observed: GithubCreateProof, source: "POST" | "READ") {
    if (operation.proofConflict) return operation;
    const diagnostic = { source, priorState: operation.state, original: operation.observed, conflicting: observed, observedAt: new Date().toISOString() };
    const changed = await db.groundingGithubCreateOperation.update({ where: { id: operation.id }, data: { proofConflict: diagnostic as unknown as Prisma.InputJsonObject } });
    await db.auditLog.create({ data: { taskId: operation.taskId, projectId: operation.projectId, actorId: null, action: "github.pr_create_conflict", payload: { actorType: "system_observation", operationId: operation.id, ...diagnostic } as unknown as Prisma.InputJsonObject } });
    await db.comment.create({ data: { taskId: operation.taskId, content: `[github] PR creation ${operation.id} has conflicting remote proof; reconciliation remains pending.` } });
    return changed;
  }

  private async remember(taskId: string, actor: AgentActor, key: string, request: GithubCreateRequest, observed: GithubCreateProof, source: "POST" | "READ") {
    return this.transaction(async db => {
      const operation = await db.groundingGithubCreateOperation.findUnique({ where: { taskId_key: { taskId, key } } });
      if (!operation) conflict();
      this.match(operation, actor, request);
      const task = await lockGroundingTask(db, taskId);
      if (task.projectId !== operation.projectId) conflict();
      // A provider fact may be recorded after access revocation, but can never
      // grant task authority. Compare before every completed-result shortcut.
      if (operation.proofConflict) return operation;
      if (operation.observed && !sameLogical(storedProof.parse(operation.observed), observed)) return this.recordConflict(db, operation, observed, source);
      await this.authorize(db, task, actor, request, operation.delegateUserId);
      if (operation.state === "COMPLETED") return operation;
      if (operation.state !== "DISPATCHED") conflict();
      await assertGithubFenceOwned(db, fence(operation, request));
      return operation.observed ? operation : db.groundingGithubCreateOperation.update({ where: { id: operation.id }, data: { observed: observed as unknown as Prisma.InputJsonObject } });
    });
  }

  async createOrResume(taskId: string, inputActor: Actor, inputKey: string, input: unknown): Promise<GithubCreateResult> {
    const actor = agent(inputActor); const request = normalizeGithubCreateRequest(input);
    const key = z.string().trim().min(1).max(255).parse(inputKey); z.string().uuid().parse(taskId);
    const reservation = await this.transaction(async db => {
      const previous = await db.groundingGithubCreateOperation.findUnique({ where: { taskId_key: { taskId, key } } });
      if (previous) { this.match(previous, actor, request); return (await this.load(db, taskId, actor, key, request)).operation; }
      const before = await db.task.findUnique({ where: { id: taskId }, include: { project: true } });
      if (!before) throw new GroundingAccessError("not_found", 404);
      const delegate = await this.authorize(db, before, actor, request);
      const owner = await acquireGithubFence(db, { id: randomUUID(), repo: `${request.owner}/${request.repo}`, kind: "PR_CREATE", taskId });
      const task = await lockGroundingTask(db, taskId);
      await this.authorize(db, task, actor, request, delegate.id);
      await assertNoGroundingReservation(db, taskId);
      if (await db.groundingOperation.count({ where: { taskId, state: { in: ["RESERVED", "DISPATCHED"] } } })) throw new GroundingDecisionError("grounding_finalization_pending");
      return db.groundingGithubCreateOperation.create({ data: { id: owner.id, taskId, projectId: task.projectId, key, actorId: actor.tokenId, actorUserId: actor.userId, actorTeamId: actor.teamId,
        fingerprint: fingerprint(request), request: request as Prisma.InputJsonObject, delegateUserId: delegate.id } });
    });
    if (reservation.proofConflict) return this.proofConflict(reservation.id);

    const dispatch = await this.transaction(async db => {
      const loaded = await this.load(db, taskId, actor, key, request);
      if (loaded.operation.proofConflict || loaded.operation.state === "COMPLETED") return { ...loaded, post: false };
      if (!["RESERVED", "DISPATCHED"].includes(loaded.operation.state)) conflict();
      const post = loaded.operation.state === "RESERVED";
      if (post) await db.groundingGithubCreateOperation.update({ where: { id: loaded.operation.id }, data: { state: "DISPATCHED", dispatchedAt: new Date() } });
      return { ...loaded, post };
    });
    if (dispatch.operation.proofConflict) return this.proofConflict(dispatch.operation.id);
    const replayed = !dispatch.post;
    let proof: GithubCreateProof | null = null;
    try {
      if (dispatch.post) {
        proof = githubCreateProof(request, await this.provider.create(request, dispatch.delegate.token, reservation.id), reservation.id);
      } else {
        const candidates = await this.provider.read(request, dispatch.delegate.token, reservation.id);
        if (candidates.complete === true && Array.isArray(candidates.pullRequests)) {
          const correlated = candidates.pullRequests.filter(candidate => hasGithubCreateCorrelation(candidate, reservation.id));
          if (correlated.length === 1) proof = githubCreateProof(request, correlated[0], reservation.id);
        }
      }
    } catch { return this.pending(reservation.id, replayed); }
    if (!proof) return this.pending(reservation.id, replayed);
    const observed = proof;
    try {
      // Persist the logical observation separately so a later binding failure can
      // only recover this PR. SHA is diagnostic: a branch can advance meanwhile.
      const remembered = await this.remember(taskId, actor, key, request, observed, dispatch.post ? "POST" : "READ");
      if (remembered.proofConflict) return this.proofConflict(remembered.id);
      if (remembered.state === "COMPLETED") return this.replay(remembered, request);
      return await this.transaction(async db => {
        const { operation, task } = await this.load(db, taskId, actor, key, request);
        if (operation.proofConflict) return this.proofConflict(operation.id);
        const frozen = storedProof.parse(operation.observed);
        if (!sameLogical(frozen, observed)) return this.proofConflict((await this.recordConflict(db, operation, observed, dispatch.post ? "POST" : "READ")).id);
        if (operation.state === "COMPLETED") return this.replay(operation, request);
        if (operation.state !== "DISPATCHED") conflict();
        const owner = fence(operation, request); const body = success(taskId, request, frozen);
        await withGithubFenceWrites(db, owner, taskId, async tx => {
          await assertNoGroundingReservation(tx, taskId);
          await tx.task.update({ where: { id: taskId }, data: { branchName: request.head, prUrl: frozen.url, prNumber: frozen.number } });
          await invalidateGroundingContext(tx, taskId);
          await logGroundingContextMutation(tx, { projectId: task.projectId, actorType: actor.type, actorId: actor.tokenId, taskIds: [taskId], reason: "github_pr_create_binding" });
          await tx.auditLog.create({ data: { action: "github.pr_created", actorId: operation.delegateUserId, projectId: task.projectId, taskId,
            payload: { operationId: operation.id, agentTokenId: actor.tokenId, delegatedUserId: operation.delegateUserId, owner: request.owner, repo: request.repo, prNumber: frozen.number, prUrl: frozen.url, sourceRepo: frozen.sourceRepo, headRef: frozen.headRef, observedHeadSha: frozen.headSha, baseRef: frozen.baseRef } } });
          if (task.deliverableRepo && (!task.project.githubRepo || canonicalGithubRepo(task.deliverableRepo) !== canonicalGithubRepo(task.project.githubRepo))) await tx.auditLog.create({ data: { action: "task.foreign_pr_linked", actorId: operation.delegateUserId, projectId: task.projectId, taskId, payload: { operationId: operation.id, prUrl: frozen.url, deliverableRepo: task.deliverableRepo, projectRepo: task.project.githubRepo, via: "github_pr_create" } } });
          await tx.groundingGithubCreateOperation.update({ where: { id: operation.id }, data: { state: "COMPLETED", result: body, completedAt: new Date() } });
          await releaseGithubFence(tx, owner);
        });
        return { status: 201 as const, body, replayed };
      });
    } catch (error) {
      if (error instanceof GroundingAccessError && ["forbidden", "not_found"].includes(error.code)) throw error;
      // The committed dispatch may have produced a remote effect. Never report
      // a local commit failure as a safe-to-retry POST or a no-effect conflict.
      return this.pending(reservation.id, replayed);
    }
  }
}
