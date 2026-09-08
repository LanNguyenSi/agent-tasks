import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type Prisma, type GroundingAttempt, type GroundingBinding, type PrismaClient } from "@prisma/client";
import { groundingSettings, groundingTime } from "./grounding-verification.js";
import { provisionGroundingCohortInTransaction, requireGroundingCohort } from "./grounding-cohort.js";
import { groundingTransaction, lockGroundingTask, assertNoGroundingReservation } from "./grounding-transaction.js";
import { z } from "zod";
import type { Actor } from "../types/auth.js";
import { verifyGroundingReceipt, GroundingReceiptVerificationError, type GroundingReceiptTrustEntry } from "./grounding-receipt.js";
import {
  GROUNDING_POLICY, GroundingAccessError, fetchGroundingHead, groundingAuthority, groundingIntentSchema,
  mismatch, projectGroundingContext, resolveGroundingTarget, unavailable,
  resolveTaskMergeTarget, fetchTaskMergeHead,
  type GroundingAuthority, type GroundingHeadProvider, type GroundingIntent, type GroundingTarget, type GroundingTask,
} from "./grounding-context.js";

const token = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const uuid = z.string().uuid().regex(/^[0-9a-f-]+$/);
export const groundingSessionSchema = z.object({ id: token, revision: z.number().int().positive().max(2147483647) }).strict();
export type GroundingSession = z.infer<typeof groundingSessionSchema>;
export interface GroundingAttemptsConfig {
  audience: string;
  /** Operator-owned source, read afresh for every issuance/ingest, including exact retries. */
  trust: () => readonly GroundingReceiptTrustEntry[];
  challengeSeconds?: number;
}
export interface GroundingAttemptsDependencies {
  db: PrismaClient;
  config: GroundingAttemptsConfig;
  now?: () => number;
  headProvider?: GroundingHeadProvider;
  authority?: GroundingAuthority;
}

function stale(): never { throw new GroundingReceiptVerificationError("grounding_receipt_stale"); }
function invalid(): never { throw new GroundingReceiptVerificationError("grounding_receipt_invalid"); }
function actorId(actor: Actor): string { return actor.type === "agent" ? actor.tokenId : actor.userId; }


