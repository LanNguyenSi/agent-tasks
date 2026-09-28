import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { Actor } from "../types/auth.js";
import { cohortSchema } from "./grounding-cohort.js";
import { canonicalGroundingJson, GROUNDING_POLICY, GroundingAccessError, groundingWorkflow, unavailable } from "./grounding-context.js";
import { isTerminalState } from "./default-workflow.js";
import { lockGroundingAuthority } from "./grounding-direct-authority.js";
import { hasProjectRole } from "./team-access.js";
import { assertGithubFenceInstalled } from "./grounding-github-fence.js";
import { groundingTransaction, lockGroundingTask, invalidateGroundingContext } from "./grounding-transaction.js";
import { groundingSettings } from "./grounding-verification.js";
import type { GroundingAttemptsConfig } from "./grounding-attempts.js";
import { getGroundingClient, type GroundingClient } from "./grounding-client.js";
import { evaluateGroundingGate } from "./gates/grounding-gate.js";

const token = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const common = { reason: z.string().min(1).max(2000).refine(value => value.trim().length > 0), expectedRevision: z.number().int().min(0).max(2147483646), key: token };
export const groundingMigrationRequestSchema = z.discriminatedUnion("action", [
  z.object({ ...common, action: z.literal("hold") }).strict(),
  z.object({ ...common, action: z.literal("pin_legacy"), sessionId: token, phase: z.enum(["scope-resolution", "doc-reading", "playbook-loading", "runtime-inspection", "evidence-collection", "claim-evaluation", "complete"]) }).strict(),
  z.object({ ...common, action: z.literal("migrate_external"), subjectMode: z.enum(["TASK_SPEC", "CODE_HEAD"]) }).strict(),
  z.object({ ...common, action: z.literal("resume") }).strict(),
]);
export type GroundingMigrationRequest = z.infer<typeof groundingMigrationRequestSchema>;
function conflict(): never { throw new GroundingAccessError("grounding_operation_conflict", 409); }
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

/** Explicitly injected administration only. No caller-supplied role, trust or policy. */
export class GroundingMigrationService {
  constructor(private readonly deps: { db: PrismaClient; config: GroundingAttemptsConfig; legacyClient?: Pick<GroundingClient, "getLedgerSummary"> }) {}