export class GroundingAttemptsService {
  private readonly now: () => number;
  private readonly head: GroundingHeadProvider;
  private readonly taskMergeHead: GroundingHeadProvider;
  private readonly authority: GroundingAuthority;
  constructor(private readonly deps: GroundingAttemptsDependencies) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.head = deps.headProvider ?? fetchGroundingHead;
    this.taskMergeHead = deps.headProvider ?? fetchTaskMergeHead;
    this.authority = deps.authority ?? groundingAuthority;
  }

  private settings(projectId: string) { return groundingSettings(this.deps.config, projectId); }
  private time() { return groundingTime(this.now); }

  private async transaction<T>(operation: (db: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return groundingTransaction(this.deps.db, operation);
  }

  private async lock(db: Prisma.TransactionClient, taskId: string): Promise<GroundingTask> {
    return lockGroundingTask(db, taskId);
  }

  private async authorizeTask(task: GroundingTask, actor: Actor, db: Prisma.TransactionClient): Promise<void> {
    if ((actor.type === "agent" && !actor.scopes.includes("tasks:transition")) || !await this.authority.canWrite(actor, task.projectId, db))
      throw new GroundingAccessError("forbidden", 403);
    const ownsClaim = actor.type === "agent"
      ? task.claimedByAgentId === actor.tokenId || task.reviewClaimedByAgentId === actor.tokenId
      : task.claimedByUserId === actor.userId || task.reviewClaimedByUserId === actor.userId;
    if (!ownsClaim) throw new GroundingAccessError("forbidden", 403);
  }

  /** HTTP preauthorization before parsing receipt data; transaction paths repeat these checks. */
  async authorize(taskId: string, actor: Actor): Promise<void> {
    return this.transaction(async db => {
      const task = await db.task.findUnique({ where: { id: taskId }, include: { project: true } });
      if (!task) throw new GroundingAccessError("not_found", 404);
      await this.authorizeTask(task, actor, db);
    });
  }

  private async authorizePolicy(task: GroundingTask, actor: Actor, db: Prisma.TransactionClient, intent?: GroundingIntent, taskRoute = false) {
    if (taskRoute && intent === "merge" && task.status === "review") await resolveTaskMergeTarget(db, task, actor, this.authority);
    else await this.authorizeTask(task, actor, db);
  }

  /** Pre-parse admission grants only one of the installed route capabilities. */
  async authorizeRouteIssue(taskId: string, actor: Actor): Promise<void> {
    return this.transaction(async db => {
      const task = await this.lock(db, taskId);
      try { await this.authorizeTask(task, actor, db); }
      catch (error) {
        if (!(error instanceof GroundingAccessError) || error.code !== "forbidden") throw error;
        await resolveTaskMergeTarget(db, task, actor, this.authority);
      }
    });
  }

  private async receiptIntent(db: Prisma.TransactionClient, taskId: string, attemptId: string, actor: Actor): Promise<GroundingIntent> {
    const task = await this.lock(db, taskId);
    if (!await this.authority.canWrite(actor, task.projectId, db)) throw new GroundingAccessError("forbidden", 403);
    const attempt = await db.groundingAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt || attempt.taskId !== taskId) mismatch();
    if (attempt.actorType !== actor.type || attempt.actorId !== actorId(actor)) throw new GroundingAccessError("forbidden", 403);
    const intent = groundingIntentSchema.safeParse(attempt.intent);
    if (!intent.success) unavailable();
    return intent.data;
  }

  async authorizeRouteReceipt(taskId: string, attemptId: string, actor: Actor): Promise<void> {
    return this.transaction(async db => {
      const intent = await this.receiptIntent(db, taskId, attemptId, actor);
      await this.lockAuthorized(db, taskId, actor, intent, true);
    });
  }

  private async lockAuthorized(db: Prisma.TransactionClient, taskId: string, actor: Actor, intent?: GroundingIntent, taskRoute = false): Promise<GroundingTask> {
    const before = await db.task.findUnique({ where: { id: taskId }, include: { project: true } });
    if (!before) throw new GroundingAccessError("not_found", 404);
    await this.authorizePolicy(before, actor, db, intent, taskRoute);
    const task = await this.lock(db, taskId);
    await this.authorizePolicy(task, actor, db, intent, taskRoute);
    await assertNoGroundingReservation(db, task.id);
    return task;
  }

  /** Service-only enrollment from protected configuration; never called by the HTTP router. */
  async provision(input: { taskId: string; projectId: string; subjectMode: "TASK_SPEC" | "CODE_HEAD" }): Promise<GroundingBinding> {
    if (!uuid.safeParse(input.projectId).success || !["TASK_SPEC", "CODE_HEAD"].includes(input.subjectMode)) unavailable();
    return this.transaction(async db => {
      const task = await this.lock(db, input.taskId);
      if (task.projectId !== input.projectId) mismatch();
      const settings = this.settings(task.projectId);
      await provisionGroundingCohortInTransaction(db, task.id, task.projectId, { mode: "EXTERNAL_V1", protected: true, provenance: "external-binding:v1", legacySessionId: null, legacyPhase: null });
      const existing = await db.groundingBinding.findUnique({ where: { taskId: task.id } });
      if (existing) {
        if (existing.projectId !== input.projectId || existing.audience !== settings.audience || existing.subjectMode !== input.subjectMode || !existing.protected ||
            existing.policyId !== GROUNDING_POLICY.id || existing.policyRevision !== GROUNDING_POLICY.revision || existing.policySha256 !== GROUNDING_POLICY.sha256) mismatch();
        return existing;
      }
      return db.groundingBinding.create({ data: {
        taskId: task.id, projectId: task.projectId, audience: settings.audience, protected: true,
        subjectMode: input.subjectMode, policyId: GROUNDING_POLICY.id, policyRevision: GROUNDING_POLICY.revision, policySha256: GROUNDING_POLICY.sha256,
      } });
    });
  }

  private async context(db: Prisma.TransactionClient, task: GroundingTask, actor: Actor, intent: GroundingIntent, taskRoute = false) {
    const standalone = taskRoute && intent === "merge" && task.status === "review";
    const resolved = standalone ? await resolveTaskMergeTarget(db, task, actor, this.authority) : await resolveGroundingTarget(db, task, actor, intent, this.authority);
    const binding = await db.groundingBinding.findUnique({ where: { taskId: task.id } });
    if (!binding) throw new GroundingAccessError("grounding_not_provisioned", 409);
    await requireGroundingCohort(db, task.id, task.projectId);
    const settings = this.settings(task.projectId);
    if (binding.audience !== settings.audience) unavailable();
    const context = await projectGroundingContext(task, binding, resolved.target, resolved.definition, actor, standalone ? this.taskMergeHead : this.head, db);
    return { binding, settings, ...resolved, ...context };
  }

  async issue(taskId: string, actor: Actor, intent: GroundingIntent) {
    return this.issueWithPolicy(taskId, actor, intent, false);
  }
  async issueForRoute(taskId: string, actor: Actor, intent: GroundingIntent) {
    return this.issueWithPolicy(taskId, actor, intent, true);
  }
  private async issueWithPolicy(taskId: string, actor: Actor, intent: GroundingIntent, taskRoute: boolean) {
    if (!groundingIntentSchema.safeParse(intent).success) throw new GroundingAccessError("bad_state", 409);
    return this.transaction(async db => {
      const task = await this.lockAuthorized(db, taskId, actor, intent, taskRoute);
      const context = await this.context(db, task, actor, intent, taskRoute);
      const now = this.time();
      const revision = context.binding.contextRevision + (context.binding.contextDigest !== null && context.binding.contextDigest !== context.digest ? 1 : 0);
      if (revision > 2147483647) unavailable();
      await db.groundingAttempt.updateMany({ where: { taskId, state: "ACTIVE" }, data: { state: "SUPERSEDED" } });
      const attempt = await db.groundingAttempt.create({ data: {
        id: randomUUID(), taskId, contextRevision: revision, contextDigest: context.digest, contextBytes: context.bytes,
        target: context.target, intent, nonce: randomBytes(32).toString("base64url"),
        actorType: actor.type, actorId: actorId(actor), createdAt: new Date(now * 1000), expiresAt: new Date((now + context.settings.seconds) * 1000),
      } });
      const changed = await db.groundingBinding.updateMany({ where: { taskId, activeAttemptId: context.binding.activeAttemptId, contextRevision: context.binding.contextRevision },
        data: { activeAttemptId: attempt.id, contextRevision: revision, contextDigest: context.digest } });
      if (changed.count !== 1) mismatch();
      return {
        audience: context.binding.audience, projectId: task.projectId, taskId, attemptId: attempt.id, nonce: attempt.nonce,
        contextRevision: revision, target: context.target, subject: { kind: "task-context/v1" as const, digest: context.digest },
        policy: { ...GROUNDING_POLICY }, createdAt: now, expiresAt: now + context.settings.seconds,
      };
    });
  }

  async ingest(taskId: string, attemptId: string, actor: Actor, session: GroundingSession, input: Uint8Array | string) {
    return this.ingestWithPolicy(taskId, attemptId, actor, session, input, false);
  }
  async ingestForRoute(taskId: string, attemptId: string, actor: Actor, session: GroundingSession, input: Uint8Array | string) {
    return this.ingestWithPolicy(taskId, attemptId, actor, session, input, true);
  }
  private async ingestWithPolicy(taskId: string, attemptId: string, actor: Actor, session: GroundingSession, input: Uint8Array | string, taskRoute: boolean) {
    if (!uuid.safeParse(attemptId).success || !groundingSessionSchema.safeParse(session).success) invalid();
    const wire = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
    if (wire.length > 32768) invalid();
    // A string transport must not replace malformed UTF-16 with different signed bytes.
    if (typeof input === "string" && wire.toString("utf8") !== input) invalid();
    return this.transaction(async db => {
      const persistedIntent = taskRoute ? await this.receiptIntent(db, taskId, attemptId, actor) : undefined;
      const task = await this.lockAuthorized(db, taskId, actor, persistedIntent, taskRoute);
      const attempt = await db.groundingAttempt.findUnique({ where: { id: attemptId }, include: { receipt: true } });
      if (!attempt || attempt.taskId !== task.id) mismatch();
      if (attempt.actorType !== actor.type || attempt.actorId !== actorId(actor)) throw new GroundingAccessError("forbidden", 403);
      const intent = groundingIntentSchema.safeParse(attempt.intent);
      if (!intent.success) unavailable();
      const context = await this.context(db, task, actor, intent.data, taskRoute);
      if (context.binding.activeAttemptId !== attempt.id || attempt.state !== "ACTIVE") stale();
      if (context.binding.contextRevision !== attempt.contextRevision || context.digest !== attempt.contextDigest || !context.bytes.equals(attempt.contextBytes)) mismatch();
      if (this.time() >= attempt.expiresAt.getTime() / 1000) stale();
      if (attempt.sessionId !== null && (attempt.sessionId !== session.id || attempt.sessionRevision !== session.revision)) mismatch();
      if (!attempt.receipt) {
        const nominated = await db.groundingAttempt.updateMany({ where: { id: attempt.id, taskId, state: "ACTIVE", sessionId: null, sessionRevision: null },
          data: { sessionId: session.id, sessionRevision: session.revision } });
        if (nominated.count !== 1) mismatch();
      }
      const recorded = await db.groundingAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      if (recorded.sessionId === null || recorded.sessionRevision === null) unavailable();
      const evidence = verifyGroundingReceipt(wire, {
        trust: context.settings.trust, now: this.time(), expected: {
          audience: context.binding.audience, projectId: task.projectId,
          taskId: task.id,
          attemptId: attempt.id, nonce: attempt.nonce, contextRevision: attempt.contextRevision,
          target: context.target, subjectDigest: context.digest,
          // Nomination has no authority until the unchanged C01 verifier authenticates this exact tuple.
          session: { id: recorded.sessionId, revision: recorded.sessionRevision }, attemptCreatedAt: attempt.createdAt.getTime() / 1000, attemptExpiresAt: attempt.expiresAt.getTime() / 1000,
        },
      });
      if (attempt.receipt) {
        if (attempt.receipt.id !== evidence.receiptId || !attempt.receipt.wireBytes.equals(wire)) mismatch();
        return { receiptId: attempt.receipt.id, evidence, replayed: true };
      }
      await db.groundingReceipt.create({ data: {
        id: evidence.receiptId, taskId, attemptId: attempt.id, wireBytes: wire,
        wireSha256: createHash("sha256").update(wire).digest("hex"), evidence: { ...evidence }, acceptedAt: new Date(this.time() * 1000),
      } });
      if (this.time() >= Math.min(attempt.expiresAt.getTime() / 1000, evidence.expiresAt)) stale();
      return { receiptId: evidence.receiptId, evidence, replayed: false };
    });
  }
}

export type GroundingChallenge = Awaited<ReturnType<GroundingAttemptsService["issue"]>>;
// Explicit stored target shape for later consumers; no completion behavior is installed here.
export type StoredGroundingAttempt = GroundingAttempt & { target: GroundingTarget };