  async execute(taskId: string, actor: Actor, input: GroundingMigrationRequest) {
    const parsed = groundingMigrationRequestSchema.safeParse(input);
    if (!parsed.success) throw new GroundingAccessError("bad_state", 409);
    const request = parsed.data;
    const fingerprint = createHash("sha256").update(canonicalGroundingJson(request)).digest("hex");
    return groundingTransaction(this.deps.db, async db => {
      // Admission before any Grounding read or lock: the task row, then the
      // lock-free admin predicate, so a caller without it gets one 403 whatever
      // the task's Grounding state. The locked check below repeats it.
      const admitted = z.string().uuid().safeParse(taskId).success ? await db.task.findUnique({ where: { id: taskId }, select: { projectId: true } }) : null;
      if (!admitted) throw new GroundingAccessError("not_found", 404);
      if (actor.type !== "human" || !await hasProjectRole(actor, admitted.projectId, "ADMIN", db)) throw new GroundingAccessError("forbidden", 403);
      const task = await lockGroundingTask(db, taskId);
      await lockGroundingAuthority(db, actor, task.projectId);
      if (actor.type !== "human" || !await hasProjectRole(actor, task.projectId, "ADMIN", db)) throw new GroundingAccessError("forbidden", 403);
      const prior = await db.groundingMigrationCommand.findUnique({ where: { taskId_key: { taskId, key: request.key } } });
      if (prior) {
        if (prior.actorId !== actor.userId || prior.fingerprint !== fingerprint || canonicalGroundingJson(prior.request) !== canonicalGroundingJson(request)) conflict();
        return prior.result;
      }
      await assertGithubFenceInstalled(db);
      const state = await db.groundingMigrationState.findUnique({ where: { taskId } });
      if (state && (state.projectId !== task.projectId || state.revision < 1)) unavailable();
      const revision = state?.revision ?? 0;
      if (request.expectedRevision !== revision) conflict();
      const cohort = await db.groundingCohort.findUnique({ where: { taskId } });
      const binding = await db.groundingBinding.findUnique({ where: { taskId } });
      const before = json({ state, cohort, binding });
      const { def } = await groundingWorkflow(db, task);
      if (task.autoMergeSha !== null || task.status === "abandoned" || isTerminalState(def, task.status) || (!def.states.some(s => s.name === task.status) && task.status !== "backlog")) conflict();
      if (cohort?.reservationId || await db.groundingOperation.findFirst({ where: { taskId, state: { in: ["RESERVED", "DISPATCHED"] } } }) ||
          await db.groundingGithubCreateOperation.findFirst({ where: { taskId, state: { in: ["RESERVED", "DISPATCHED"] } } }) ||
          await db.groundingGithubMergeGroup.findFirst({ where: { state: { in: ["RESERVED", "DISPATCHED"] }, OR: [{ seedTaskId: taskId }, { members: { some: { taskId } } }] } }) ||
          await db.groundingFinalization.findFirst({ where: { taskId, state: { in: ["RESERVED", "DISPATCHED"] } } }) ||
          await db.groundingGithubFenceIntent.findFirst({ where: { taskId, state: "ACTIVE" } })) conflict();
      if (request.action !== "hold" && !state?.held) conflict();
      if (request.action === "hold" && !state?.held) {
        // Advancing the row version prevents an older Serializable snapshot from
        // writing a task after this hold commits, even if it cannot see the overlay.
        await db.$executeRaw`UPDATE tasks SET "updatedAt" = "updatedAt" WHERE id = ${taskId}`;
      }
      if (request.action === "pin_legacy") {
        if (binding || (cohort && cohort.mode !== "LEGACY_LOCAL") || await db.groundingAttempt.findFirst({ where: { taskId } }) || await db.groundingFinalization.findFirst({ where: { taskId } })) conflict();
        const data = { mode: "LEGACY_LOCAL" as const, protected: true, provenance: "admin-migration:v1", legacySessionId: request.sessionId, legacyPhase: request.phase };
        await db.groundingCohort.upsert({ where: { taskId }, create: { taskId, projectId: task.projectId, ...data }, update: data });
      }
      if (request.action === "migrate_external") {
        if (cohort && (cohort.projectId !== task.projectId || !cohortSchema.safeParse(cohort).success)) conflict();
        if ((cohort?.mode === "EXTERNAL_V1") !== Boolean(binding)) conflict();
        const settings = groundingSettings(this.deps.config, task.projectId);
        if (binding) {
          if (binding.projectId !== task.projectId || !binding.protected || binding.audience !== settings.audience || binding.subjectMode !== request.subjectMode || binding.policyId !== GROUNDING_POLICY.id || binding.policyRevision !== GROUNDING_POLICY.revision || binding.policySha256 !== GROUNDING_POLICY.sha256) conflict();
        } else {
          await db.groundingBinding.create({ data: { taskId, projectId: task.projectId, audience: settings.audience, protected: true, subjectMode: request.subjectMode, policyId: GROUNDING_POLICY.id, policyRevision: GROUNDING_POLICY.revision, policySha256: GROUNDING_POLICY.sha256 } });
          const data = { mode: "EXTERNAL_V1" as const, protected: true, provenance: "admin-migration:v1", legacySessionId: null, legacyPhase: null };
          await db.groundingCohort.upsert({ where: { taskId }, create: { taskId, projectId: task.projectId, ...data }, update: data });
        }
      }
      if (request.action === "resume") {
        if (!cohort || cohort.projectId !== task.projectId || !cohort.protected || !cohortSchema.safeParse(cohort).success || (cohort.mode === "EXTERNAL_V1") !== Boolean(binding)) conflict();
        if (cohort.mode === "EXTERNAL_V1") {
          const settings = groundingSettings(this.deps.config, task.projectId);
          if (!binding || binding.projectId !== task.projectId || !binding.protected || binding.audience !== settings.audience || binding.policyId !== GROUNDING_POLICY.id || binding.policyRevision !== GROUNDING_POLICY.revision || binding.policySha256 !== GROUNDING_POLICY.sha256) conflict();
        } else if (cohort.mode === "LEGACY_LOCAL") {
          const summary = await (this.deps.legacyClient ?? getGroundingClient()).getLedgerSummary(cohort.legacySessionId!);
          const gate = evaluateGroundingGate({ metadata: { debugFlavor: true, groundingSessionId: cohort.legacySessionId! }, project: { requireGroundingForDebug: true }, ledgerSummary: summary, currentPhase: cohort.legacyPhase });
          if (!Number.isSafeInteger(summary.entryCount) || summary.entryCount < 1 || !gate.allowed) conflict();
        } else conflict();
      }
      await invalidateGroundingContext(db, taskId);
      const afterState = await db.groundingMigrationState.upsert({ where: { taskId }, create: { taskId, projectId: task.projectId, held: request.action !== "resume", revision: revision + 1 }, update: { held: request.action !== "resume", revision: revision + 1 } });
      const after = json({ state: afterState, cohort: await db.groundingCohort.findUnique({ where: { taskId } }), binding: await db.groundingBinding.findUnique({ where: { taskId } }) });
      const result = { taskId, action: request.action, held: afterState.held, revision: afterState.revision };
      await db.groundingMigrationCommand.create({ data: { taskId, key: request.key, actorId: actor.userId, fingerprint, request: json(request), before, after, result } });
      await db.auditLog.create({ data: { taskId, projectId: task.projectId, actorId: actor.userId, action: "task.grounding.migration", payload: { actorType: "human", reason: request.reason, key: request.key, request: json(request), before, after } } });
      return result;
    });
  }
}
